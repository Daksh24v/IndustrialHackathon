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
from navcore.resolve import AmbiguousSpace

MODEL = "claude-opus-5-5"
MAX_TOKENS = 16000
MAX_TOOL_ITERATIONS = 30
EFFORT = {"chat": "medium", "benchmark": "high", "builder": "medium"}
FALLBACK_BETA = "server-side-fallback-2026-07-01"
CHAT = "chat"
BENCHMARK = "benchmark"
BUILDER = "builder"
MAX_READINGS = 10  # a name shared by more spaces than this is reported, not expanded
POSITION_PREFIX = "[Position: the person is in "
SPOKEN_NOTE = "\n\n[Spoken turn: the answer is read out.]"
SPOKEN_EFFORT = "low"  # the agent is most of a spoken turn's wait

COMMON_RULES = """You are the indoor guide for one building, like Google Maps but inside.

Every fact and number (rooms, things, areas, distances, counts, routes) must come from your tools; never \
estimate or do geometry yourself. Prefer the tool that answers the whole question in one call \
(largest_room, list_rooms totals, errand_walk, reachable_rooms, wall_neighbours, stacked_room, \
straight_line_distance, what_if_door) over adding numbers up yourself. For anything else, combine the \
general tools (query_spaces, list_doors, find_assets, find_route, room_details): any question about this \
building that its data can answer should be answered.

Follow the question's own definitions. The tools' defaults are the usual ones (a shared wall is at least \
1 m within 0.35 m; "rooms" are spaces of type room; a what-if door must shorten a walk by more than 1 m), \
but when a question sets a different value or says which spaces count, pass it as a parameter \
(min_length_m, tolerance_m, threshold_m, count_types, min_width_m, step_free, avoid).

Reading requests:
- Names usually come as "Name (Floor name)"; pass them to tools exactly like that.
- Room types and item types are words like "generic room", "living room", "fire extinguisher".
- Step-free: wheelchairs, prams, trolleys, beds, pallets, "no stairs", "can't carry it on the stairs". \
A load W metres wide needs step_free=true and min_width_m=W (lifts are fine).
- Unless the question says otherwise, "rooms" in counts are spaces of type room; corridors, stairwells, \
lifts and outdoor areas don't count.
- Something "out of service" or "closed" goes into `avoid` (or set_closed in a conversation).
- Same-named rooms: if a name matches several spaces on that floor, the tool answers for each of them \
("readings"). If the question's details (floor, area, neighbours, contents) single one out, use that one."""

CHAT_RULES = """
Talking to a person:
- Ask only what changes the answer, one question at a time, with ask_user and 2-4 real options taken \
from your tools (rooms, things, floors that exist). Examples: where they are when "nearest" depends on it \
(see below: one question, by landmarks); which of several same-named rooms.
- After ask_user, end your turn with no further text; the reply comes as the next message.
- Where the person is: a message starting with "[Position: ...]" says where they are now, where they were \
and how far along your route they are. Use it as the start (omit start in the route tools) and don't ask \
where they are. When they say where they are ("I'm at the lift", "next to the press"), call \
set_my_position; if they left the route, find a new one from there; "take me back" means the place before.
- Only when their position is unknown and the answer depends on it: if they just came in, start at the \
entrance; otherwise call where_am_i_options first (before asking anything) and ask once, "What can you \
see near you?", with 2-4 of its landmarks as options (things and signs they can see, with their floor when \
it gave several floors; not room ids). Ask the floor on its own only when it says ask_first. Never ask \
again what you were told.
- A name that doesn't match exactly: if a tool took a close name ("Quality lab" for "Quality lab 0.21"), say \
which room you used; if it says "Did you mean", ask with those as options; if nothing is called that \
("room 9.99"), say so plainly and offer real rooms nearby.
- Remember what they told you (floor, position, step-free, closures) for the rest of the conversation.
- A message ending with "[Spoken turn: ...]" was said out loud and your answer is read out: answer in two \
short sentences, no lists, markdown or offers: where it is and how far, then the first turn with a thing \
they will see ("Out of the lab, turn right at the conveyor"); the map shows the rest. Asking back with \
ask_user works as usual (the options are read out).
- If a tool returns several readings for a same-named room and they give different answers, ask which \
room they mean, with the readings as options (e.g. "Büro 0.11, 26 m²").
- When you say the way, use the turns and things from the route's steps ("turn left into the corridor, the \
kitchen is on the left after 30 m, by the coffee machine"), not room numbers alone: people see turns and \
machines, not ids.
- Everything you write is shown to the person (and may be read out): speak to them as "you", write no notes \
to yourself before tool calls, and use plain text: no markdown (no **bold**, headings or bullet lists).
- Keep replies short: what you found, where, and how far (e.g. "Coffee machine in Kitchen 2.04, 40 m"). \
Show it with show_on_map (their position, the target, the route from find_route). For a route, also say what \
you understood in a few words (from where, step-free, what is closed, which entrance) and give the way in \
two or three short sentences of turns and things they will see, from the route's steps, not a numbered \
list; people may not look at the map.
- When told something is closed, a door is added or a thing was moved, apply it with the tools (set_closed, add_door, move_thing; the map shows it at once) and say what changes for them."""

