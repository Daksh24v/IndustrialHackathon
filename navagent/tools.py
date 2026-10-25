"""What the agent can do in one building. Plain functions that return JSON-ready dicts, so they are tested
without the API; agent.py wraps them as Claude tools. Every fact the agent states comes from here."""

import itertools
import math
import re
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field

from shapely.geometry import Point

from navcore.engine import (
    DOOR_PREFIX,
    MIN_SHARED_WALL_M,
    OUTSIDE,
    ROOM_TYPES,
    SPACE_TYPES,
    WALL_NEIGHBOUR_TYPES,
    WALL_TOLERANCE_M,
    WHAT_IF_IMPROVEMENT_M,
    Building,
    Constraints,
    EngineError,
    Route,
)
from navcore.resolve import (
    NoSuchSpace,
    asset_names,
    asset_types,
    find_element,
    find_floor,
    find_space,
    find_type,
    fold,
    normalise,
    room_types,
)

MAX_RESULTS = 25
NO_ROUTE = re.compile(r"\bno\b.*\broute\b|\bunreachable\b|\bnot reachable\b|\bcan(?:no|')t be reached\b", re.I)
NO_ROUTE_ANSWER = "No route exists."
MAX_HISTORY = 10
NEAREST_SPACE_M = 3.0  # a tapped point this close to a space (on a wall, in a doorway) counts as in it
MAX_LANDMARKS = 8
LANDMARK_MAX_PER_FLOOR = 2  # a kind of thing that occurs at most this often on a floor is a landmark
MAX_FLOORS_IN_ONE_QUESTION = 4  # more floors than this: ask the floor first, then landmarks
TURN_REACH_M = 2.0  # a turn is judged over the 2 m before and after a door
STRAIGHT_DEG = 30.0
AROUND_DEG = 150.0
LANDMARK_NEAR_DOOR_M = 3.0  # a rare thing this close to a door is named in the step


@dataclass
class Position:
    """Where the person is: a space, and the exact point when the phone knows it (a tap, AR later).
    source: 'phone' (set from outside), 'told' (they said so), 'route' (they confirmed a step)."""

    space_id: str
    floor_id: str
    label: str
    point: tuple[float, float] | None = None
    source: str = "told"
    time: float = field(default_factory=time.time)


def find_asset_type(building: Building, words: str) -> str:
    return find_type(words, asset_types(building), asset_names(building))


def heading(points: list[tuple[float, float]], at_end: bool) -> tuple[float, float] | None:
    """Which way someone walks over the last (at_end) or first TURN_REACH_M of a path; None if it has no length."""
    path = list(reversed(points)) if at_end else points
    walked = 0.0
    for first, second in itertools.pairwise(path):
        walked += math.dist(first, second)
        if walked >= TURN_REACH_M:
            break
    far = second if len(path) > 1 else path[0]
    vector = (path[0][0] - far[0], path[0][1] - far[1]) if at_end else (far[0] - path[0][0], far[1] - path[0][1])
    return vector if math.hypot(*vector) > 1e-6 else None


def turn_word(incoming: tuple[float, float] | None, outgoing: tuple[float, float] | None) -> str:
    """'turn left', 'turn right', 'go straight' or 'turn around' (x east, y north: counter-clockwise is left)."""
    if incoming is None or outgoing is None:
        return "go"
    cross = incoming[0] * outgoing[1] - incoming[1] * outgoing[0]
    dot = incoming[0] * outgoing[0] + incoming[1] * outgoing[1]
    angle = math.degrees(math.atan2(cross, dot))
    if abs(angle) < STRAIGHT_DEG:
        return "go straight"
    if abs(angle) > AROUND_DEG:
        return "turn around and go"
    return "turn left" if angle > 0 else "turn right"


def bare_name(name: str) -> str:
    """A name without its numbers: 'Quality lab 0.21' -> 'quality lab' (for 'is this name unique?')."""
    return fold(" ".join(word for word in normalise(name).split() if not any(char.isdigit() for char in word)))


def rounded(value: float) -> float:
    return round(value, 2)


def space_types(types: list[str] | None, default: frozenset[str]) -> frozenset[str]:
    """Which kinds of space count, e.g. ["room", "hall"]; None keeps the README default."""
    if types is None:
        return default
    wanted = frozenset(normalise(item).rstrip("s") for item in types)
    unknown = wanted - set(SPACE_TYPES)
    if unknown:
        raise EngineError(f"Unknown space types {sorted(unknown)}; use {', '.join(SPACE_TYPES)}.")
    return wanted


SAFETY_THINGS = ("fire_extinguisher", "defibrillator", "eyewash_station")  # safety mode's quick buttons


