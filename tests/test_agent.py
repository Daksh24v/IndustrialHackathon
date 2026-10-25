"""The agent loop with a scripted fake Claude: modes, tool sets, ask_user, submit_answer, logs."""

import json

import pytest

from benchmark.score import score_reply
from navagent import answer as answer_module
from navagent.agent import BENCHMARK, CHAT, BuildingAgent
from navagent.tools import Session
from navcore.engine import Building
from tests.conftest import DATA
from tests.fake_claude import FakeClient, text_of, tool_names


def test_benchmark_mode_offers_submit_but_never_ask(tiny: Building):
    client = FakeClient([([("submit_answer", {"answer_type": "number", "value": 3})], "Done.")])
    agent = BuildingAgent(Session(tiny), client, mode=BENCHMARK)
    reply = agent.answer_benchmark("How many?")
    names = tool_names(client.requests[0])
    assert "submit_answer" in names and "ask_user" not in names and "add_door" not in names
    assert reply.splitlines()[-1] == "Answer: 3"
    assert client.requests[0]["output_config"] == {"effort": "high"}


def test_chat_mode_offers_ask_but_never_submit(tiny: Building):
    client = FakeClient([([], "Hi.")])
    BuildingAgent(Session(tiny), client, mode=CHAT).ask("hello")
    names = tool_names(client.requests[0])
    assert "ask_user" in names and "submit_answer" not in names
    assert client.requests[0]["output_config"] == {"effort": "medium"}
    assert client.requests[0]["fallbacks"] == "default"


def test_ask_user_with_options_then_answer(tiny: Building):
    options = [{"label": "Ground floor"}, {"label": "Floor 1", "description": "upstairs"}]
    client = FakeClient([
        ([("ask_user", {"question": "Which floor are you on?", "options": options})], ""),
        ([("nearest_with_asset", {"start": "Office 1.01 (Floor 1)", "asset_type": "fire extinguisher"})],
         "Fire extinguisher in Lab 0.02."),
    ])
    agent = BuildingAgent(Session(tiny), client, mode=CHAT)
    agent.ask("Where is the nearest fire extinguisher?")
    assert agent.session.pending_question["question"] == "Which floor are you on?"
    assert [option["label"] for option in agent.session.pending_question["options"]] == ["Ground floor", "Floor 1"]
    assert agent.ask("Floor 1") == "Fire extinguisher in Lab 0.02."
    assert agent.session.pending_question is None  # cleared once answered
    assert client.log[-1][2] is False  # the tool call succeeded
    # the second request carries the whole conversation, including the question and the reply
    assert any(text_of(message["content"]) == "Floor 1" for message in client.requests[1]["messages"])


def test_ask_user_rejects_bad_option_counts(tiny: Building):
    client = FakeClient([([("ask_user", {"question": "?", "options": [{"label": "only one"}]})], "")])
    agent = BuildingAgent(Session(tiny), client, mode=CHAT)
    agent.ask("x")
    assert client.log[0][2] is True and agent.session.pending_question is None


def test_missing_submit_gets_one_reminder(tiny: Building):
    client = FakeClient([
        ([], "I think it's 3."),
        ([("submit_answer", {"answer_type": "number", "value": 3})], "Submitted."),
    ])
    reply = BuildingAgent(Session(tiny), client, mode=BENCHMARK).answer_benchmark("How many?")
    assert len(client.requests) == 2 and reply.endswith("Answer: 3")


def test_room_answer_uses_the_engine_area(tiny: Building):
    client = FakeClient([([("largest_room", {"floor": "Ground floor", "room_type": "office"}),
                           ("submit_answer", {"answer_type": "room", "room": "T-F0-S1", "include_area": True})],
                          "Office 0.01.")])
    reply = BuildingAgent(Session(tiny), client, mode=BENCHMARK).answer_benchmark("Largest office?")
    assert reply.splitlines()[-1] == "Answer: Office 0.01, 16.00 m²"
    expected = {"type": "space", "accept": ["0.01", "Office 0.01"], "reject": [],
                "area": {"type": "number", "value": 16.0, "relative_tolerance": 0.05, "absolute_tolerance": 0}}
    assert score_reply(expected, reply)