BENCHMARK_RULES = """
Answering a scored question:
- Nobody can answer questions back, so never ask. Choose the most plausible reading and say which.
- If a tool returns several readings for a same-named room and nothing in the question singles one out, \
answer with the result most readings agree on (on a tie, the first reading), and say so.
- Finish by calling submit_answer exactly once, then stop:
  - answer_type "number": the single number the question asks for, copied from a tool result \
(a count, a distance in metres, an area in m²);
  - answer_type "room": the room's space id (include_area=true when it also asks how big the room is);
  - answer_type "text": only when the question asks for neither, e.g. "no step-free route exists".
- When the question gives no answer format: for "where is X" submit the room that holds it; for \
"how many X" the count; for a route ("how do I get from A to B", tours, with closures or step-free) write \
the rooms of the route in order in your reply and submit the total length in metres (code adds the route \
itself on a 'Route:' line); if no route exists, submit answer_type "text" with exactly "No route exists."."""

BUILDER_RULES = """
Setting up a new building from its floor plans (a draft, not saved yet):
- Start with plan_summary and tell the person in a few lines what you understood: floors, how many rooms, \
corridors, stairs and lifts, doors and entrances, overall size. Then work through the open points.
- The plans don't say what each room is, how wide the doors are or how high the floors are, and some plans \
don't mark stairs. Ask about these with ask_user, one question at a time, with 2-4 concrete options built \
from the draft (e.g. "Rooms 0.20-0.33 along the corridor: offices / labs / meeting rooms?", "Floor height: \
3.5 m / 4 m / 8 m?", "Which space is the staircase: Corridor 1.01 (3.2 m²) / ...?"). For stairs, \
stair_candidates suggests likely spaces.
- Apply every answer with the edit tools, then say briefly what changed. Show a floor on the map when it \
helps the person check (show_on_map with floor).
- Only call save_building when the person says it's right. Never invent rooms, doors or numbers."""

PROMPT = "{rules}\n\nBuilding overview:\n{overview}"


def tool(function: Callable) -> Callable:
    """Engine errors become is_error tool results; results become compact JSON."""

    @wraps(function)
    def wrapper(*args, **kwargs):
        try:
            return json.dumps(with_readings(function, kwargs), ensure_ascii=False, separators=(",", ":"))
        except EngineError as error:
            raise ToolError(str(error)) from error

    return beta_tool(wrapper)


def with_readings(function: Callable, kwargs: dict, depth: int = 0) -> dict:
    """Call the tool; if a name matches several spaces, call it once per space instead and return every
    reading, so the model can see whether the duplicates change the answer (works for any tool)."""
    try:
        return function(**kwargs)
    except AmbiguousSpace as error:
        keys = [key for key, value in kwargs.items() if value == error.words or (
            isinstance(value, list) and error.words in value)]
        if not keys or depth >= 2 or len(error.candidates) > MAX_READINGS:
            raise
        readings = []
        for space_id in error.candidates:
            substituted = {
                key: ([space_id if item == error.words else item for item in value] if isinstance(value, list)
                      else space_id) if key in keys else value
                for key, value in kwargs.items()
            }
            try:
                readings.append({"space_id": space_id, "result": with_readings(function, substituted, depth + 1)})
            except EngineError as failure:
                readings.append({"space_id": space_id, "error": str(failure)})
        answers = [json.dumps(reading.get("result", reading.get("error")), sort_keys=True) for reading in readings]
        return {
            "ambiguous_name": error.words,
            "note": f"'{error.words}' matches {len(readings)} spaces; the tool was run once for each.",
            "all_readings_agree": len(set(answers)) == 1,
            "readings": readings,
        }


