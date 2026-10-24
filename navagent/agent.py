"""Conversational building guide: Claude talks to the person, navcore supplies every fact.

Run:  uv run --env-file .env python -m navagent data/dev/<building_id>
"""

import json
from collections.abc import Callable
from functools import wraps

import anthropic
from anthropic import beta_tool
from anthropic.lib.tools import ToolError

from navagent.tools import Session
from navcore.engine import EngineError

MODEL = "claude-opus-5-5"
MAX_TOKENS = 16000
MAX_TOOL_ITERATIONS = 25
EFFORT = "medium"
FALLBACK_BETA = "server-side-fallback-2026-07-01"

SYSTEM_PROMPT = """You are the indoor guide for one building, like Google Maps but inside. People ask where \
things are, how to get somewhere, facts about rooms (areas, door widths, what is above or below), and tell \
you about changes (closed lifts, new doors).

How to work:
- Every fact (rooms, things, routes, distances, areas, counts) must come from your tools. Never guess.
- Search before routing. If a search gives several plausible matches and the person's words don't settle \
it, ask one short question listing the options. If one match is clearly meant, go ahead.
- Say in one line what you understood (from where, to where, constraints such as step-free, a load width \
or a closure), then give directions as a short numbered list with room and floor names, and the distance.
- Use step_free=true for wheelchairs, prams, trolleys, beds, crutches or "no stairs". A load of width W \
needs min_width_m=W and step_free=true (lifts are fine).
- "Rooms" in counts means spaces of type room; corridors, stairwells, lifts and outdoor areas don't count.
- When told something is closed or added, apply it with the tools and say what changes for routes.
- If the question asks for a final line like 'Answer: <number>', end with exactly that line, holding \
exactly one number (or the room name and area when asked), with no range and no extra numbers.

Building overview:
{overview}"""


def tool(function: Callable) -> Callable:
    """Engine errors become is_error tool results; results become compact JSON."""

    @wraps(function)
    def wrapper(*args, **kwargs):
        try:
            return json.dumps(function(*args, **kwargs), ensure_ascii=False, separators=(",", ":"))
        except EngineError as error:
            raise ToolError(str(error)) from error

    return beta_tool(wrapper)


def make_tools(session: Session) -> list:
    @tool
    def search_building(query: str, floor: str | None = None) -> dict:
        """Find rooms and things (furniture, machines, equipment) by name, room number or type.

        Args:
            query: Words to look for, e.g. "3d printer", "2.03", "toilet", "cnc mill".
            floor: Only this floor, e.g. "Ground floor", "Floor 2", "Basement 1". Omit for all floors.
        """
        return session.search(query, floor)

    @tool
    def list_rooms(floor: str, room_type: str | None = None) -> dict:
        """All spaces on a floor, largest first, with areas in m² and the total area. Use for 'largest X'
        and 'total area of every X' questions.

        Args:
            floor: e.g. "Ground floor", "Floor 1", "Basement 1".
            room_type: Optional room type, e.g. "office", "generic room", "living room".
        """
        return session.list_rooms(floor, room_type)

    @tool
    def room_details(room: str) -> dict:
        """One room: area, doors with widths, rooms sharing a wall (>= 1 m), rooms directly above and
        below, centroid (x, y, elevation) and the things in it.

        Args:
            room: Space id, or "Name (Floor name)", or the exact room name/number.
        """
        return session.room_details(room)

    @tool
    def find_route(
        start: str,
        destination: str,
        step_free: bool = False,
        min_width_m: float = 0.0,
        via: list[str] | None = None,
        avoid: list[str] | None = None,
    ) -> dict:
        """Shortest walking route in metres with step-by-step directions.

        Args:
            start: Where the person is: space id, "Name (Floor name)" or exact room name/number.
            destination: Where they want to go.
            step_free: True to avoid stairs and steps.
            min_width_m: Every door on the route must be at least this wide (for trolleys, beds, pallets).
            via: Stops to visit in order between start and destination (multi-stop tour).
            avoid: Lifts, stairs, doors or rooms to treat as closed for this route only.
        """
        return session.route(start, destination, step_free, min_width_m, via, avoid)

    @tool
    def nearest_exit(room: str, step_free: bool = False) -> dict:
        """Walk from a room to its nearest entrance, with directions.

        Args:
            room: The room.
            step_free: True to avoid stairs and steps.
        """
        return session.nearest_exit(room, step_free)

    @tool
    def nearest_with_asset(start: str, asset_type: str, step_free: bool = False) -> dict:
        """The room with a given kind of thing that is the shortest walk from start.

        Args:
            start: Where the person is.
            asset_type: e.g. "fire extinguisher", "printer", "cnc mill".
            step_free: True to avoid stairs and steps.
        """
        return session.nearest_with_asset(start, asset_type, step_free)

    @tool
    def reachable_rooms(
        start: str, floor: str, step_free: bool = False, min_width_m: float = 0.0, avoid: list[str] | None = None
    ) -> dict:
        """How many rooms on a floor can be reached from start under constraints.

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
        """3D straight-line distance between two room centroids, at their floors' elevations.

        Args:
            first: First room.
            second: Second room.
        """
        return session.straight_line(first, second)

    @tool
    def what_if_door(first: str, second: str, floor: str) -> dict:
        """Simulate a new door in the middle of the wall two rooms share; count rooms on a floor whose walk
        to the nearest entrance gets shorter by more than 1 m. Doesn't change the building.

        Args:
            first: First room.
            second: Second room (same floor, sharing a wall).
            floor: Floor whose rooms to check.
        """
        return session.what_if_door(first, second, floor)

    @tool
    def set_closed(element: str, closed: bool) -> dict:
        """Close or reopen a lift, staircase, door or room. Affects all later answers in this conversation.

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

    return [
        search_building,
        list_rooms,
        room_details,
        find_route,
        nearest_exit,
        nearest_with_asset,
        reachable_rooms,
        straight_line_distance,
        what_if_door,
        set_closed,
        add_door,
    ]


class BuildingAgent:
    """Keeps the conversation and runs Claude's tool loop for each user turn."""

    def __init__(self, session: Session, client: anthropic.Anthropic | None = None) -> None:
        self.session = session
        self.client = client or anthropic.Anthropic()
        self.tools = make_tools(session)
        overview = json.dumps(session.overview(), ensure_ascii=False, separators=(",", ":"))
        self.system = [
            {"type": "text", "text": SYSTEM_PROMPT.format(overview=overview), "cache_control": {"type": "ephemeral"}}
        ]
        self.messages: list[dict] = []
        self.usage = {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        }

    def ask(self, user_text: str) -> str:
        self.messages.append({"role": "user", "content": user_text})
        runner = self.client.beta.messages.tool_runner(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            max_iterations=MAX_TOOL_ITERATIONS,
            system=self.system,
            tools=self.tools,
            messages=list(self.messages),
            output_config={"effort": EFFORT},
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
        if final is None:
            return "(no response)"
        if final.stop_reason == "refusal":
            return "Sorry, I can't help with that request."
        return "\n".join(block.text for block in final.content if block.type == "text").strip()

    def track_usage(self, message: object) -> None:
        usage = message.usage
        self.usage["input_tokens"] += usage.input_tokens
        self.usage["output_tokens"] += usage.output_tokens
        self.usage["cache_read_input_tokens"] += usage.cache_read_input_tokens or 0
        self.usage["cache_creation_input_tokens"] += usage.cache_creation_input_tokens or 0
