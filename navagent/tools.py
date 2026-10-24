"""What the agent can do in one building. Plain functions that return JSON-ready dicts, so they are tested
without the API; agent.py wraps them as Claude tools. Every fact the agent states comes from here."""

import math
from dataclasses import dataclass, field

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
from navcore.resolve import asset_types, find_element, find_floor, find_space, find_type, normalise, room_types

MAX_RESULTS = 25


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


@dataclass
class Session:
    """One building plus the changes made in this conversation (closures, new doors)."""

    building: Building
    closed: set[str] = field(default_factory=set)
    new_openings: list[dict] = field(default_factory=list)
    pending_question: dict | None = None  # set by ask_user; the app shows it as option chips
    submitted: dict | None = None  # set by submit_answer in benchmark mode

    def constraints(
        self, step_free: bool = False, min_width_m: float = 0.0, closed: list[str] | None = None
    ) -> Constraints:
        extra_closed = {find_element(self.building, item) for item in closed or []}
        return Constraints(
            step_free=step_free,
            min_width_m=min_width_m,
            closed=frozenset(self.closed | extra_closed),
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
        wanted = find_type(asset_type, asset_types(building))
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
        start: str,
        destination: str,
        step_free: bool = False,
        min_width_m: float = 0.0,
        via: list[str] | None = None,
        avoid: list[str] | None = None,
    ) -> dict:
        """Shortest route, optionally through stops in order; step-free / minimum door width / avoiding things."""
        building = self.building
        constraints = self.constraints(step_free, min_width_m, avoid)
        stops = [find_space(building, start), *[find_space(building, stop) for stop in via or []]]
        stops.append(find_space(building, destination))
        legs = building.tour(stops, constraints)
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
        """One followable line per room change or floor change."""
        building = self.building
        steps = []
        for previous, current, via in route.hops:
            if current.startswith(DOOR_PREFIX):
                continue
            if current == OUTSIDE:
                steps.append("Go outside through the entrance.")
            elif via in building.connectors:
                connector = building.connectors[via]
                verb = "Take" if connector["kind"] == "lift" else "Use"
                floor = building.floor_name(building.spaces[current]["floor_id"])
                steps.append(f"{verb} {connector['name']} ({connector['kind']}) to {floor}.")
            elif previous == DOOR_PREFIX + via and building.openings.get(via, {}).get("kind") == "entrance":
                steps.append(f"Come back in through the entrance into {building.label(current)}.")
            else:
                steps.append(f"Go into {building.spaces[current]['name']}.")
        return steps

    def nearest_exit(self, room: str, step_free: bool = False) -> dict:
        """Walk from a room to its nearest entrance, with this conversation's changes."""
        building = self.building
        space_id = find_space(building, room)
        distance = building.distances_from(OUTSIDE, self.constraints(step_free)).get(space_id, math.inf)
        if math.isinf(distance):
            raise EngineError(f"No way out of {building.label(space_id)} with the current constraints.")
        route = building.route(space_id, OUTSIDE, self.constraints(step_free))
        return {"from": building.label(space_id), "walk_m": rounded(distance), "steps": self.directions(route)}

    def nearest_with_asset(self, start: str, asset_type: str, step_free: bool = False) -> dict:
        building = self.building
        start_id = find_space(building, start)
        wanted = find_type(asset_type, asset_types(building))
        space_id, distance = building.nearest_space_with_asset(start_id, wanted, self.constraints(step_free))
        return {
            "asset_type": wanted,
            "nearest_room": building.label(space_id),
            "space_id": space_id,
            "walk_m": rounded(distance),
        }

    def errand_walk(self, start: str, asset_type: str, destination: str, step_free: bool = False) -> dict:
        """Walk from start to the nearest room holding an asset type, then on to the destination."""
        building = self.building
        start_id, target_id = find_space(building, start), find_space(building, destination)
        wanted = find_type(asset_type, asset_types(building))
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
        return {"element_id": element_id, "closed": closed, "all_closed": sorted(self.closed)}

    def add_door(self, first: str, second: str, width_m: float = 0.9, step_free: bool = True) -> dict:
        building = self.building
        door = building.door_between(find_space(building, first), find_space(building, second))
        door.update(width_m=width_m, step_free=step_free, id=f"{door['floor_id']}-O-new{len(self.new_openings) + 1}")
        self.new_openings.append(door)
        return {"added": door}

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

    def find_assets(self, asset_type: str, floor: str | None = None, near: str | None = None) -> dict:
        """Every thing of one type with its room and position; with `near`, sorted by walking distance."""
        building = self.building
        wanted = find_type(asset_type, asset_types(building))
        floor_id = find_floor(building, floor) if floor else None
        distances = building.distances_from(find_space(building, near)) if near else {}
        found = [
            asset
            for asset in building.assets.values()
            if asset["type"] == wanted and (floor_id is None or asset["floor_id"] == floor_id)
        ]
        if near:
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
            self.submitted = {"type": "text", "text": " ".join(text.split())}
        else:
            raise EngineError("answer_type must be 'number', 'room' or 'text'.")
        return {"recorded": self.submitted, "answer_line": self.answer_line()}

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