def cached(messages: list[dict]) -> list[dict]:
    """The conversation with a cache mark on its newest user message, so every later step and turn reads the
    history from the prompt cache instead of paying for it again (the system prompt has the other mark)."""
    marked = list(messages)
    for index in range(len(marked) - 1, -1, -1):
        message = marked[index]
        if message["role"] == "user" and isinstance(message["content"], str):
            marked[index] = {"role": "user", "content": [
                {"type": "text", "text": message["content"], "cache_control": {"type": "ephemeral"}}]}
            break
    return marked


def position_note(session: Session) -> str | None:
    """'[Position: the person is in X (id ...), from the phone. Before: ... Following a route to ...]', or None.
    The id is there because a label can be shared (OSM has nine 'Büro (Floor 1)')."""
    position = session.position
    if position is None:
        return None
    how = {"phone": "from the phone", "told": "as they said"}.get(position.source, position.source)
    parts = [f"{POSITION_PREFIX}{position.label} (id {position.space_id}), {how}."]
    if session.history:
        parts.append("Before: " + ", ".join(item.label for item in reversed(session.history[-3:])) + ".")
    progress = session.route_progress()
    if progress.get("arrived"):
        parts.append(f"They have arrived at {progress['route_to']}.")
    elif progress.get("on_route"):
        parts.append(f"Following your route to {progress['route_to']}: next {progress['next']}, "
                     f"{progress['spaces_left']} spaces left.")
    elif progress:
        parts.append(f"They left the route to {progress['route_to']}.")
    return " ".join(parts) + "]"


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
    def wall_neighbours(
        room: str, min_length_m: float = 1.0, tolerance_m: float = 0.35, count_types: list[str] | None = None
    ) -> dict:
        """How many other spaces on the same floor share a wall with this room: their wall runs along it for
        at least min_length_m, within tolerance_m (walls have thickness), with or without a door. By default
        rooms and halls count; corridors, stairwells, lifts and outdoor areas don't.

        Args:
            room: The room.
            min_length_m: Minimum shared wall length (default 1 m); use the question's value if it gives one.
            tolerance_m: How close the outlines must run (default 0.35 m).
            count_types: Which space types count, from room, hall, corridor, stair, lift, outdoor.
                Omit for the default (room, hall).
        """
        return session.wall_neighbours(room, min_length_m, tolerance_m, count_types)

    @tool
    def find_route(
        destination: str,
        start: str | None = None,
        step_free: bool = False,
        min_width_m: float = 0.0,
        via: list[str] | None = None,
        avoid: list[str] | None = None,
    ) -> dict:
        """Shortest walking route in metres (the official route model), with the rooms it passes.

        Args:
            destination: Where they want to go.
            start: Where they start: space id, "Name (Floor name)" or room name/number. Omit to start
                where the person is known to be (their position).
            step_free: True to avoid stairs and steps.
            min_width_m: Every door on the route must be at least this wide.
            via: Stops to visit in order between start and destination (multi-stop tour).
            avoid: Lifts, stairs, doors or rooms to treat as closed for this route only.
        """
        return session.route(start, destination, step_free, min_width_m, via, avoid)

    @tool
    def errand_walk(asset_type: str, destination: str, start: str | None = None, step_free: bool = False) -> dict:
        """Total walk for an errand: from start to the nearest room (by walking distance) that holds a kind
        of thing, pick it up, then on to the destination.

        Args:
            asset_type: The kind of thing, e.g. "fire extinguisher", "stove", "desk".
            destination: Where it has to go (find it first, e.g. with largest_room).
            start: Where they start; omit for where the person is known to be.
            step_free: True when it can't be carried on stairs.
        """
        return session.errand_walk(start, asset_type, destination, step_free)

    @tool
    def nearest_with_asset(asset_type: str, start: str | None = None, step_free: bool = False) -> dict:
        """The room holding a kind of thing that is the shortest walk from start.

        Args:
            asset_type: e.g. "coffee machine", "printer", "cnc mill".
            start: Where they start; omit for where the person is known to be.
            step_free: True to avoid stairs and steps.
        """
        return session.nearest_with_asset(start, asset_type, step_free)

    @tool
    def nearest_exit(room: str | None = None, step_free: bool = False) -> dict:
        """Walk from a room to its nearest entrance.

        Args:
            room: The room; omit for where the person is known to be.
            step_free: True to avoid stairs and steps.
        """
        return session.nearest_exit(room, step_free)

    @tool
    def reachable_rooms(
        start: str,
        floor: str,
        step_free: bool = False,
        min_width_m: float = 0.0,
        avoid: list[str] | None = None,
        count_types: list[str] | None = None,
    ) -> dict:
        """How many rooms on a floor can be reached from start under constraints (e.g. a wheelchair with a
        lift out of service, or a 1.1 m wide trolley).

        Args:
            start: Where the person or load comes in.
            floor: The floor to count rooms on.
            step_free: True for wheelchairs and wheeled loads.
            min_width_m: Minimum door width for a wide load.
            avoid: Lifts, stairs, doors or rooms out of service.
            count_types: Which space types count, from room, hall, corridor, stair, lift, outdoor.
                Omit for the default (only room).
        """
        return session.reachable_rooms(start, floor, step_free, min_width_m, avoid, count_types)

    @tool
    def straight_line_distance(first: str, second: str) -> dict:
        """3D straight-line distance between two room centres (floor-plan centroid at the floor's elevation).

        Args:
            first: First room.
            second: Second room.
        """
        return session.straight_line(first, second)

    @tool
    def what_if_door(
        first: str,
        second: str,
        floor: str,
        threshold_m: float = 1.0,
        count_types: list[str] | None = None,
        step_free: bool = False,
    ) -> dict:
        """Simulate a new door in the middle of the wall two spaces share and count the rooms on a floor whose
        walk to the nearest entrance gets shorter by more than threshold_m. Doesn't change the building.

        Args:
            first: First space.
            second: Second space (same floor, sharing a wall).
            floor: The floor whose rooms to check.
            threshold_m: How much shorter a walk must get (default: more than 1 m).
            count_types: Which space types count; omit for the default (only room).
            step_free: True to measure step-free walks.
        """
        return session.what_if_door(first, second, floor, threshold_m, count_types, step_free)

    @tool
    def query_spaces(
        floor: str | None = None,
        space_type: str | None = None,
        room_type: str | None = None,
        name_contains: str | None = None,
        min_area_m2: float | None = None,
        max_area_m2: float | None = None,
        sort_by: str = "area_desc",
        distance_from: str | None = None,
        step_free: bool = False,
        limit: int = 25,
    ) -> dict:
        """General search over spaces with filters: count, total/min/max/mean area and the matching spaces.
        Use it for smallest/largest/how many/average questions, or sorted by walking distance for
        nearest/farthest questions.

        Args:
            floor: Only this floor.
            space_type: One of room, hall, corridor, stair, lift, outdoor.
            room_type: e.g. "office", "toilet", "generic room".
            name_contains: Words the name or room number must contain.
            min_area_m2: Only spaces at least this big.
            max_area_m2: Only spaces at most this big.
            sort_by: "area_desc", "area_asc", "name" or "distance" (needs distance_from).
            distance_from: A space to measure walking distances from.
            step_free: Measure step-free walking distances.
            limit: How many spaces to list (the statistics always cover all matches).
        """
        return session.query_spaces(
            floor, space_type, room_type, name_contains, min_area_m2, max_area_m2, sort_by, distance_from,
            step_free, limit,
        )

    @tool
    def list_doors(
        room: str | None = None,
        floor: str | None = None,
        max_width_m: float | None = None,
        min_width_m: float | None = None,
        kind: str | None = None,
        step_free: bool | None = None,
    ) -> dict:
        """Doors, openings and entrances of one room or one floor, filtered by width, kind and steps, with
        the count and the narrowest and widest.

        Args:
            room: Only doors of this room.
            floor: Only doors on this floor.
            max_width_m: Only doors at most this wide.
            min_width_m: Only doors at least this wide.
            kind: "door", "opening" or "entrance".
            step_free: True for only step-free ones, False for only ones with steps.
        """
        return session.list_doors(room, floor, max_width_m, min_width_m, kind, step_free)

    @tool
    def find_assets(
        asset_type: str, floor: str | None = None, near: str | None = None, step_free: bool = False
    ) -> dict:
        """Every thing of one type with its room and position, sorted by walking distance from `near` (or
        from where the person is, when known).

        Args:
            asset_type: e.g. "printer", "cnc mill", "desk".
            floor: Only this floor.
            near: A space to sort by walking distance from; omit for the person's position.
            step_free: True to measure the walk without stairs and steps.
        """
        return session.find_assets(asset_type, floor, near, step_free)

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
        query_spaces,
        list_doors,
        find_assets,
    ]

    if mode in (CHAT, BUILDER):

        @tool
        def show_on_map(
            you_are_here: str | None = None, target: str | None = None, show_last_route: bool = False,
            floor: str | None = None,
        ) -> dict:
            """Show the result on the person's map: their position (glowing dot), the target (pin) and the
            last route from find_route as a line. Call it whenever you found a place or a route for them.

            Args:
                you_are_here: The room the person is in, if known.
                target: The room or thing they're looking for (a room name or a thing's name/id).
                show_last_route: True to draw the route from your last find_route call.
                floor: Which floor to show first; omit to start where the person is.
            """
            return session.show_on_map(you_are_here, target, show_last_route, floor)

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

        tools += [show_on_map, ask_user]

    if mode == BUILDER:
        tools += make_builder_tools(session)

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
        def move_thing(thing: str, to_room: str) -> dict:
            """A thing now stands in another room (a facility manager moved a machine, a printer, ...): finding
            it, routes to it and the map use the new place for the rest of the conversation.

            Args:
                thing: Its name ("CNC mill H-A1-A"), id, or its kind when the building has only one of it.
                to_room: The room it is in now.
            """
            return session.move_thing(thing, to_room)

        @tool
        def set_my_position(place: str) -> dict:
            """Record where the person says they are now ("I'm at the lift", "next to the CNC mill H-A1-A",
            "I just came in the main entrance"). Routes then start there without asking, and if they are
            following a route the result says how far along they are or that they left it.

            Args:
                place: A room ("Quality lab 0.21 (Ground floor)", "the quality lab"), a thing next to them
                    (its name or id) or an entrance.
            """
            return session.set_position(place, source="told")

        @tool
        def where_am_i_options(floor: str | None = None) -> dict:
            """Landmarks the person could see near them (rare things, stairs and lifts, entrances, rooms with a
            unique name), nearest to where they were last first. Use it before asking where they are, and offer
            2-4 of them as ask_user options. Without a known floor it says to ask the floor first.

            Args:
                floor: The floor they are on, if known.
            """
            return session.where_am_i_options(floor)

        tools += [set_closed, add_door, move_thing, set_my_position, where_am_i_options]

    if mode == BENCHMARK:

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


