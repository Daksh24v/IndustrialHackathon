"""A scripted stand-in for the Claude API, so the agent loop is tested for free.

FakeClient(script): each turn in the script is a list of tool calls [(tool_name, input), ...] followed by
final text. The fake runner really calls the agent's tools, like the SDK's tool runner does."""

import json
from types import SimpleNamespace

from anthropic.lib.tools import ToolError


def usage():
    return SimpleNamespace(input_tokens=10, output_tokens=5, cache_read_input_tokens=0,
                           cache_creation_input_tokens=0)


class FakeRunner:
    def __init__(self, tools, turn, log):
        self.tools = {tool.name: tool for tool in tools}
        self.calls, self.final_text = turn
        self.log = log
        self.pending = None

    def __iter__(self):
        for name, arguments in self.calls:
            block = SimpleNamespace(type="tool_use", name=name, input=arguments, id=f"call-{len(self.log)}")
            try:
                result, error = self.tools[name].call(arguments), False
            except ToolError as failure:
                result, error = str(failure), True
            self.log.append((name, arguments, error, result))
            self.pending = {"role": "user", "content": [{"type": "tool_result", "tool_use_id": block.id,
                                                         "content": result, "is_error": error}]}
            yield SimpleNamespace(content=[block], stop_reason="tool_use", usage=usage())
        self.pending = None
        yield SimpleNamespace(content=[SimpleNamespace(type="text", text=self.final_text)],
                              stop_reason="end_turn", usage=usage())

    def generate_tool_call_response(self):
        pending, self.pending = self.pending, None
        return pending


class FakeClient:
    def __init__(self, script):
        self.script = list(script)
        self.requests = []
        self.log = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(tool_runner=self.tool_runner))

    def tool_runner(self, **request):
        self.requests.append(request)
        return FakeRunner(request["tools"], self.script.pop(0), self.log)


def tool_names(request) -> set[str]:
    return {tool.name for tool in request["tools"]}


def loads(result: str) -> dict:
    return json.loads(result)
