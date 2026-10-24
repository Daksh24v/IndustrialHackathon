"""What the agent can do in one building. Plain functions that return JSON-ready dicts, so they are tested
without the API; agent.py wraps them as Claude tools. Every fact the agent states comes from here."""

import math
from dataclasses import dataclass, field

from navcore.engine import DOOR_PREFIX, OUTSIDE, Building, Constraints, EngineError, Route
from navcore.resolve import asset_types, find_element, find_floor, find_space, find_type, normalise, room_types

MAX_RESULTS = 25


def rounded(value: float) -> float:
    return round(value, 2)


@dataclass
class Session:
    """One building plus the changes made in this conversation (closures, new doors)."""

    building: Building
    closed: set[str] = field(default_factory=set)
    new_openings: list[dict] = field(default_factory=list)

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

    def reachable_rooms(
        self, start: str, floor: str, step_free: bool = False, min_width_m: float = 0.0, avoid: list[str] | None = None
    ) -> dict:
        """Which rooms on a floor can be reached from start under the constraints (corridors etc. not counted)."""
        building = self.building
        floor_id = find_floor(building, floor)
        constraints = self.constraints(step_free, min_width_m, avoid)
        rooms = building.reachable_rooms(find_space(building, start), floor_id, constraints)
        total = len(building.spaces_on(floor_id, rooms_only=True))
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

    def what_if_door(self, first: str, second: str, floor: str) -> dict:
        """Effect of a new door (middle of the shared wall) on every room's walk out of the building."""
        building = self.building
        first_id, second_id = find_space(building, first), find_space(building, second)
        floor_id = find_floor(building, floor)
        improved = building.what_if_door(first_id, second_id, floor_id)
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

