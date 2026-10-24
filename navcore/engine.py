"""Deterministic building engine: geometry, the route graph and every query the benchmark asks about.

The route model is the one in README section 3 (and starter_agent/building_map.py):
- one node per space at shapely's representative_point(), one node per opening at its position;
- space <-> opening edges weighted by straight-line distance;
- stairs 12 m per floor, lifts 15 m wait + 6 m per floor, between consecutive stops;
- all entrances meet at one "outside" node at zero cost.
"""

import itertools
import json
import math
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path

import networkx as nx
from shapely.geometry import LineString, Polygon
from shapely.ops import linemerge

OUTSIDE = "outside"
DOOR_PREFIX = "door:"
STAIRS_COST_PER_FLOOR_M = 12.0
LIFT_WAIT_COST_M = 15.0
LIFT_COST_PER_FLOOR_M = 6.0

# "Rooms" in reachability counts are spaces of type "room" (calibrated on train/dev answers).
ROOM_TYPE = "room"
# Shared-wall counts also include halls; corridors, stairwells, lifts and outdoor areas don't count.
WALL_NEIGHBOUR_TYPES = frozenset({"room", "hall"})
WALL_TOLERANCE_M = 0.35
MIN_SHARED_WALL_M = 1.0
WHAT_IF_IMPROVEMENT_M = 1.0


class EngineError(ValueError):
    """Something the user should be told about: unknown place, no route, ..."""


@dataclass(frozen=True)
class Constraints:
    """What a route may use. Defaults: anything open."""

    step_free: bool = False
    min_width_m: float = 0.0
    closed: frozenset[str] = frozenset()
    extra_openings: tuple[dict, ...] = ()


@dataclass
class Route:
    start: str
    destination: str
    length_m: float
    nodes: list[str]
    space_path: list[str]
    element_path: list[str] = field(default_factory=list)
    hops: list[tuple[str, str, str]] = field(default_factory=list)  # (from node, to node, opening/connector)


