"""Building guide: Claude reads and understands every request, navcore supplies every fact and number.

Two modes:
- "chat": a person talks to it (terminal or app). It can ask back with options (ask_user).
- "benchmark": scored questions, nobody to ask. It must end with submit_answer; the 'Answer:' line is
  written by code from that, so its format never depends on the model's prose.

Run a chat:  uv run --env-file .env python -m navagent data/dev/<building_id>
"""

import json
import time
from collections.abc import Callable
from functools import wraps
from pathlib import Path

import anthropic
from anthropic import beta_tool
from anthropic.lib.tools import ToolError

from navagent.tools import Session
from navcore.engine import EngineError

MODEL = "claude-opus-5-5"
MAX_TOKENS = 16000
MAX_TOOL_ITERATIONS = 30
EFFORT = {"chat": "medium", "benchmark": "high"}
FALLBACK_BETA = "server-side-fallback-2026-07-01"
CHAT = "chat"
BENCHMARK = "benchmark"

COMMON_RULES = """You are the indoor guide for one building, like Google Maps but inside.

Every fact and number (rooms, things, areas, distances, counts, routes) must come from your tools; never \
estimate or do geometry yourself. Prefer the tool that answers the whole question in one call \
(largest_room, list_rooms totals, errand_walk, reachable_rooms, wall_neighbours, stacked_room, \
straight_line_distance, what_if_door) over adding numbers up yourself.

Reading requests:
- Names usually come as "Name (Floor name)"; pass them to tools exactly like that.
- Room types and item types are words like "generic room", "living room", "fire extinguisher".
- Step-free: wheelchairs, prams, trolleys, beds, pallets, "no stairs", "can't carry it on the stairs". \
A load W metres wide needs step_free=true and min_width_m=W (lifts are fine).
- "Rooms" in counts are spaces of type room; corridors, stairwells, lifts and outdoor areas don't count.
- Something "out of service" or "closed" goes into `avoid` (or set_closed in a conversation).
- If a tool says a name matches several spaces, it lists their ids: choose by the floor and details \
given, then pass the id."""

CHAT_RULES = """
Talking to a person:
- Ask only what changes the answer, one question at a time, with ask_user and 2-4 real options taken \
from your tools (floors, rooms, things that exist). Examples: which floor they're on when the building \
has several and "nearest" depends on it; where they are on that floor; which of several same-named rooms.
- After ask_user, end your turn with no further text; the reply comes as the next message.
- Remember what they told you (floor, position, step-free, closures) for the rest of the conversation.
- Keep replies short: what you found, where, and how far (e.g. "Coffee machine in Kitchen 2.04, 40 m"). \
The app draws the route on the map, so don't write step-by-step lists unless asked.
- When told something is closed or a door is added, apply it with the tools and say what changes."""

BENCHMARK_RULES = """
Answering a scored question:
- Nobody can answer questions back, so never ask. Choose the most plausible reading and say which.
- Finish by calling submit_answer exactly once, then stop:
  - answer_type "number": the single number the question asks for, copied from a tool result \
(a count, a distance in metres, an area in m²);
  - answer_type "room": the room's space id (include_area=true when it also asks how big the room is);
  - answer_type "text": only when the question asks for neither, e.g. "no step-free route exists".
- When the question gives no answer format: for "where is X" submit the room that holds it; for \
"how many X" the count; for a route ("how do I get from A to B", tours, with closures or step-free) write \
the rooms of the route in order in your reply and submit the total length in metres; if no route exists, \
submit text saying so."""

PROMPT = "{rules}\n\nBuilding overview:\n{overview}"


def tool(function: Callable) -> Callable:
    """Engine errors become is_error tool results; results become compact JSON."""

    @wraps(function)
    def wrapper(*args, **kwargs):
        try:
            return json.dumps(function(*args, **kwargs), ensure_ascii=False, separators=(",", ":"))
        except EngineError as error:
            raise ToolError(str(error)) from error

    return beta_tool(wrapper)