def make_builder_tools(session: Session) -> list:
    """Edit tools for a draft building (session.draft); after each edit the session sees the new draft."""
    draft = session.draft

    def edited(result: dict) -> dict:
        session.building = draft.loaded()
        return result

    @tool
    def plan_summary() -> dict:
        """What the plans gave: floors, rooms by kind, size, doors, entrances, stairs and lifts, and the open
        points still to ask about."""
        return draft.summary()

    @tool
    def set_room_type(rooms: list[str], room_type: str) -> dict:
        """Say what kind of rooms these are; they're renamed '<Type> <number>'.

        Args:
            rooms: Room numbers, names or ids, e.g. ["0.20", "0.21"].
            room_type: e.g. office, lab, toilet, kitchen, meeting room, production zone, storage.
        """
        return edited(draft.set_room_type(rooms, room_type))

    @tool
    def rename_space(room: str, name: str | None = None, number: str | None = None) -> dict:
        """Give a space a new name and/or room number.

        Args:
            room: The space as it's called now.
            name: New full name, e.g. "Canteen".
            number: New room number, e.g. "0.18".
        """
        return edited(draft.rename(room, name, number))

    @tool
    def set_door(first: str, second: str, width_m: float | None = None, step_free: bool | None = None) -> dict:
        """Change the door between two spaces ("outside" for an entrance): width and/or whether it has a step.

        Args:
            first: One side.
            second: The other side, or "outside".
            width_m: New width in metres.
            step_free: False if there is a step.
        """
        return edited(draft.set_door(first, second, width_m, step_free))

    @tool
    def set_door_widths(width_m: float, room_types: list[str] | None = None) -> dict:
        """Set the width of all doors, or of all doors of rooms of the given types (e.g. halls 1.6 m).

        Args:
            width_m: Width in metres.
            room_types: Only doors touching these room types; omit for every door.
        """
        return edited(draft.set_all_doors(width_m, room_types))

    @tool
    def add_plan_door(first: str, second: str, width_m: float = 0.9) -> dict:
        """Add a door the plan doesn't show, in the middle of the wall two spaces share.

        Args:
            first: First space.
            second: Second space.
            width_m: Width in metres.
        """
        return edited(draft.add_door(first, second, width_m))

    @tool
    def stair_candidates() -> dict:
        """Spaces that may be unmarked stairs (small corridors on top of each other). Suggestions only."""
        return {"candidates": draft.stair_candidates()}

    @tool
    def mark_stairs(spaces: list[str], kind: str = "stairs", name: str | None = None) -> dict:
        """Make spaces (one per floor) into one staircase or lift linking those floors.

        Args:
            spaces: One space per floor, e.g. ["Corridor 0.05 (Ground floor)", "Corridor 1.05 (Floor 1)"].
            kind: "stairs" or "lift".
            name: Optional name, e.g. "East stairs".
        """
        return edited(draft.mark_stairs(spaces, kind, name))

    @tool
    def set_floor_height(floor: str, height_m: float) -> dict:
        """Set one floor's height; the floors above (and below) are restacked.

        Args:
            floor: e.g. "Ground floor".
            height_m: Height in metres.
        """
        return edited(draft.set_floor_height(floor, height_m))

    @tool
    def set_known_length(room: str, length_m: float, side: str = "longest") -> dict:
        """Correct the size of everything from one length the person knows.

        Args:
            room: A room whose size they know.
            length_m: Its real length in metres.
            side: "longest", "shortest", "width" (left-right) or "depth" (front-back).
        """
        return edited(draft.set_known_length(room, length_m, side))

    @tool
    def save_building(name: str | None = None) -> dict:
        """Save the building once the person confirms it's right; after that everyone can use it.

        Args:
            name: The building's name, if they want to change it.
        """
        path = draft.save(name)
        return {"saved": True, "building_id": path.name}

    return [plan_summary, set_room_type, rename_space, set_door, set_door_widths, add_plan_door,
            stair_candidates, mark_stairs, set_floor_height, set_known_length, save_building]


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
        rules = COMMON_RULES + {CHAT: CHAT_RULES, BENCHMARK: BENCHMARK_RULES, BUILDER: CHAT_RULES + BUILDER_RULES}[mode]
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

    def ask(self, user_text: str, spoken: bool = False) -> str:
        """One user turn. Returns the agent's text; see session.pending_question / session.submitted.
        spoken: the turn was said and the answer is read out (short, and at lower effort, so it's quick)."""
        self.session.pending_question = None
        self.session.map_view = None
        self.session.last_route = None  # a route is shown only if it was found this turn
        known = position_note(self.session)
        if known:  # where the person is (and was): said every turn, so the agent never asks again
            user_text = f"{known}\n{user_text}"
        if spoken:
            user_text += SPOKEN_NOTE
        self.messages.append({"role": "user", "content": user_text})
        runner = self.client.beta.messages.tool_runner(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            max_iterations=MAX_TOOL_ITERATIONS,
            system=self.system,
            tools=self.tools,
            messages=cached(self.messages),
            output_config={"effort": SPOKEN_EFFORT if spoken else EFFORT[self.mode]},
            betas=[FALLBACK_BETA],
            fallbacks="default",
        )
        final = None
        said = []  # everything the agent wrote this turn, also text written next to tool calls
        for message in runner:
            final = message
            self.track_usage(message)
            self.messages.append({"role": "assistant", "content": message.content})
            said += [block.text.strip() for block in message.content if block.type == "text" and block.text.strip()]
            tool_response = runner.generate_tool_call_response()
            if tool_response is not None:
                self.messages.append(tool_response)
        self.write_log()
        if final is None:
            return "(no response)"
        if final.stop_reason == "refusal":
            return "Sorry, I can't help with that request."
        return "\n\n".join(said)

    def answer_benchmark(self, question: str) -> str:
        """Full reply for a scored question, ending with the code-written 'Answer:' line."""
        text = self.ask(question)
        if self.session.submitted is None:
            text += "\n" + self.ask("You didn't call submit_answer. Call it now with your final answer.")
        line = self.session.answer_line()
        route = self.session.route_line()  # before the Answer: line, which the scorer reads and must stay last
        return "\n".join(part for part in (text, route, line) if part)

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