class Building:
    def __init__(self, data: dict) -> None:
        self.data = data
        self.info = data["building"]
        self.floors = {floor["id"]: floor for floor in data["floors"]}
        self.spaces = {space["id"]: space for space in data["spaces"]}
        self.openings = {opening["id"]: opening for opening in data["openings"]}
        self.connectors = {connector["id"]: connector for connector in data["vertical_connectors"]}
        self.assets = {asset["id"]: asset for asset in data["assets"]}
        self._graphs: dict[Constraints, nx.MultiGraph] = {}

    @classmethod
    def load(cls, path: Path | str) -> "Building":
        path = Path(path)
        building_file = path / "building.json" if path.is_dir() else path
        return cls(json.loads(building_file.read_text(encoding="utf-8")))

    # ---------- basics ----------

    @property
    def id(self) -> str:
        return self.info["id"]

    def level(self, floor_id: str) -> int:
        return self.floors[floor_id]["level"]

    def floor_by_level(self, level: int) -> str:
        for floor in self.floors.values():
            if floor["level"] == level:
                return floor["id"]
        raise EngineError(f"No floor at level {level}.")

    def floor_name(self, floor_id: str) -> str:
        return self.floors[floor_id]["name"]

    def spaces_on(self, floor_id: str, rooms_only: bool = False) -> list[dict]:
        return [
            space
            for space in self.spaces.values()
            if space["floor_id"] == floor_id and (not rooms_only or space["type"] == ROOM_TYPE)
        ]

    def label(self, space_id: str) -> str:
        space = self.spaces[space_id]
        return f"{space['name']} ({self.floor_name(space['floor_id'])})"

    # ---------- geometry ----------

    @cached_property
    def polygons(self) -> dict[str, Polygon]:
        result = {}
        for space_id, space in self.spaces.items():
            polygon = Polygon(space["polygon"])
            if not polygon.is_valid:
                polygon = polygon.buffer(0)
            result[space_id] = polygon
        return result

    def area(self, space_id: str) -> float:
        return self.polygons[space_id].area

    def anchor(self, space_id: str) -> tuple[float, float]:
        point = Polygon(self.spaces[space_id]["polygon"]).representative_point()
        return (point.x, point.y)

    def centroid_3d(self, space_id: str) -> tuple[float, float, float]:
        centroid = self.polygons[space_id].centroid
        return (centroid.x, centroid.y, self.floors[self.spaces[space_id]["floor_id"]]["elevation_m"])

    def shared_wall(self, first: str, second: str) -> LineString | None:
        """The part of first's outline that runs within WALL_TOLERANCE_M of second's outline."""
        near = self.polygons[second].exterior.buffer(WALL_TOLERANCE_M)
        shared = self.polygons[first].exterior.intersection(near)
        if shared.is_empty or shared.length == 0:
            return None
        if shared.geom_type == "LineString":
            return shared
        lines = [geometry for geometry in getattr(shared, "geoms", []) if geometry.length > 0]
        merged = linemerge(lines) if lines else None
        if merged is None or merged.is_empty:
            return None
        if merged.geom_type == "LineString":
            return merged
        return max(merged.geoms, key=lambda line: line.length)

    def shared_wall_length(self, first: str, second: str) -> float:
        near = self.polygons[second].exterior.buffer(WALL_TOLERANCE_M)
        return self.polygons[first].exterior.intersection(near).length

    # ---------- graph ----------

    def graph(self, constraints: Constraints = Constraints()) -> nx.MultiGraph:
        if constraints.extra_openings:  # what-if edits are one-off; dicts aren't hashable anyway
            return self._build_graph(constraints)
        if constraints not in self._graphs:
            self._graphs[constraints] = self._build_graph(constraints)
        return self._graphs[constraints]

    def _opening_allowed(self, opening: dict, constraints: Constraints) -> bool:
        if opening["id"] in constraints.closed:
            return False
        if constraints.step_free and not opening.get("step_free", True):
            return False
        return (opening.get("width_m") or 0.0) >= constraints.min_width_m - 1e-9

    def _build_graph(self, constraints: Constraints) -> nx.MultiGraph:
        graph = nx.MultiGraph()
        anchors = {
            space_id: self.anchor(space_id) for space_id in self.spaces if space_id not in constraints.closed
        }
        graph.add_nodes_from(anchors)
        for opening in [*self.openings.values(), *constraints.extra_openings]:
            if not self._opening_allowed(opening, constraints):
                continue
            door = DOOR_PREFIX + opening["id"]
            for space_id in opening["space_ids"]:
                if space_id == OUTSIDE:
                    graph.add_edge(OUTSIDE, door, weight=0.0, via=opening["id"])
                elif space_id in anchors:
                    graph.add_edge(
                        space_id, door, weight=math.dist(anchors[space_id], opening["position"]), via=opening["id"]
                    )
        for connector in self.connectors.values():
            if connector["id"] in constraints.closed:
                continue
            if constraints.step_free and not connector.get("step_free", connector["kind"] == "lift"):
                continue
            stops = sorted(
                zip(connector["floor_ids"], connector["space_ids"], strict=True), key=lambda stop: self.level(stop[0])
            )
            for (low_floor, low_space), (high_floor, high_space) in itertools.pairwise(stops):
                if low_space not in anchors or high_space not in anchors:
                    continue
                span = abs(self.level(high_floor) - self.level(low_floor))
                if connector["kind"] == "lift":
                    cost = LIFT_WAIT_COST_M + LIFT_COST_PER_FLOOR_M * span
                else:
                    cost = STAIRS_COST_PER_FLOOR_M * span
                graph.add_edge(low_space, high_space, weight=cost, via=connector["id"])
        return graph

    def distances_from(self, source: str, constraints: Constraints = Constraints()) -> dict[str, float]:
        graph = self.graph(constraints)
        if source not in graph:
            return {}
        return nx.single_source_dijkstra_path_length(graph, source, weight="weight")

    def route(self, start: str, destination: str, constraints: Constraints = Constraints()) -> Route:
        graph = self.graph(constraints)
        try:
            length, nodes = nx.single_source_dijkstra(graph, start, destination, weight="weight")
        except (nx.NetworkXNoPath, nx.NodeNotFound) as error:
            raise EngineError(f"No route from {self.label(start)} to {self.label(destination)}.") from error
        elements = []
        hops = []
        for previous, current in itertools.pairwise(nodes):
            edge = min(graph[previous][current].values(), key=lambda candidate: candidate["weight"])
            hops.append((previous, current, edge["via"]))
            if not elements or elements[-1] != edge["via"]:
                elements.append(edge["via"])
        return Route(
            start=start,
            destination=destination,
            length_m=length,
            nodes=nodes,
            space_path=[node for node in nodes if not node.startswith(DOOR_PREFIX) and node != OUTSIDE],
            element_path=elements,
            hops=hops,
        )

    def tour(self, stops: list[str], constraints: Constraints = Constraints()) -> list[Route]:
        return [self.route(first, second, constraints) for first, second in itertools.pairwise(stops)]

    # ---------- benchmark queries ----------

    def rooms_of_type(self, floor_id: str, room_type: str) -> list[str]:
        return [space["id"] for space in self.spaces_on(floor_id) if space["room_type"] == room_type]

    def largest_room(self, floor_id: str, room_type: str) -> tuple[str, float]:
        candidates = self.rooms_of_type(floor_id, room_type)
        if not candidates:
            raise EngineError(f"No {room_type} on {self.floor_name(floor_id)}.")
        best = max(candidates, key=self.area)
        return best, self.area(best)

    def floor_area_total(self, floor_id: str, room_type: str) -> float:
        return sum(self.area(space_id) for space_id in self.rooms_of_type(floor_id, room_type))

    def nearest_space_with_asset(
        self, start: str, asset_type: str, constraints: Constraints = Constraints()
    ) -> tuple[str, float]:
        holders = {asset["space_id"] for asset in self.assets.values() if asset["type"] == asset_type}
        if not holders:
            raise EngineError(f"No {asset_type} in the building.")
        distances = self.distances_from(start, constraints)
        reachable = [(distances[space_id], space_id) for space_id in holders if space_id in distances]
        if not reachable:
            raise EngineError(f"No reachable room has a {asset_type}.")
        distance, space_id = min(reachable)
        return space_id, distance

    def errand(
        self, start: str, asset_type: str, target: str, constraints: Constraints = Constraints()
    ) -> tuple[str, float]:
        via, first_leg = self.nearest_space_with_asset(start, asset_type, constraints)
        second_leg = self.distances_from(via, constraints).get(target)
        if second_leg is None:
            raise EngineError(f"No route from {self.label(via)} to {self.label(target)}.")
        return via, first_leg + second_leg

    def reachable_rooms(self, start: str, floor_id: str, constraints: Constraints = Constraints()) -> list[str]:
        distances = self.distances_from(start, constraints)
        return [space["id"] for space in self.spaces_on(floor_id, rooms_only=True) if space["id"] in distances]

    def stacked_room(self, space_id: str, direction: str) -> str | None:
        """The space on the next floor up/down whose outline covers most of this room's outline.
        'Next' is the next floor that exists: in a building with levels -2, 0, 1 the floor below 0 is -2."""
        level = self.level(self.spaces[space_id]["floor_id"])
        levels = sorted({floor["level"] for floor in self.floors.values()})
        candidates = [other for other in levels if (other > level if direction == "above" else other < level)]
        if not candidates:
            return None
        floor_id = self.floor_by_level(min(candidates) if direction == "above" else max(candidates))
        polygon = self.polygons[space_id]
        overlaps = [
            (self.polygons[other["id"]].intersection(polygon).area, other["id"]) for other in self.spaces_on(floor_id)
        ]
        overlaps = [item for item in overlaps if item[0] > 0]
        return max(overlaps)[1] if overlaps else None

    def wall_neighbours(self, space_id: str) -> list[str]:
        floor_id = self.spaces[space_id]["floor_id"]
        polygon = self.polygons[space_id]
        neighbours = []
        for other in self.spaces_on(floor_id):
            if other["id"] == space_id or other["type"] not in WALL_NEIGHBOUR_TYPES:
                continue
            if self.polygons[other["id"]].distance(polygon) > WALL_TOLERANCE_M:
                continue
            if self.shared_wall_length(space_id, other["id"]) >= MIN_SHARED_WALL_M:
                neighbours.append(other["id"])
        return neighbours

    def straight_line_3d(self, first: str, second: str) -> float:
        return math.dist(self.centroid_3d(first), self.centroid_3d(second))

    def door_between(self, first: str, second: str) -> dict:
        """A new door in the middle of the wall the two spaces share."""
        wall = self.shared_wall(first, second)
        if wall is None:
            raise EngineError(f"{self.label(first)} and {self.label(second)} don't share a wall.")
        middle = wall.interpolate(0.5, normalized=True)
        return {
            "id": f"new-door:{first}:{second}",
            "floor_id": self.spaces[first]["floor_id"],
            "space_ids": [first, second],
            "kind": "door",
            "position": [middle.x, middle.y],
            "width_m": 0.9,
            "step_free": True,
            "synthetic": True,
        }

    def distances_to_exit(self, constraints: Constraints = Constraints()) -> dict[str, float]:
        return self.distances_from(OUTSIDE, constraints)

    def what_if_door(self, first: str, second: str, floor_id: str) -> list[str]:
        """Rooms on floor_id whose walk to the nearest entrance gets shorter by more than 1 m."""
        before = self.distances_to_exit()
        door = self.door_between(first, second)
        after = self.distances_to_exit(Constraints(extra_openings=(door,)))
        improved = []
        for space in self.spaces_on(floor_id, rooms_only=True):
            new = after.get(space["id"])
            if new is None:
                continue
            old = before.get(space["id"], math.inf)
            if old - new > WHAT_IF_IMPROVEMENT_M:
                improved.append(space["id"])
        return improved