def make_tools(session: Session, mode: str = CHAT) -> list:
    @tool
    def search_building(query: str, floor: str | None = None) -> dict:
        """Find rooms and things (furniture, machines, equipment) by name, room number or type.

        Args:
            query: Words to look for, e.g. "3d printer", "2.03", "toilet", "cnc mill".
            floor: Only this floor, e.g. "Ground floor", "Floor 2", "Basement 1". Omit for all floors.
        """
        return session.search(query, floor)

    @tool
    def count_assets(asset_type: str, floor: str | None = None) -> dict:
        """Exactly how many things of one type there are, optionally on one floor, and in which rooms.

        Args:
            asset_type: e.g. "chair", "toilet", "fire extinguisher", "cnc mill".
            floor: Only this floor, e.g. "Floor 2". Omit for the whole building.
        """
        return session.count_assets(asset_type, floor)

    @tool
    def largest_room(floor: str, room_type: str) -> dict:
        """The largest room of one type on a floor, with its area in m² and the runner-up.

        Args:
            floor: e.g. "Ground floor", "Floor 1", "Basement 1".
            room_type: e.g. "office", "generic room", "living room", "bathroom".
        """
        return session.largest_room(floor, room_type)

    @tool
    def list_rooms(floor: str, room_type: str | None = None) -> dict:
        """All spaces on a floor (optionally of one room type), largest first, with each area and the total
        area in m². Use total_area_m2 for 'total floor area of every X' questions.

        Args:
            floor: e.g. "Ground floor", "Floor 1", "Basement 1".
            room_type: Optional room type, e.g. "office", "generic room".
        """
        return session.list_rooms(floor, room_type)

    @tool
    def room_details(room: str) -> dict:
        """One room: area, doors with widths, rooms sharing a wall, rooms directly above and below,
        centroid (x, y, elevation) and the things in it.

        Args:
            room: Space id, or "Name (Floor name)", or the exact room name/number.
        """
        return session.room_details(room)

    @tool
    def stacked_room(room: str, direction: str) -> dict:
        """The room directly above or below: the space on the next floor whose outline covers most of this one.

        Args:
            room: The room, e.g. "Office 0.29 (Ground floor)".
            direction: "above" or "below".
        """
        return session.stacked_room(room, direction)

    @tool
    def wall_neighbours(room: str) -> dict:
        """How many other rooms on the same floor share a wall with this room: their wall runs along it for
        at least 1 m (within 0.35 m, walls have thickness), with or without a door. Corridors, stairwells,
        lifts and outdoor areas are not counted.

        Args:
            room: The room.
        """
        return session.wall_neighbours(room)

    @tool
    def find_route(
        start: str,
        destination: str,
        step_free: bool = False,
        min_width_m: float = 0.0,
        via: list[str] | None = None,
        avoid: list[str] | None = None,
    ) -> dict:
        """Shortest walking route in metres (the official route model), with the rooms it passes.

        Args:
            start: Where the person is: space id, "Name (Floor name)" or exact room name/number.
            destination: Where they want to go.
            step_free: True to avoid stairs and steps.
            min_width_m: Every door on the route must be at least this wide.
            via: Stops to visit in order between start and destination (multi-stop tour).
            avoid: Lifts, stairs, doors or rooms to treat as closed for this route only.
        """
        return session.route(start, destination, step_free, min_width_m, via, avoid)

    @tool
    def errand_walk(start: str, asset_type: str, destination: str, step_free: bool = False) -> dict:
        """Total walk for an errand: from start to the nearest room (by walking distance) that holds a kind
        of thing, pick it up, then on to the destination.

        Args:
            start: Where the person is.
            asset_type: The kind of thing, e.g. "fire extinguisher", "stove", "desk".
            destination: Where it has to go (find it first, e.g. with largest_room).
            step_free: True when it can't be carried on stairs.
        """
        return session.errand_walk(start, asset_type, destination, step_free)

    @tool
    def nearest_with_asset(start: str, asset_type: str, step_free: bool = False) -> dict:
        """The room holding a kind of thing that is the shortest walk from start.

        Args:
            start: Where the person is.
            asset_type: e.g. "coffee machine", "printer", "cnc mill".
            step_free: True to avoid stairs and steps.
        """
        return session.nearest_with_asset(start, asset_type, step_free)

    @tool
    def nearest_exit(room: str, step_free: bool = False) -> dict:
        """Walk from a room to its nearest entrance.

        Args:
            room: The room.
            step_free: True to avoid stairs and steps.
        """
        return session.nearest_exit(room, step_free)

    @tool
    def reachable_rooms(
        start: str, floor: str, step_free: bool = False, min_width_m: float = 0.0, avoid: list[str] | None = None
    ) -> dict:
        """How many rooms on a floor can be reached from start under constraints (e.g. a wheelchair with a
        lift out of service, or a 1.1 m wide trolley).

        Args:
            start: Where the person or load comes in.
            floor: The floor to count rooms on.
            step_free: True for wheelchairs and wheeled loads.
            min_width_m: Minimum door width for a wide load.
            avoid: Lifts, stairs, doors or rooms out of service.
        """
        return session.reachable_rooms(start, floor, step_free, min_width_m, avoid)

    @tool
    def straight_line_distance(first: str, second: str) -> dict:
        """3D straight-line distance between two room centres (floor-plan centroid at the floor's elevation).

        Args:
            first: First room.
            second: Second room.
        """
        return session.straight_line(first, second)

    @tool
    def what_if_door(first: str, second: str, floor: str) -> dict:
        """Simulate a new door in the middle of the wall two rooms share and count the rooms on a floor whose
        walk to the nearest entrance gets shorter by more than 1 m. Doesn't change the building.

        Args:
            first: First room.
            second: Second room (same floor, sharing a wall).
            floor: The floor whose rooms to check.
        """
        return session.what_if_door(first, second, floor)

    tools = [
        search_building,
        count_assets,
        largest_room,
        list_rooms,
        room_details,
        stacked_room,
        wall_neighbours,
        find_route,
        errand_walk,
        nearest_with_asset,
        nearest_exit,
        reachable_rooms,
        straight_line_distance,
        what_if_door,
    ]

    if mode == CHAT:

        @tool
        def set_closed(element: str, closed: bool) -> dict:
            """Close or reopen a lift, staircase, door or room for the rest of this conversation.

            Args:
                element: Name or id, e.g. "Lift 1", "Stairs 2", a door id, a room.
                closed: True to close, False to reopen.
            """
            return session.set_closed(element, closed)

        @tool
        def add_door(first: str, second: str, width_m: float = 0.9, step_free: bool = True) -> dict:
            """Add a door in the middle of the wall two neighbouring rooms share (edits the building).

            Args:
                first: First room.
                second: Second room.
                width_m: Door width in metres.
                step_free: Whether the door has no step.
            """
            return session.add_door(first, second, width_m, step_free)

        @tool
        def ask_user(question: str, options: list[dict]) -> dict:
            """Ask the person one short question with 2-4 tappable options (they can also type their own
            answer). Use only when the answer changes what you do. End your turn right after.

            Args:
                question: The question, e.g. "Which floor are you on?".
                options: 2-4 objects {"label": "Floor 2", "description": "optional detail"}, taken from
                    real floors, rooms or things in this building.
            """
            return session.ask_user(question, options)

        tools += [set_closed, add_door, ask_user]
    else:

        @tool
        def submit_answer(
            answer_type: str,
            value: float | None = None,
            room: str | None = None,
            include_area: bool = False,
            text: str | None = None,
        ) -> dict:
            """Submit the final answer, exactly once, as the last step.

            Args:
                answer_type: "number" for a count, distance or area; "room" when the answer is a room;
                    "text" only when the answer is neither (e.g. no route exists).
                value: The number (for answer_type "number"), copied from a tool result.
                room: The room's space id (for answer_type "room").
                include_area: True when the question also asks how big the room is in m².
                text: The short answer (for answer_type "text").
            """
            return session.submit_answer(answer_type, value, room, include_area, text)

        tools.append(submit_answer)
    return tools