@dataclass
class Session:
    """One building plus the changes made in this conversation (closures, new doors)."""

    building: Building
    closed: set[str] = field(default_factory=set)
    new_openings: list[dict] = field(default_factory=list)
    pending_question: dict | None = None  # set by ask_user; the app shows it as option chips
    position: Position | None = None  # where the person is now
    history: list[Position] = field(default_factory=list)  # where they were before, newest last
    active_route: dict | None = None  # the route they are following: stops, spaces in order, progress
    submitted: dict | None = None  # set by submit_answer in benchmark mode
    moved: dict[str, dict] = field(default_factory=dict)  # things moved in this conversation, by asset id
    last_route: list[Route] | None = None  # legs of the most recent find_route, for show_on_map
    map_view: dict | None = None  # what the app should draw after this turn (show_on_map)
    draft: object | None = None  # navagent.builder.Draft while a building is being set up from plans
    # What people reported broken for the whole building (live app only, server/reports.py), by element id:
    # every route here avoids them. The server fills this before each turn; the benchmark never does.
    reported: dict[str, dict] = field(default_factory=dict)
    # The server's way to file a report for everyone (and tell maintenance); None outside the live app.
    on_report: Callable[[dict, bool], dict] | None = None

    @property
    def here(self) -> str | None:
        return self.position.space_id if self.position else None

    def start_or_here(self, start: str | None) -> str:
        """The start the agent named, else where the person is known to be."""
        if start:
            return find_space(self.building, start)
        if self.position:
            return self.position.space_id
        raise EngineError("Where is the person? Not known yet: call where_am_i_options and ask them once.")

    def constraints(
        self, step_free: bool = False, min_width_m: float = 0.0, closed: list[str] | None = None
    ) -> Constraints:
        extra_closed = {find_element(self.building, item) for item in closed or []}
        return Constraints(
            step_free=step_free,
            min_width_m=min_width_m,
            closed=frozenset(self.closed | set(self.reported) | extra_closed),
            extra_openings=tuple(self.new_openings),
        )

    def space_summary(self, space_id: str) -> dict:
        space = self.building.spaces[space_id]
        return {
            "id": space_id,
            "name": space["name"],
            "ref": space.get("ref"),
            "type": space["type"],
            "room_type": space["room_type"],
            "floor": self.building.floor_name(space["floor_id"]),
            "area_m2": rounded(self.building.area(space_id)),
        }

    # ---------- look things up ----------

    def overview(self) -> dict:
        building = self.building
        floors = []
        for floor in sorted(building.floors.values(), key=lambda item: item["level"]):
            spaces = building.spaces_on(floor["id"])
            floors.append(
                {
                    "level": floor["level"],
                    "name": floor["name"],
                    "elevation_m": floor["elevation_m"],
                    "spaces": len(spaces),
                    "room_types": sorted({space["room_type"] for space in spaces}),
                }
            )
        return {
            "name": building.info["name"],
            "source": building.info["source"],
            "floors": floors,
            "stairs_and_lifts": [
                {
                    "id": connector["id"],
                    "name": connector["name"],
                    "kind": connector["kind"],
                    "step_free": connector.get("step_free"),
                    "floors": [building.floor_name(floor_id) for floor_id in connector["floor_ids"]],
                }
                for connector in building.connectors.values()
            ],
            "entrances": [
                {
                    "id": opening["id"],
                    "into": building.label(next(s for s in opening["space_ids"] if s != OUTSIDE)),
                    "step_free": opening.get("step_free"),
                    "width_m": opening.get("width_m"),
                }
                for opening in building.openings.values()
                if OUTSIDE in opening["space_ids"]
            ],
            "asset_types": sorted(asset_types(building)),
            "closed": sorted(self.closed),
            "added_doors": [opening["id"] for opening in self.new_openings],
            "moved": [{"id": asset["id"], "name": asset["name"], "room": building.label(asset["space_id"])}
                      for asset in self.moved.values()],
        }

    def search(self, query: str, floor: str | None = None) -> dict:
        """Spaces and assets whose name, ref or type contains every word of the query."""
        building = self.building
        floor_id = find_floor(building, floor) if floor else None
        words = normalise(query).split()

        def hit(text: str, item_floor: str) -> bool:
            return (floor_id is None or item_floor == floor_id) and all(word in normalise(text) for word in words)

        spaces = [
            self.space_summary(space["id"])
            for space in building.spaces.values()
            if hit(f"{space['name']} {space.get('ref') or ''} {space['room_type']}", space["floor_id"])
        ]
        assets = [
            {
                "id": asset["id"],
                "name": asset["name"],
                "type": asset["type"],
                "in": building.label(asset["space_id"]),
                "space_id": asset["space_id"],
                "position": asset["position"],
            }
            for asset in building.assets.values()
            if hit(f"{asset['name']} {asset['type']}", asset["floor_id"])
        ]
        if not spaces and not assets:
            raise EngineError(f"Nothing matches '{query}'. Try fewer or more general words.")
        return {
            "spaces_found": len(spaces),
            "spaces": spaces[:MAX_RESULTS],
            "assets_found": len(assets),
            "assets": assets[:MAX_RESULTS],
        }

    def count_assets(self, asset_type: str, floor: str | None = None) -> dict:
        """How many things of exactly one type there are (optionally on one floor), and where."""
        building = self.building
        wanted = find_asset_type(building, asset_type)
        floor_id = find_floor(building, floor) if floor else None
        found = [
            asset
            for asset in building.assets.values()
            if asset["type"] == wanted and (floor_id is None or asset["floor_id"] == floor_id)
        ]
        rooms: dict[str, int] = {}
        for asset in found:
            rooms[building.label(asset["space_id"])] = rooms.get(building.label(asset["space_id"]), 0) + 1
        return {
            "asset_type": wanted,
            "floor": building.floor_name(floor_id) if floor_id else "all floors",
            "count": len(found),
            "by_room": dict(sorted(rooms.items(), key=lambda item: -item[1])[:MAX_RESULTS]),
        }

    def largest_room(self, floor: str, room_type: str) -> dict:
        """The largest space of one room type on a floor, with the runner-up for comparison."""
        building = self.building
        floor_id = find_floor(building, floor)
        wanted = find_type(room_type, room_types(building))
        ranked = sorted(building.rooms_of_type(floor_id, wanted), key=building.area, reverse=True)
        if not ranked:
            raise EngineError(f"No {wanted} on {building.floor_name(floor_id)}.")
        return {
            "largest": self.space_summary(ranked[0]),
            "runner_up": self.space_summary(ranked[1]) if len(ranked) > 1 else None,
            "count": len(ranked),
        }

    def list_rooms(self, floor: str, room_type: str | None = None) -> dict:
        """Every space on a floor (optionally one room type), largest first, with areas and the total."""
        building = self.building
        floor_id = find_floor(building, floor)
        wanted = find_type(room_type, room_types(building)) if room_type else None
        spaces = [s for s in building.spaces_on(floor_id) if wanted is None or s["room_type"] == wanted]
        rows = sorted((self.space_summary(s["id"]) for s in spaces), key=lambda row: -row["area_m2"])
        return {
            "floor": building.floor_name(floor_id),
            "room_type": wanted,
            "count": len(rows),
            "total_area_m2": rounded(sum(building.area(s["id"]) for s in spaces)),
            "spaces": rows[:MAX_RESULTS * 2],
        }

    def room_details(self, room: str) -> dict:
        """Area, doors (with widths), wall neighbours, rooms above/below and the centroid of one space."""
        building = self.building
        space_id = find_space(building, room)
        doors = [
            {
                "id": opening["id"],
                "to": "outside" if other == OUTSIDE else building.label(other),
                "kind": opening["kind"],
                "width_m": opening.get("width_m"),
                "step_free": opening.get("step_free"),
            }
            for opening in [*building.openings.values(), *self.new_openings]
            if space_id in opening["space_ids"]
            for other in opening["space_ids"]
            if other != space_id
        ]
        above = building.stacked_room(space_id, "above")
        below = building.stacked_room(space_id, "below")
        x, y, z = building.centroid_3d(space_id)
        return {
            **self.space_summary(space_id),
            "centroid": [rounded(x), rounded(y), rounded(z)],
            "doors": doors,
            "rooms_sharing_a_wall": [building.label(other) for other in building.wall_neighbours(space_id)],
            "directly_above": building.label(above) if above else None,
            "directly_below": building.label(below) if below else None,
            "assets": [asset["name"] for asset in building.assets.values() if asset["space_id"] == space_id][:40],
        }

    def stacked_room(self, room: str, direction: str) -> dict:
        """The space on the next floor up or down whose outline covers most of this room's outline."""
        building = self.building
        space_id = find_space(building, room)
        if direction not in ("above", "below"):
            raise EngineError("direction must be 'above' or 'below'.")
        other = building.stacked_room(space_id, direction)
        if other is None:
            raise EngineError(f"No floor {direction} {building.label(space_id)}, or nothing overlaps it.")
        return {"room": building.label(space_id), "direction": direction, "stacked": self.space_summary(other)}

    def wall_neighbours(
        self,
        room: str,
        min_length_m: float = MIN_SHARED_WALL_M,
        tolerance_m: float = WALL_TOLERANCE_M,
        count_types: list[str] | None = None,
    ) -> dict:
        """Spaces on the same floor whose wall runs along this room for at least min_length_m (within
        tolerance_m), with or without a door. Default: rooms and halls count; corridors, stairwells, lifts and
        outdoor areas don't."""
        building = self.building
        space_id = find_space(building, room)
        types = space_types(count_types, WALL_NEIGHBOUR_TYPES)
        neighbours = building.wall_neighbours(space_id, min_length_m, tolerance_m, types)
        return {
            "room": building.label(space_id),
            "count": len(neighbours),
            "neighbours": [building.label(other) for other in neighbours],
        }

    # ---------- routes ----------

    def route(
        self,
        start: str | None,
        destination: str,
        step_free: bool = False,
        min_width_m: float = 0.0,
        via: list[str] | None = None,
        avoid: list[str] | None = None,
    ) -> dict:
        """Shortest route, optionally through stops in order; step-free / minimum door width / avoiding things.
        No start: from where the person is. The route becomes the one they follow (active_route)."""
        building = self.building
        constraints = self.constraints(step_free, min_width_m, avoid)
        stops = [self.start_or_here(start), *[find_space(building, stop) for stop in via or []]]
        stops.append(find_space(building, destination))
        try:
            legs = building.tour(stops, constraints)
        except EngineError:
            self.active_route = None  # they asked for another way: the old route is not the one they follow
            raise
        self.last_route = legs
        spaces: list[str] = []
        for leg in legs:
            spaces += [space for space in leg.space_path if not spaces or spaces[-1] != space]
        self.active_route = {"stops": stops, "spaces": spaces, "destination": stops[-1], "progress": 0,
                             "step_free": step_free, "min_width_m": min_width_m}
        return {
            "from": building.label(stops[0]),
            "to": building.label(stops[-1]),
            "length_m": rounded(sum(leg.length_m for leg in legs)),
            "legs": [
                {
                    "from": building.label(leg.start),
                    "to": building.label(leg.destination),
                    "length_m": rounded(leg.length_m),
                    "steps": self.directions(leg),
                }
                for leg in legs
            ],
            "constraints": {"step_free": step_free, "min_width_m": min_width_m, "closed": sorted(constraints.closed)},
        }

    def directions(self, route: Route) -> list[str]:
        """Followable steps: one line per door into another space and per stair or lift, with the metres, the
        turn (left / right / straight, from the walk itself) and a rare thing next to the door when there is
        one ("by the Air compressor H-C5")."""
        building = self.building
        openings = {opening["id"]: opening for opening in [*building.openings.values(), *self.new_openings]}
        added = tuple(self.new_openings)
        steps = []
        walked = 0.0
        following = [*route.hops[1:], None]
        for (previous, current, how), length, after in zip(route.hops, route.hop_lengths, following):
            walked += length
            if how in building.connectors:
                connector = building.connectors[how]
                verb = "Take" if connector["kind"] == "lift" else "Use"
                floor = building.floor_name(building.spaces[current]["floor_id"])
                steps.append(f"{verb} {connector['name']} ({connector['kind']}) to {floor}.")
                walked = 0.0
            elif current.startswith(DOOR_PREFIX):
                opening = openings[current.removeprefix(DOOR_PREFIX)]
                if after is None:
                    steps.append(f"Walk about {walked:.0f} m and leave the building through the entrance.")
                    walked = 0.0
                elif after[2] in building.spaces and after[2] != how:
                    incoming = heading(building.hop_points(previous, current, how, added), at_end=True)
                    outgoing = heading(building.hop_points(current, after[1], after[2], added), at_end=False)
                    passage = "through the door" if opening["kind"] == "door" else "through the opening"
                    near = self.thing_near(opening)
                    landmark = f" (by the {near})" if near else ""
                    steps.append(f"Walk about {walked:.0f} m, then {turn_word(incoming, outgoing)} "
                                 f"{passage} into {building.spaces[after[2]]['name']}{landmark}.")
                    walked = 0.0
        if not route.nodes[-1].startswith(DOOR_PREFIX):
            steps.append(f"Walk about {walked:.0f} m. You have arrived at {building.label(route.nodes[-1])}.")
        return steps

    def thing_near(self, opening: dict) -> str | None:
        """The rare thing (at most 2 of its kind on the floor) closest to a door, if within 3 m: a landmark."""
        building = self.building
        floor_id = opening["floor_id"]
        kinds: dict[str, int] = {}
        for asset in building.assets.values():
            if asset["floor_id"] == floor_id:
                kinds[asset["type"]] = kinds.get(asset["type"], 0) + 1
        near = [(math.dist(asset["position"], opening["position"]), asset["name"]) for asset in building.assets.values()
                if asset["floor_id"] == floor_id and kinds[asset["type"]] <= LANDMARK_MAX_PER_FLOOR
                and set(opening["space_ids"]) & {asset["space_id"]}]
        distance, name = min(near, default=(math.inf, None))
        return name if distance <= LANDMARK_NEAR_DOOR_M else None

    def nearest_exit(self, room: str | None = None, step_free: bool = False) -> dict:
        """Walk from a room (default: where the person is) out of the building through its nearest entrance,
        with this conversation's changes."""
        building = self.building
        space_id = self.start_or_here(room)
        route = building.exit_route(space_id, self.constraints(step_free))
        self.last_route = [route]
        return {"from": building.label(space_id), "walk_m": rounded(route.length_m), "steps": self.directions(route)}

    def nearest_with_asset(self, start: str | None, asset_type: str, step_free: bool = False) -> dict:
        building = self.building
        start_id = self.start_or_here(start)
        wanted = find_asset_type(building, asset_type)
        space_id, distance = building.nearest_space_with_asset(start_id, wanted, self.constraints(step_free))
        return {
            "asset_type": wanted,
            "nearest_room": building.label(space_id),
            "space_id": space_id,
            "walk_m": rounded(distance),
        }

    def nearest_safety(self, kind: str) -> dict:
        """Safety mode's quick buttons, without the agent: the nearest exit or the nearest fire extinguisher,
        defibrillator or eyewash station from where the person is, shown on the map with the route (closures and
        reports respected)."""
        building = self.building
        if kind == "exit":
            self.nearest_exit()
            route = self.last_route[0]
            opening = building.openings[route.nodes[-1].removeprefix(DOOR_PREFIX)]
            self.show_on_map(show_last_route=True)
            self.map_view["target"] = {"space_id": self.inside_of(opening), "label": "Exit",
                                       "floor_id": opening["floor_id"], "position": list(opening["position"])}
            return {"kind": kind, "label": "the nearest exit", "room": building.label(self.inside_of(opening)),
                    "walk_m": rounded(route.length_m)}
        if kind not in SAFETY_THINGS:
            raise EngineError(f"Unknown safety kind {kind!r}: exit, {', '.join(SAFETY_THINGS)}.")
        found = self.nearest_with_asset(None, kind)
        asset = min((item for item in building.assets.values()
                     if item["type"] == found["asset_type"] and item["space_id"] == found["space_id"]),
                    key=lambda item: item["id"])
        self.route(None, found["space_id"])
        self.show_on_map(target=asset["id"], show_last_route=True)
        return {"kind": kind, "label": asset["name"], "room": building.label(asset["space_id"]),
                "walk_m": found["walk_m"]}

    def errand_walk(self, start: str | None, asset_type: str, destination: str, step_free: bool = False) -> dict:
        """Walk from start (default: where the person is) to the nearest room holding an asset type, then on
        to the destination."""
        building = self.building
        start_id, target_id = self.start_or_here(start), find_space(building, destination)
        wanted = find_asset_type(building, asset_type)
        constraints = self.constraints(step_free)
        via, first_leg = building.nearest_space_with_asset(start_id, wanted, constraints)
        total = building.errand(start_id, wanted, target_id, constraints)[1]
        return {
            "pickup_room": building.label(via),
            "first_leg_m": rounded(first_leg),
            "second_leg_m": rounded(total - first_leg),
            "total_walk_m": rounded(total),
            "step_free": step_free,
        }

    def reachable_rooms(
        self,
        start: str,
        floor: str,
        step_free: bool = False,
        min_width_m: float = 0.0,
        avoid: list[str] | None = None,
        count_types: list[str] | None = None,
    ) -> dict:
        """Which spaces on a floor can be reached from start under the constraints. Default: only spaces of
        type room count (corridors, halls, stairwells, lifts and outdoor areas don't)."""
        building = self.building
        floor_id = find_floor(building, floor)
        constraints = self.constraints(step_free, min_width_m, avoid)
        types = space_types(count_types, ROOM_TYPES)
        rooms = building.reachable_rooms(find_space(building, start), floor_id, constraints, types)
        total = len([space for space in building.spaces_on(floor_id) if space["type"] in types])
        return {
            "floor": building.floor_name(floor_id),
            "reachable_rooms": len(rooms),
            "rooms_on_floor": total,
            "rooms": [building.spaces[room]["name"] for room in rooms][: MAX_RESULTS * 2],
        }

    def straight_line(self, first: str, second: str) -> dict:
        building = self.building
        first_id, second_id = find_space(building, first), find_space(building, second)
        return {"distance_m": rounded(building.straight_line_3d(first_id, second_id))}

    def what_if_door(
        self,
        first: str,
        second: str,
        floor: str,
        threshold_m: float = WHAT_IF_IMPROVEMENT_M,
        count_types: list[str] | None = None,
        step_free: bool = False,
    ) -> dict:
        """Effect of a new door (middle of the shared wall) on every room's walk out of the building."""
        building = self.building
        first_id, second_id = find_space(building, first), find_space(building, second)
        floor_id = find_floor(building, floor)
        types = space_types(count_types, ROOM_TYPES)
        improved = building.what_if_door(
            first_id, second_id, floor_id, threshold_m, types, self.constraints(step_free)
        )
        return {
            "floor": building.floor_name(floor_id),
            "rooms_with_shorter_exit": len(improved),
            "rooms": [building.spaces[room]["name"] for room in improved][:MAX_RESULTS],
        }

    # ---------- changes ----------

    def set_closed(self, element: str, closed: bool) -> dict:
        element_id = find_element(self.building, element)
        if closed:
            self.closed.add(element_id)
        else:
            self.closed.discard(element_id)
        self.show_change(self.floor_of(element_id))
        return {"element_id": element_id, "closed": closed, "all_closed": sorted(self.closed)}

    def element_summary(self, element_id: str) -> dict:
        """A lift, staircase, door or room as people say it: kind, a label with its floors, the floors it is on."""
        building = self.building
        if element_id in building.connectors:
            connector = building.connectors[element_id]
            floors = [building.floor_name(floor_id) for floor_id in connector["floor_ids"]]
            return {"element_id": element_id, "kind": connector["kind"],
                    "label": f"{connector['name']} ({' ↔ '.join(floors)})", "floor_ids": list(connector["floor_ids"])}
        if element_id in building.openings:
            opening = building.openings[element_id]
            rooms = " and ".join(building.spaces[space]["name"] for space in opening["space_ids"] if space in building.spaces)
            kind = "entrance" if opening.get("kind") == "entrance" else "door"
            return {"element_id": element_id, "kind": kind,
                    "label": f"{kind.capitalize()} {'to ' if kind == 'entrance' else 'between '}{rooms}".strip(),
                    "floor_ids": [opening["floor_id"]]}
        space = building.spaces[element_id]
        return {"element_id": element_id, "kind": "room", "label": building.label(element_id),
                "floor_ids": [space["floor_id"]]}

    def report_problem(self, element: str, problem: str, fixed: bool = False) -> dict:
        """Something is broken or out of service for everyone (or works again): every conversation about this
        building routes around it, the map shows it, and maintenance is told."""
        if self.on_report is None:
            raise EngineError("Reports for the whole building only work in the live app; use set_closed here.")
        summary = self.element_summary(find_element(self.building, element))
        filed = self.on_report({**summary, "problem": problem}, fixed)
        element_id = summary["element_id"]
        if fixed:
            self.reported.pop(element_id, None)
        else:
            self.reported[element_id] = filed["report"]
        self.show_change(summary["floor_ids"][0])
        return {"reported": summary["label"], "status": "works again" if fixed else "out of service for everyone",
                "maintenance": filed["maintenance"]}

    def add_door(self, first: str, second: str, width_m: float = 0.9, step_free: bool = True) -> dict:
        building = self.building
        door = building.door_between(find_space(building, first), find_space(building, second))
        door.update(width_m=width_m, step_free=step_free, id=f"{door['floor_id']}-O-new{len(self.new_openings) + 1}")
        self.new_openings.append(door)
        self.show_change(door["floor_id"])
        return {"added": door}

    def move_thing(self, thing: str, to_room: str) -> dict:
        """A thing (machine, printer, ...) now stands in another room: from now on finding it, routing to it and
        the map use the new place. It stands at the room's centre."""
        building = self.building
        asset = self.find_thing(thing)
        space_id = find_space(building, to_room)
        before = building.label(asset["space_id"])
        asset.update(space_id=space_id, floor_id=building.spaces[space_id]["floor_id"],
                     position=[round(value, 3) for value in building.anchor(space_id)])
        self.moved[asset["id"]] = asset
        self.show_change(asset["floor_id"])
        return {"moved": asset["name"], "from": before, "to": building.label(space_id)}

    def find_thing(self, thing: str) -> dict:
        """One thing by id, by name ('CNC mill H-A1-A'), or by kind when the building has only one of it."""
        building = self.building
        if thing in building.assets:
            return building.assets[thing]
        named = [asset for asset in building.assets.values() if fold(asset["name"]) == fold(thing)]
        if len(named) == 1:
            return named[0]
        kind = find_asset_type(building, thing)
        of_kind = [asset for asset in building.assets.values() if asset["type"] == kind]
        if len(of_kind) == 1:
            return of_kind[0]
        listed = "; ".join(f"{asset['name']} in {building.label(asset['space_id'])}" for asset in of_kind[:8])
        raise EngineError(f"There are {len(of_kind)} of those: {listed}. Which one?")

    def floor_of(self, element_id: str) -> str | None:
        building = self.building
        if element_id in building.spaces:
            return building.spaces[element_id]["floor_id"]
        if element_id in building.openings:
            return building.openings[element_id]["floor_id"]
        if element_id in building.connectors:
            return building.connectors[element_id]["floor_ids"][0]
        return None

    def changes(self) -> dict | None:
        """What this conversation changed, for the map: closed doors, stairs, lifts and rooms, new doors, moved
        things. None when nothing changed."""
        if not (self.closed or self.new_openings or self.moved or self.reported):
            return None
        return {
            "closed": sorted(self.closed),
            "reported": [dict(report) for report in self.reported.values()],
            "new_doors": [{"id": door["id"], "floor_id": door["floor_id"], "position": door["position"],
                           "width_m": door.get("width_m")} for door in self.new_openings],
            "moved": [{"asset_id": asset["id"], "label": asset["name"], "space_id": asset["space_id"],
                       "floor_id": asset["floor_id"], "position": asset["position"]} for asset in self.moved.values()],
        }

    def show_change(self, floor_id: str | None) -> None:
        """A change shows on the map at once, on its floor (the agent can still show a route after it)."""
        self.show_on_map(floor=floor_id) if floor_id else self.show_on_map()

    # ---------- general queries (for questions no specific tool covers) ----------

    def query_spaces(
        self,
        floor: str | None = None,
        space_type: str | None = None,
        room_type: str | None = None,
        name_contains: str | None = None,
        min_area_m2: float | None = None,
        max_area_m2: float | None = None,
        sort_by: str = "area_desc",
        distance_from: str | None = None,
        step_free: bool = False,
        limit: int = MAX_RESULTS,
    ) -> dict:
        """Filter spaces and get count, total/min/max/mean area; optionally sorted by walking distance."""
        building = self.building
        floor_id = find_floor(building, floor) if floor else None
        kind = space_types([space_type], frozenset()) if space_type else None
        wanted = find_type(room_type, room_types(building)) if room_type else None
        words = normalise(name_contains).split() if name_contains else []
        chosen = []
        for space in building.spaces.values():
            if floor_id and space["floor_id"] != floor_id:
                continue
            if kind and space["type"] not in kind:
                continue
            if wanted and space["room_type"] != wanted:
                continue
            if words and not all(word in normalise(f"{space['name']} {space.get('ref') or ''}") for word in words):
                continue
            area = building.area(space["id"])
            if (min_area_m2 is not None and area < min_area_m2) or (max_area_m2 is not None and area > max_area_m2):
                continue
            chosen.append(space["id"])
        distances = {}
        if distance_from:
            distances = building.distances_from(find_space(building, distance_from), self.constraints(step_free))
        keys = {
            "area_desc": lambda space_id: -building.area(space_id),
            "area_asc": building.area,
            "name": lambda space_id: building.spaces[space_id]["name"],
            "distance": lambda space_id: distances.get(space_id, math.inf),
        }
        if sort_by not in keys:
            raise EngineError(f"sort_by must be one of {', '.join(keys)}.")
        if sort_by == "distance" and not distance_from:
            raise EngineError("sort_by='distance' needs distance_from.")
        chosen.sort(key=keys[sort_by])
        areas = [building.area(space_id) for space_id in chosen]
        rows = []
        for space_id in chosen[: max(1, limit)]:
            row = self.space_summary(space_id)
            if distance_from:
                walk = distances.get(space_id)
                row["walk_m"] = rounded(walk) if walk is not None else None
            rows.append(row)
        return {
            "count": len(chosen),
            "total_area_m2": rounded(sum(areas)),
            "min_area_m2": rounded(min(areas)) if areas else None,
            "max_area_m2": rounded(max(areas)) if areas else None,
            "mean_area_m2": rounded(sum(areas) / len(areas)) if areas else None,
            "spaces": rows,
        }

    def list_doors(
        self,
        room: str | None = None,
        floor: str | None = None,
        max_width_m: float | None = None,
        min_width_m: float | None = None,
        kind: str | None = None,
        step_free: bool | None = None,
    ) -> dict:
        """Doors, openings and entrances (of one room or one floor), filtered by width, kind and steps."""
        building = self.building
        space_id = find_space(building, room) if room else None
        floor_id = find_floor(building, floor) if floor else None
        rows = []
        for opening in [*building.openings.values(), *self.new_openings]:
            if space_id and space_id not in opening["space_ids"]:
                continue
            if floor_id and opening["floor_id"] != floor_id:
                continue
            width = opening.get("width_m") or 0.0
            if (max_width_m is not None and width > max_width_m + 1e-9) or (
                min_width_m is not None and width < min_width_m - 1e-9
            ):
                continue
            if kind and opening["kind"] != kind:
                continue
            if step_free is not None and bool(opening.get("step_free", True)) != step_free:
                continue
            rows.append(
                {
                    "id": opening["id"],
                    "kind": opening["kind"],
                    "between": [
                        "outside" if side == OUTSIDE else building.label(side) for side in opening["space_ids"]
                    ],
                    "width_m": opening.get("width_m"),
                    "step_free": opening.get("step_free"),
                }
            )
        widths = [row["width_m"] for row in rows if row["width_m"] is not None]
        return {
            "count": len(rows),
            "narrowest_m": min(widths) if widths else None,
            "widest_m": max(widths) if widths else None,
            "doors": rows[: MAX_RESULTS * 2],
        }

    def find_assets(
        self, asset_type: str, floor: str | None = None, near: str | None = None, step_free: bool = False
    ) -> dict:
        """Every thing of one type with its room and position; sorted by walking distance (with this
        conversation's closures and new doors) from `near`, or from where the person is when that's known."""
        building = self.building
        wanted = find_asset_type(building, asset_type)
        floor_id = find_floor(building, floor) if floor else None
        origin = find_space(building, near) if near else self.here
        distances = building.distances_from(origin, self.constraints(step_free)) if origin else {}
        found = [
            asset
            for asset in building.assets.values()
            if asset["type"] == wanted and (floor_id is None or asset["floor_id"] == floor_id)
        ]
        if origin:
            found.sort(key=lambda asset: distances.get(asset["space_id"], math.inf))
        return {
            "asset_type": wanted,
            "count": len(found),
            "assets": [
                {
                    "id": asset["id"],
                    "name": asset["name"],
                    "room": building.label(asset["space_id"]),
                    "space_id": asset["space_id"],
                    "position": asset["position"],
                    **({"walk_m": rounded(distances[asset["space_id"]])} if asset["space_id"] in distances else {}),
                }
                for asset in found[: MAX_RESULTS * 2]
            ],
        }

    # ---------- where the person is ----------

    def set_position(
        self,
        place: str | None = None,
        floor: str | None = None,
        x: float | None = None,
        y: float | None = None,
        source: str = "phone",
    ) -> dict:
        """Where the person is: a room, a thing next to them ('the CNC mill H-A1-A'), an entrance, or a point
        on a floor (a tap on the map, AR later). The old position goes into the history; if they are following
        a route, it says how far along they are, or that they left it."""
        building = self.building
        if x is not None and y is not None:
            if not floor:
                raise EngineError("A point needs its floor.")
            point = (float(x), float(y))
            space_id = self.space_at(find_floor(building, floor), point)
        elif place:
            space_id, point = self.place_of(place)
        else:
            raise EngineError("Say where: a room, a thing, an entrance, or a floor with x and y.")
        if self.position and self.position.space_id != space_id:
            self.history = [*self.history, self.position][-MAX_HISTORY:]
        self.position = Position(space_id, building.spaces[space_id]["floor_id"], building.label(space_id),
                                 point, source)
        return {**self.position_summary(self.position), **self.route_progress()}

    def clear_position(self) -> dict:
        if self.position:
            self.history = [*self.history, self.position][-MAX_HISTORY:]
        self.position = None
        return {"position": None}

    def space_at(self, floor_id: str, point: tuple[float, float]) -> str:
        """The space a point on a floor is in (the smallest, if outlines overlap), else the nearest within 3 m."""
        building = self.building
        spaces = building.spaces_on(floor_id)
        inside = [space["id"] for space in spaces if building.polygons[space["id"]].covers(Point(point))]
        if inside:
            return min(inside, key=building.area)
        distance, nearest = min(((building.polygons[space["id"]].distance(Point(point)), space["id"])
                                 for space in spaces), default=(math.inf, None))
        if nearest is None or distance > NEAREST_SPACE_M:
            raise EngineError(f"That point is not inside the building on {building.floor_name(floor_id)}.")
        return nearest

    def place_of(self, place: str) -> tuple[str, tuple[float, float] | None]:
        """A place someone names: a space, else a thing (by id or name) or an entrance, with its exact point."""
        building = self.building
        try:
            return find_space(building, place), None
        except NoSuchSpace as error:
            missed = error
        wanted = fold(place)
        assets = [asset for asset in building.assets.values()
                  if place == asset["id"] or wanted == fold(asset["name"])]
        if len(assets) == 1:
            return assets[0]["space_id"], tuple(assets[0]["position"])
        entrances = [opening for opening in building.openings.values() if OUTSIDE in opening["space_ids"]]
        named = [opening for opening in entrances if place == opening["id"]]
        if not named and wanted in {"entrance", "main entrance", "eingang", "front door", "the entrance"}:
            named = entrances if len(entrances) == 1 else []
            if len(entrances) > 1:
                raise EngineError(f"There are {len(entrances)} entrances: " + "; ".join(
                    f"{opening['id']} into {building.label(self.inside_of(opening))}" for opening in entrances[:8])
                    + ". Which one?")
        if named:
            return self.inside_of(named[0]), tuple(named[0]["position"])
        raise missed

    @staticmethod
    def inside_of(opening: dict) -> str:
        return next(space_id for space_id in opening["space_ids"] if space_id != OUTSIDE)

    def position_summary(self, position: Position) -> dict:
        summary = {key: value for key, value in asdict(position).items() if key != "time"}
        summary["floor"] = self.building.floor_name(position.floor_id)
        return summary

    def route_progress(self) -> dict:
        """How far along the active route the person is; moves the progress forward when they confirm a step."""
        route, position = self.active_route, self.position
        if not route or not position:
            return {}
        spaces, building = route["spaces"], self.building
        destination = building.label(route["destination"])
        if position.space_id not in spaces:
            return {"on_route": False, "route_to": destination,
                    "note": "Not on the route any more: find a new route from here."}
        step = max(index for index, space_id in enumerate(spaces) if space_id == position.space_id)
        route["progress"] = max(route["progress"], step)
        following = spaces[step + 1] if step + 1 < len(spaces) else None
        return {"on_route": True, "route_to": destination, "arrived": position.space_id == route["destination"],
                "next": building.label(following) if following else None,
                "spaces_left": len(spaces) - 1 - step}

    def position_state(self) -> dict:
        """Everything known about where the person is: now, before, and the route they are following."""
        route = self.active_route
        return {
            "position": self.position_summary(self.position) if self.position else None,
            "history": [{"label": item.label, "source": item.source} for item in reversed(self.history)],
            "active_route": {
                "to": self.building.label(route["destination"]),
                "spaces": [self.building.label(space_id) for space_id in route["spaces"]],
                "progress": route["progress"],
            } if route else None,
        }

    def where_am_i_options(self, floor: str | None = None) -> dict:
        """Landmarks to ask 'what's near you?' with, taken from this building's own data: things that are rare
        on the floor, stairs and lifts, entrances, rooms with a name nothing else has. Nearest to the last known
        position first, else the rarest first. With the floor unknown and up to 4 floors, the landmarks span
        the floors (each says its floor), so one question finds floor and place together."""
        building = self.building
        floor_id = find_floor(building, floor) if floor else self.position.floor_id if self.position else None
        last = self.position or (self.history[-1] if self.history else None)
        distances = building.distances_from(last.space_id, self.constraints()) if last else {}
        how = "Ask once, 'What can you see near you?', with 2-4 of these as options."
        ordered = sorted(building.floors.values(), key=lambda item: item["level"])
        if floor_id is None and len(ordered) > 1:
            if len(ordered) > MAX_FLOORS_IN_ONE_QUESTION:
                return {"ask_first": "Which floor are you on?", "floors": [item["name"] for item in ordered]}
            per_floor = max(2, MAX_LANDMARKS // len(ordered))
            landmarks = [landmark for item in ordered
                         for landmark in self.floor_landmarks(item["id"], distances)[:per_floor]]
            return {"floor": None, "last_known": last.label if last else None, "landmarks": landmarks,
                    "how_to_ask": how + " Each option names its floor, so this one question also finds the floor."}
        floor_id = floor_id or ordered[0]["id"]
        return {
            "floor": building.floor_name(floor_id),
            "last_known": last.label if last else None,
            "landmarks": self.floor_landmarks(floor_id, distances)[:MAX_LANDMARKS],
            "how_to_ask": how,
        }

    def floor_landmarks(self, floor_id: str, distances: dict[str, float]) -> list[dict]:
        """Every landmark on one floor, nearest (by walk from the last known place) first, else rarest first."""
        building = self.building
        in_building: dict[str, int] = {}
        on_floor: dict[str, int] = {}
        for asset in building.assets.values():
            in_building[asset["type"]] = in_building.get(asset["type"], 0) + 1
            if asset["floor_id"] == floor_id:
                on_floor[asset["type"]] = on_floor.get(asset["type"], 0) + 1
        landmarks, seen = [], set()
        for asset in building.assets.values():
            if asset["floor_id"] != floor_id or on_floor[asset["type"]] > LANDMARK_MAX_PER_FLOOR:
                continue
            if (asset["type"], asset["space_id"]) in seen:
                continue
            seen.add((asset["type"], asset["space_id"]))
            landmarks.append({"kind": "thing", "label": asset["name"], "in": building.label(asset["space_id"]),
                              "space_id": asset["space_id"], "rarity": in_building[asset["type"]]})
        for connector in building.connectors.values():
            for stop_floor, stop_space in zip(connector["floor_ids"], connector["space_ids"]):
                if stop_floor == floor_id:
                    landmarks.append({"kind": connector["kind"], "label": connector["name"],
                                      "in": building.label(stop_space), "space_id": stop_space, "rarity": 1})
        for opening in building.openings.values():
            if OUTSIDE in opening["space_ids"] and opening["floor_id"] == floor_id:
                inside = self.inside_of(opening)
                landmarks.append({"kind": "entrance", "label": f"Entrance into {building.spaces[inside]['name']}",
                                  "in": building.label(inside), "space_id": inside, "rarity": 1})
        bare_names: dict[str, int] = {}
        for space in building.spaces.values():
            bare_names[bare_name(space["name"])] = bare_names.get(bare_name(space["name"]), 0) + 1
        for space in building.spaces_on(floor_id):
            bare = bare_name(space["name"])
            if bare and bare_names[bare] == 1 and space["type"] in ("room", "hall"):
                landmarks.append({"kind": "room", "label": space["name"], "in": building.label(space["id"]),
                                  "space_id": space["id"], "rarity": 1})
        for landmark in landmarks:
            walk = distances.get(landmark["space_id"])
            landmark["walk_m"] = rounded(walk) if walk is not None else None
            landmark["floor"] = building.floor_name(floor_id)
        landmarks.sort(key=lambda item: (item["walk_m"] if item["walk_m"] is not None else math.inf,
                                         item["rarity"], item["label"]))
        return [{key: value for key, value in item.items() if key != "rarity"} for item in landmarks]

    # ---------- map ----------

    def show_on_map(
        self, you_are_here: str | None = None, target: str | None = None, show_last_route: bool = False,
        floor: str | None = None,
    ) -> dict:
        """Tell the app what to draw: the person's position (a room), the target (a room or a thing) and the
        last computed route as lines per floor. Nothing is guessed: positions and lines come from the data."""
        building = self.building
        view: dict = {"you_are_here": None, "target": None, "route": None, "focus_floor_id": None}
        if you_are_here:
            space_id, point = self.place_of(you_are_here)
        elif self.position:
            space_id, point = self.position.space_id, self.position.point
        else:
            space_id = None
        if space_id:
            x, y = point or building.anchor(space_id)
            view["you_are_here"] = {"space_id": space_id, "label": building.label(space_id),
                                    "floor_id": building.spaces[space_id]["floor_id"], "position": [x, y]}
        if target:
            asset = self.target_asset(target)
            if asset:
                view["target"] = {"asset_id": asset["id"], "space_id": asset["space_id"], "label": asset["name"],
                                  "floor_id": asset["floor_id"], "position": list(asset["position"])}
            else:
                space_id = find_space(building, target)
                x, y = building.anchor(space_id)
                view["target"] = {"space_id": space_id, "label": building.label(space_id),
                                  "floor_id": building.spaces[space_id]["floor_id"], "position": [x, y]}
        if show_last_route:
            if not self.last_route:
                raise EngineError("No route computed yet: call find_route first.")
            added = tuple(self.new_openings)
            pieces = [piece for leg in self.last_route
                      for piece in building.polyline(leg, through_anchors=False, extra_openings=added)]
            view["route"] = {"length_m": rounded(sum(leg.length_m for leg in self.last_route)), "pieces": pieces}
        if floor:
            view["focus_floor_id"] = find_floor(building, floor)
        else:
            first = view["you_are_here"] or (view["route"] and {"floor_id": view["route"]["pieces"][0]["floor_id"]}) \
                or view["target"]
            view["focus_floor_id"] = first["floor_id"] if first else None
        view["changes"] = self.changes()
        self.map_view = view
        return {"shown": True, "focus_floor": building.floor_name(view["focus_floor_id"])
                if view["focus_floor_id"] else None}

    def target_asset(self, target: str) -> dict | None:
        """A thing to show: by id or name, else the nearest thing of that type ('coffee machine') to the person,
        None when the target is a room."""
        building = self.building
        asset = building.assets.get(target) or next(
            (item for item in building.assets.values() if fold(item["name"]) == fold(target)), None)
        if asset:
            return asset
        try:
            find_space(building, target)
            return None
        except NoSuchSpace:
            pass
        wanted = find_asset_type(building, target)
        found = [item for item in building.assets.values() if item["type"] == wanted]
        distances = building.distances_from(self.here, self.constraints()) if self.here else {}
        return min(found, key=lambda item: (distances.get(item["space_id"], math.inf), item["id"]))

    # ---------- conversation ----------

    def ask_user(self, question: str, options: list[dict]) -> dict:
        """Record a question with 2-4 options for the person; the app shows them as chips."""
        if not 2 <= len(options) <= 4:
            raise EngineError("Give 2 to 4 options.")
        cleaned = []
        for option in options:
            label = str(option.get("label", "")).strip()
            if not label:
                raise EngineError("Every option needs a label.")
            cleaned.append({"label": label, "description": str(option.get("description", "")).strip()})
        self.pending_question = {"question": question.strip(), "options": cleaned, "allow_free_text": True}
        return {"shown_to_user": True, "instruction": "End your turn now; the reply arrives as the next message."}

    def submit_answer(
        self,
        answer_type: str,
        value: float | None = None,
        room: str | None = None,
        include_area: bool = False,
        text: str | None = None,
    ) -> dict:
        """Record the final benchmark answer; answer_line() turns it into the scored 'Answer:' line."""
        building = self.building
        if answer_type == "number":
            if value is None or not math.isfinite(value):
                raise EngineError("A number answer needs a finite value.")
            self.submitted = {"type": "number", "value": float(value)}
        elif answer_type == "room":
            if not room:
                raise EngineError("A room answer needs the room (preferably its space id).")
            space_id = find_space(building, room)
            self.submitted = {"type": "room", "space_id": space_id, "include_area": include_area}
        elif answer_type == "text":
            if not text or not text.strip():
                raise EngineError("A text answer needs the text.")
            text = " ".join(text.split())
            if NO_ROUTE.search(text):  # one fixed wording, without room numbers a number-reading scorer could misread
                text = NO_ROUTE_ANSWER
            self.submitted = {"type": "text", "text": text}
        else:
            raise EngineError("answer_type must be 'number', 'room' or 'text'.")
        return {"recorded": self.submitted, "answer_line": self.answer_line()}

    def route_line(self) -> str | None:
        """'Route: A (Floor) → B (Floor) → … | spaces: id, id | doors and stairs: id, id' for the route found
        last (all legs of a tour), so a grader can check the route itself; None if no route was found."""
        if not self.last_route:
            return None
        spaces: list[str] = []
        elements: list[str] = []
        for leg in self.last_route:
            spaces += [space for space in leg.space_path if not spaces or spaces[-1] != space]
            elements += leg.element_path
        names = " → ".join(self.building.label(space) for space in spaces if space in self.building.spaces)
        return f"Route: {names} | spaces: {', '.join(spaces)} | doors and stairs: {', '.join(elements)}"

    def answer_line(self) -> str | None:
        """'Answer: 42.17' or 'Answer: Office 0.21, 18.40 m²', exactly as the scorer expects."""
        answer = self.submitted
        if answer is None:
            return None
        if answer["type"] == "text":
            return f"Answer: {answer['text']}"
        if answer["type"] == "number":
            value = answer["value"]
            text = str(int(value)) if float(value).is_integer() else f"{value:.2f}"
            return f"Answer: {text}"
        space = self.building.spaces[answer["space_id"]]
        name, ref = space["name"], space.get("ref")
        label = name if not ref or ref in name else f"{name} ({ref})"
        if answer.get("include_area"):  # the engine's area, never a number typed by the model
            return f"Answer: {label}, {self.building.area(answer['space_id']):.2f} m²"
        return f"Answer: {label}"