def test_tool_errors_reach_the_model_not_the_user(tiny: Building):
    client = FakeClient([([("room_details", {"room": "Office 9.99"}),
                           ("submit_answer", {"answer_type": "number", "value": 1})], "ok")])
    reply = BuildingAgent(Session(tiny), client, mode=BENCHMARK).answer_benchmark("?")
    assert client.log[0][2] is True and "No space called" in client.log[0][3]
    assert reply.endswith("Answer: 1")


def test_log_is_written(tiny: Building, tmp_path):
    log = tmp_path / "q.json"
    client = FakeClient([([("submit_answer", {"answer_type": "number", "value": 2.5})], "ok")])
    BuildingAgent(Session(tiny), client, mode=BENCHMARK, log_path=log).answer_benchmark("?")
    record = json.loads(log.read_text())
    assert record["submitted"] == {"type": "number", "value": 2.5}
    assert record["messages"][0] == {"role": "user", "content": "?"}


@pytest.fixture
def scripted(monkeypatch, tmp_path):
    """Replace the real API client in navagent.answer with a fake one fed from a list."""

    def install(*turns):
        client = FakeClient(list(turns))
        monkeypatch.setattr(answer_module, "client", lambda: client)
        monkeypatch.setattr(answer_module, "LOG_DIRECTORY", tmp_path)
        return client

    return install


def submit(value):
    return ([("submit_answer", {"answer_type": "number", "value": value})], "ok")


def test_double_check_agreement_takes_two_runs(scripted):
    client = scripted(submit(4), submit(4))
    reply = answer_module.answer(DATA / "dev" / "proc-factory-dev-003", "?", double_check=True)
    assert reply.endswith("Answer: 4") and len(client.requests) == 2


def test_double_check_disagreement_takes_a_third_vote(scripted):
    client = scripted(submit(4), submit(5), submit(5))
    reply = answer_module.answer(DATA / "dev" / "proc-factory-dev-003", "?", double_check=True)
    assert reply.endswith("Answer: 5") and len(client.requests) == 3


def test_text_written_before_a_question_reaches_the_person(tiny: Building):
    from types import SimpleNamespace

    from tests.fake_claude import FakeRunner

    class TalkingRunner(FakeRunner):
        def __iter__(self):
            first = True
            for message in super().__iter__():
                if first:  # the model writes a sentence next to its first tool call
                    message.content = [SimpleNamespace(type="text", text="I read 2 floors."), *message.content]
                    first = False
                yield message

    client = FakeClient([([("ask_user", {"question": "Which floor?", "options": [{"label": "A"}, {"label": "B"}]})],
                          "")])
    client.beta.messages.tool_runner = lambda **request: client.requests.append(request) or TalkingRunner(
        request["tools"], client.script.pop(0), client.log)
    agent = BuildingAgent(Session(tiny), client, mode=CHAT)
    assert agent.ask("set it up") == "I read 2 floors."
    assert agent.session.pending_question["question"] == "Which floor?"


def test_chat_rules_ask_for_what_was_understood_and_followable_directions():
    """Interaction is judged on "shows what it understood" and "directions people can follow": the chat prompt
    asks for both; the benchmark prompt stays as it was."""
    from navagent.agent import BENCHMARK_RULES, CHAT_RULES

    text = " ".join(CHAT_RULES.split())
    assert "say what you understood" in text
    assert "two or three short sentences of turns and things they will see" in text
    assert "don't write step-by-step lists" not in text
    assert "two short sentences" in text  # spoken turns
    assert "turns and things" not in " ".join(BENCHMARK_RULES.split())