class BuildingAgent:
    """Keeps the conversation and runs Claude's tool loop for each user turn."""

    def __init__(
        self,
        session: Session,
        client: anthropic.Anthropic | None = None,
        mode: str = CHAT,
        log_path: Path | None = None,
    ) -> None:
        self.session = session
        self.mode = mode
        self.client = client or anthropic.Anthropic()
        self.tools = make_tools(session, mode)
        self.log_path = log_path
        overview = json.dumps(session.overview(), ensure_ascii=False, separators=(",", ":"))
        rules = COMMON_RULES + (CHAT_RULES if mode == CHAT else BENCHMARK_RULES)
        self.system = [
            {
                "type": "text",
                "text": PROMPT.format(rules=rules, overview=overview),
                "cache_control": {"type": "ephemeral"},
            }
        ]
        self.messages: list[dict] = []
        self.usage = {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        }

    def ask(self, user_text: str) -> str:
        """One user turn. Returns the agent's text; see session.pending_question / session.submitted."""
        self.session.pending_question = None
        self.messages.append({"role": "user", "content": user_text})
        runner = self.client.beta.messages.tool_runner(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            max_iterations=MAX_TOOL_ITERATIONS,
            system=self.system,
            tools=self.tools,
            messages=list(self.messages),
            output_config={"effort": EFFORT[self.mode]},
            betas=[FALLBACK_BETA],
            fallbacks="default",
        )
        final = None
        for message in runner:
            final = message
            self.track_usage(message)
            self.messages.append({"role": "assistant", "content": message.content})
            tool_response = runner.generate_tool_call_response()
            if tool_response is not None:
                self.messages.append(tool_response)
        self.write_log()
        if final is None:
            return "(no response)"
        if final.stop_reason == "refusal":
            return "Sorry, I can't help with that request."
        return "\n".join(block.text for block in final.content if block.type == "text").strip()

    def answer_benchmark(self, question: str) -> str:
        """Full reply for a scored question, ending with the code-written 'Answer:' line."""
        text = self.ask(question)
        if self.session.submitted is None:
            text += "\n" + self.ask("You didn't call submit_answer. Call it now with your final answer.")
        line = self.session.answer_line()
        return f"{text}\n{line}" if line else text

    def track_usage(self, message: object) -> None:
        usage = message.usage
        self.usage["input_tokens"] += usage.input_tokens
        self.usage["output_tokens"] += usage.output_tokens
        self.usage["cache_read_input_tokens"] += usage.cache_read_input_tokens or 0
        self.usage["cache_creation_input_tokens"] += usage.cache_creation_input_tokens or 0

    def write_log(self) -> None:
        """Every turn, tool call and tool result, for debugging wrong answers."""
        if self.log_path is None:
            return
        self.log_path.parent.mkdir(parents=True, exist_ok=True)

        def plain(content):
            if isinstance(content, str):
                return content
            return [block.model_dump() if hasattr(block, "model_dump") else block for block in content]

        record = {
            "time": time.time(),
            "usage": self.usage,
            "messages": [{"role": m["role"], "content": plain(m["content"])} for m in self.messages],
            "submitted": self.session.submitted,
        }
        self.log_path.write_text(json.dumps(record, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
