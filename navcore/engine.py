"""Deterministic building engine: geometry, the route graph and every query the benchmark asks about.

The route model is the one the judges grade with, section 3 of the kit 1.1.0 brief (CHALLENGE.md) (and
starter_agent/building_map.py):
- one node per space at shapely's representative_point() (of the polygon repaired with buffer(0)), one node
  per opening at its position;
- inside a space, every pair of its nodes (centre and doors) is joined by the shortest walk that stays 15 cm
  off the walls and goes round corners; a door lands 30 cm inside the space, and the step from the door to
  its landing counts; so a corridor you pass through is walked door to door;
- stairs 2 m per metre climbed between consecutive stops; a lift ride 15 m + 1 m per metre climbed, between
  any two of its stops;
- no way round the outside: an entrance leads out of the building, not into another part of it.
"""

import itertools
import json
import math
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path

import networkx as nx
import numpy as np
import shapely
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import linemerge, nearest_points

OUTSIDE = "outside"
DEFAULT_FLOOR_HEIGHT_M = 3.0  # for a floor without elevation_m
DOOR_PREFIX = "door:"
# Vertical movement in walking metres per metre of height (the floors' elevation_m).
STAIRS_M_PER_RISE = 2.0
LIFT_FIXED_M = 15.0  # waiting and doors, once per ride
LIFT_M_PER_RISE = 1.0
# Walking inside a space: 15 cm off the walls; a door lands 30 cm inside the space.
WALL_CLEARANCE_M = 0.15
DOOR_LANDING_M = 0.30
NARROW_LANDING_M = 0.05
COVER_TOLERANCE_M = 0.02
BLOCKED_DETOUR_FACTOR = 1.5  # no clear walk between two points of a space (broken geometry)
LENGTH_DECIMALS = 3

# Defaults from the README definitions. Every one of them is a parameter of the query that uses it, so a
# question that defines things differently ("at least 2 m of wall", "halls count too") can be answered.
# "Rooms" in reachability counts are spaces of type "room".
ROOM_TYPE = "room"
ROOM_TYPES = frozenset({ROOM_TYPE})
# Shared-wall counts also include halls; corridors, stairwells, lifts and outdoor areas don't count.
WALL_NEIGHBOUR_TYPES = frozenset({"room", "hall"})
WALL_TOLERANCE_M = 0.35
MIN_SHARED_WALL_M = 1.0
WHAT_IF_IMPROVEMENT_M = 1.0
SPACE_TYPES = ("room", "corridor", "stair", "lift", "hall", "outdoor")


Point2 = tuple[float, float]


def door_landing(polygon: Polygon, position: Point2) -> Point2:
    """Where a door at `position` lands inside the space: 30 cm in from the walls."""
    inner = polygon.buffer(-DOOR_LANDING_M)
    if inner.is_empty:
        inner = polygon.buffer(-NARROW_LANDING_M)
    if inner.is_empty:
        point = polygon.representative_point()
        return (point.x, point.y)
    if inner.contains(Point(position)):
        return (position[0], position[1])
    landing = nearest_points(inner, Point(position))[0]
    return (landing.x, landing.y)


class WalkArea:
    """The walkable part of a space (15 cm off the walls) and the corners a walk can bend round."""

    def __init__(self, polygon: Polygon) -> None:
        if polygon.geom_type != "Polygon":  # an outline that only repairs into pieces: walk in the largest
            polygon = max(getattr(polygon, "geoms", [polygon]), key=lambda part: part.area)
        walkable = polygon.buffer(-WALL_CLEARANCE_M)
        if walkable.is_empty or walkable.geom_type != "Polygon":
            walkable = polygon
        self.allowed = walkable.buffer(COVER_TOLERANCE_M)
        shapely.prepare(self.allowed)
        self.corners = [corner for ring in [walkable.exterior, *walkable.interiors] for corner in list(ring.coords)[:-1]]

    def visibility(self, nodes: list[Point2]) -> np.ndarray:
        """Straight-line lengths between nodes that see each other, infinite where a wall is in the way."""
        coordinates = np.asarray(nodes, dtype=float)
        straight = np.hypot(*(coordinates[:, None, :] - coordinates[None, :, :]).transpose(2, 0, 1))
        first, second = np.triu_indices(len(nodes), k=1)
        clear = shapely.covers(self.allowed, shapely.linestrings(np.stack([coordinates[first], coordinates[second]], axis=1)))
        usable = clear | (straight[first, second] == 0)
        matrix = np.full(straight.shape, np.inf)
        np.fill_diagonal(matrix, 0.0)
        matrix[first[usable], second[usable]] = straight[first[usable], second[usable]]
        matrix[second[usable], first[usable]] = straight[first[usable], second[usable]]
        return matrix

    def lengths(self, points: list[Point2]) -> np.ndarray:
        """Shortest walks between all pairs of points (Floyd-Warshall over the points and the corners)."""
        matrix = self.visibility(list(points) + self.corners)
        for middle in range(len(matrix)):
            matrix = np.minimum(matrix, matrix[:, middle, None] + matrix[None, middle, :])
        n = len(points)
        walks = matrix[:n, :n]
        fallback = np.hypot(*(np.asarray(points)[:, None, :] - np.asarray(points)[None, :, :]).transpose(2, 0, 1))
        return np.where(np.isfinite(walks), walks, fallback * BLOCKED_DETOUR_FACTOR)

    def path(self, start: Point2, end: Point2) -> list[Point2]:
        """The walk itself, start to end, with the corners it bends round (for drawing)."""
        nodes = [start, end, *self.corners]
        matrix = self.visibility(nodes)
        graph = nx.Graph()
        rows, columns = np.nonzero(np.isfinite(matrix))
        for row, column in zip(rows, columns):
            if row < column:
                graph.add_edge(int(row), int(column), weight=float(matrix[row, column]))
        try:
            return [nodes[index] for index in nx.dijkstra_path(graph, 0, 1)]
        except (nx.NetworkXNoPath, nx.NodeNotFound):
            return [start, end]


# Walking lengths per space, shared by every Building loaded in this process (each conversation loads its own
# copy of the building): keyed by the building, the space's outline and its doors, so edits never hit a stale
# entry.
_WALKS: dict[tuple, list[tuple[str, str, float]]] = {}
_MAX_WALKS = 200_000


class EngineError(ValueError):
    """Something the user should be told about: unknown place, no route, ..."""


@dataclass(frozen=True)
class Constraints:
    """What a route may use. Defaults: anything open."""

    step_free: bool = False
    min_width_m: float = 0.0
    closed: frozenset[str] = frozenset()
    extra_openings: tuple[dict, ...] = ()
    # Space types or room types a route may pass through (a forklift: halls, corridors, storage); any other
    # space can still be where it starts or ends, never a shortcut. None: any space.
    through_types: frozenset[str] | None = None


@dataclass
class Route:
    start: str
    destination: str
    length_m: float
    nodes: list[str]
    space_path: list[str]
    element_path: list[str] = field(default_factory=list)
    # (from node, to node, how): how is the space walked through, or the stair/lift ridden
    hops: list[tuple[str, str, str]] = field(default_factory=list)
    hop_lengths: list[float] = field(default_factory=list)


def complete(data: dict) -> dict:
    """Fill in what an unseen building.json might leave out, so one missing field never stops every answer:
    names from numbers or ids, room types from the kind of space, heights from levels (3 m a floor), empty
    lists for missing parts. Stairs or lifts whose floors and spaces don't pair up are left out."""
    data.setdefault("building", {})
    info = data["building"]
    info.setdefault("id", "building")
    info.setdefault("name", info["id"])
    info.setdefault("source", "unknown")
    for key in ("floors", "spaces", "openings", "vertical_connectors", "assets"):
        data[key] = data.get(key) or []
    for index, floor in enumerate(data["floors"]):
        floor.setdefault("level", index)
        level = floor["level"]
        floor.setdefault("name", "Ground floor" if level == 0 else f"Floor {level}" if level > 0 else f"Basement {-level}")
        floor.setdefault("elevation_m", DEFAULT_FLOOR_HEIGHT_M * level)
    for space in data["spaces"]:
        space.setdefault("type", "room")
        space.setdefault("room_type", space["type"])
        space["name"] = space.get("name") or space.get("ref") or space["id"]
    for opening in data["openings"]:
        opening.setdefault("kind", "door")
    connectors = []
    for index, connector in enumerate(data["vertical_connectors"]):
        if len(connector.get("floor_ids") or []) != len(connector.get("space_ids") or []):
            continue
        connector.setdefault("kind", "stairs")
        connector.setdefault("name", f"{connector['kind'].capitalize()} {index + 1}")
        connectors.append(connector)
    data["vertical_connectors"] = connectors
    for asset in data["assets"]:
        asset.setdefault("type", "thing")
        asset["name"] = asset.get("name") or asset["type"].replace("_", " ")
    return data


class Building:
    def __init__(self, data: dict) -> None:
        data = complete(data)
        self.data = data
        self.info = data["building"]
        self.floors = {floor["id"]: floor for floor in data["floors"]}
        self.spaces = {space["id"]: space for space in data["spaces"]}
        self.openings = {opening["id"]: opening for opening in data["openings"]}
        self.connectors = {connector["id"]: connector for connector in data["vertical_connectors"]}
        self.assets = {asset["id"]: asset for asset in data["assets"]}
        self._graphs: dict[Constraints, nx.MultiGraph] = {}
        self._walks: dict[tuple, list[tuple[str, str, float]]] = {}
        self._areas: dict[str, WalkArea] = {}

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
        """The floor at a level; with two (a mezzanine), the lower one."""
        found = [floor for floor in self.floors.values() if floor["level"] == level]
        if not found:
            raise EngineError(f"No floor at level {level}.")
        return min(found, key=lambda floor: floor["elevation_m"])["id"]

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
        point = self.polygons[space_id].representative_point()
        return (point.x, point.y)

    def centroid_3d(self, space_id: str) -> tuple[float, float, float]:
        centroid = self.polygons[space_id].centroid
        return (centroid.x, centroid.y, self.floors[self.spaces[space_id]["floor_id"]]["elevation_m"])

    def shared_wall(self, first: str, second: str, tolerance_m: float = WALL_TOLERANCE_M) -> LineString | None:
        """The part of first's outline that runs within tolerance_m of second's outline."""
        near = self.polygons[second].exterior.buffer(tolerance_m)
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

    def shared_wall_length(self, first: str, second: str, tolerance_m: float = WALL_TOLERANCE_M) -> float:
        near = self.polygons[second].exterior.buffer(tolerance_m)
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

    def walk_area(self, space_id: str) -> WalkArea:
        if space_id not in self._areas:
            self._areas[space_id] = WalkArea(self.polygons[space_id])
        return self._areas[space_id]

    def node_point(self, node: str, extra_openings: tuple[dict, ...] = ()) -> tuple[str, Point2]:
        """(floor id, position) of a graph node."""
        if node.startswith(DOOR_PREFIX):
            opening_id = node.removeprefix(DOOR_PREFIX)
            opening = self.openings.get(opening_id) or next(o for o in extra_openings if o["id"] == opening_id)
            return opening["floor_id"], (opening["position"][0], opening["position"][1])
        return self.spaces[node]["floor_id"], self.anchor(node)

    def landing(self, space_id: str, node: str, extra_openings: tuple[dict, ...] = ()) -> Point2:
        """Where a node is walked from inside a space: a door's landing, or the space's centre point."""
        if node == space_id:
            return self.anchor(space_id)
        return door_landing(self.polygons[space_id], self.node_point(node, extra_openings)[1])

    def space_walks(self, space_id: str, extra_openings: tuple[dict, ...] = ()) -> list[tuple[str, str, float]]:
        """Walking lengths inside a space between its centre point and each of its doors, and door to door."""
        doors = [opening for opening in [*self.openings.values(), *extra_openings] if space_id in opening["space_ids"]]
        key = (self.info.get("id"), space_id, tuple(map(tuple, self.spaces[space_id]["polygon"])),
               tuple((door["id"], *door["position"]) for door in doors))
        if key not in self._walks and key in _WALKS:
            self._walks[key] = _WALKS[key]
        if key not in self._walks:
            members = [(space_id, self.anchor(space_id), 0.0)]
            for door in doors:
                position = (door["position"][0], door["position"][1])
                landing = door_landing(self.polygons[space_id], position)
                members.append((DOOR_PREFIX + door["id"], landing, math.dist(landing, position)))
            lengths = self.walk_area(space_id).lengths([landing for _, landing, _ in members])
            self._walks[key] = [
                (members[first][0], members[second][0], float(lengths[first, second]) + members[first][2] + members[second][2])
                for first, second in itertools.combinations(range(len(members)), 2)
            ]
            if len(_WALKS) < _MAX_WALKS:
                _WALKS[key] = self._walks[key]
        return self._walks[key]

    def _build_graph(self, constraints: Constraints) -> nx.MultiGraph:
        # MultiGraph: a stair and a lift may join the same two spaces, two doors the same two rooms.
        graph = nx.MultiGraph()
        open_spaces = [space_id for space_id in self.spaces if space_id not in constraints.closed]
        graph.add_nodes_from(open_spaces)
        open_doors = {
            DOOR_PREFIX + opening["id"]
            for opening in [*self.openings.values(), *constraints.extra_openings]
            if self._opening_allowed(opening, constraints)
        }
        pockets: dict[str, list[tuple[str, float]]] = {}  # spaces only to start or end in: centre -> doors
        for space_id in open_spaces:
            through = self.passes_through(space_id, constraints)
            for first, second, length in self.space_walks(space_id, constraints.extra_openings):
                if (first == space_id or first in open_doors) and second in open_doors:
                    if through:
                        graph.add_edge(first, second, weight=round(length, LENGTH_DECIMALS), via=space_id)
                    elif first == space_id:
                        pockets.setdefault(space_id, []).append((second, round(length, LENGTH_DECIMALS)))
        graph.graph["pockets"] = pockets
        elevations = {floor_id: floor["elevation_m"] for floor_id, floor in self.floors.items()}
        for connector in self.connectors.values():
            if connector["id"] in constraints.closed:
                continue
            if constraints.step_free and not connector.get("step_free", connector["kind"] == "lift"):
                continue
            stops = sorted(
                zip(connector["floor_ids"], connector["space_ids"], strict=True), key=lambda stop: self.level(stop[0])
            )
            # A lift ride pays its 15 m once however many floors it passes: every pair of stops is one ride.
            is_lift = connector["kind"] == "lift"
            for (low_floor, low_space), (high_floor, high_space) in (
                itertools.combinations(stops, 2) if is_lift else itertools.pairwise(stops)
            ):
                if low_space not in graph or high_space not in graph:
                    continue
                rise = abs(elevations[high_floor] - elevations[low_floor])
                cost = LIFT_FIXED_M + LIFT_M_PER_RISE * rise if is_lift else STAIRS_M_PER_RISE * rise
                graph.add_edge(low_space, high_space, weight=round(cost, LENGTH_DECIMALS), via=connector["id"])
        return graph

    def passes_through(self, space_id: str, constraints: Constraints) -> bool:
        types = constraints.through_types
        space = self.spaces[space_id]
        return types is None or space["type"] in types or space.get("room_type") in types

    @staticmethod
    def _with_ends(graph: nx.MultiGraph, *spaces: str) -> nx.MultiGraph:
        """The graph with these spaces joined to their doors, when they are only to start or end in."""
        pockets = graph.graph.get("pockets", {})
        wanted = [space_id for space_id in spaces if space_id in pockets]
        if not wanted:
            return graph
        graph = graph.copy()
        for space_id in wanted:
            for door, length in pockets[space_id]:
                graph.add_edge(space_id, door, weight=length, via=space_id)
        return graph

    def exits(self, constraints: Constraints = Constraints()) -> list[str]:
        """Door nodes of the entrances that are open under the constraints."""
        return [
            DOOR_PREFIX + opening["id"]
            for opening in [*self.openings.values(), *constraints.extra_openings]
            if OUTSIDE in opening["space_ids"] and self._opening_allowed(opening, constraints)
        ]

    def distances_from(self, source: str, constraints: Constraints = Constraints()) -> dict[str, float]:
        graph = self._with_ends(self.graph(constraints), source)
        if source not in graph:
            return {}
        distances = nx.single_source_dijkstra_path_length(graph, source, weight="weight")
        for space_id, doors in graph.graph.get("pockets", {}).items():  # reached as a destination
            if space_id != source:
                reach = [distances[door] + length for door, length in doors if door in distances]
                if reach:
                    distances[space_id] = min(reach)
        return distances

    def _route(self, graph: nx.MultiGraph, start: str, destination: str, length: float, nodes: list[str]) -> Route:
        elements: list[str] = []
        spaces: list[str] = []
        hops = []
        hop_lengths = []
        for index, node in enumerate(nodes):
            how = None
            if index:
                edge = min(graph[nodes[index - 1]][node].values(), key=lambda candidate: candidate["weight"])
                how = edge["via"]
                hops.append((nodes[index - 1], node, how))
                hop_lengths.append(edge["weight"])
                if how in self.connectors:  # once per flight or ride
                    elements.append(how)
            if node.startswith(DOOR_PREFIX):
                elements.append(node.removeprefix(DOOR_PREFIX))
            for space_id in (how if how in self.spaces else None, None if node.startswith(DOOR_PREFIX) else node):
                if space_id is not None and (not spaces or spaces[-1] != space_id):
                    spaces.append(space_id)
        return Route(start=start, destination=destination, length_m=length, nodes=nodes, space_path=spaces,
                     element_path=elements, hops=hops, hop_lengths=hop_lengths)

    def route(self, start: str, destination: str, constraints: Constraints = Constraints()) -> Route:
        graph = self._with_ends(self.graph(constraints), start, destination)
        try:
            length, nodes = nx.single_source_dijkstra(graph, start, destination, weight="weight")
        except (nx.NetworkXNoPath, nx.NodeNotFound) as error:
            raise EngineError(f"No route from {self.label(start)} to {self.label(destination)}.") from error
        return self._route(graph, start, destination, length, nodes)

    def exit_route(self, start: str, constraints: Constraints = Constraints()) -> Route:
        """The walk from a space out of the building through its nearest open entrance."""
        graph = self._with_ends(self.graph(constraints), start)
        exits = [door for door in self.exits(constraints) if door in graph]
        try:
            length, nodes = nx.multi_source_dijkstra(graph, exits, target=start, weight="weight")
        except (nx.NetworkXNoPath, nx.NodeNotFound, ValueError) as error:
            raise EngineError(f"No way out of {self.label(start)}.") from error
        nodes = nodes[::-1]
        return self._route(graph, start, nodes[-1], length, nodes)

    def why_detour(self, start: str, destination: str, constraints: Constraints) -> dict:
        """Why the route under these constraints is not the plain walk: what the walk would use that isn't
        allowed (stairs, a narrow door, something closed, a space it can't pass through), and the metres the
        detour adds (None when there is no way at all)."""
        plain = Constraints(extra_openings=constraints.extra_openings)
        try:
            walk = self.route(start, destination, plain)
        except EngineError:
            return {"reasons": [], "extra_m": None, "walk_m": None}
        reasons = []
        openings = {o["id"]: o for o in [*self.openings.values(), *constraints.extra_openings]}
        for element in walk.element_path:
            if element in constraints.closed:
                reasons.append(f"{self.element_name(element)} is closed or out of service")
            elif element in self.connectors:
                connector = self.connectors[element]
                if constraints.step_free and not connector.get("step_free", connector["kind"] == "lift"):
                    reasons.append(f"{connector['name']} ({connector['kind']}) is not step-free")
            elif element in openings:
                opening = openings[element]
                if constraints.step_free and not opening.get("step_free", True):
                    reasons.append(f"{self.element_name(element)} has a step")
                elif (opening.get("width_m") or 0.0) < constraints.min_width_m - 1e-9:
                    reasons.append(f"{self.element_name(element)} is only {opening.get('width_m') or 0:.2f} m wide "
                                   f"(needs {constraints.min_width_m:.2f} m)")
        for space_id in walk.space_path[1:-1]:
            if space_id in constraints.closed:
                reasons.append(f"{self.label(space_id)} is closed")
            elif not self.passes_through(space_id, constraints):
                reasons.append(f"it can't pass through {self.label(space_id)}")
        reasons = list(dict.fromkeys(reasons))
        try:
            length = self.route(start, destination, constraints).length_m
        except EngineError:
            return {"reasons": reasons, "extra_m": None, "walk_m": round(walk.length_m, 1)}
        return {"reasons": reasons if length > walk.length_m + 0.05 else [],
                "extra_m": round(max(length - walk.length_m, 0.0), 1), "walk_m": round(walk.length_m, 1)}

    def element_name(self, element_id: str) -> str:
        if element_id in self.connectors:
            return self.connectors[element_id]["name"]
        if element_id in self.openings:
            opening = self.openings[element_id]
            rooms = " and ".join(self.spaces[s]["name"] for s in opening["space_ids"] if s in self.spaces)
            return f"the {opening.get('kind', 'door')} {'to' if opening.get('kind') == 'entrance' else 'between'} {rooms}"
        if element_id in self.spaces:
            return self.label(element_id)
        return element_id

    def polyline(self, route: Route, through_anchors: bool = True, extra_openings: tuple[dict, ...] = ()) -> list[dict]:
        """The route as lines to draw, one piece per floor, along the walk itself: door -> its landing ->
        the corners the walk bends round -> landing -> door. A stair or lift ends one piece and starts the next
        on the other floor; each piece says which connector leads onward. The lines' length is the route
        length minus the stair and lift costs. (through_anchors is kept for callers; routes now only pass a
        centre point where they start, end or take a stair or lift, so both ways draw the same line.)"""
        pieces: list[dict] = []
        start_floor, start_point = self.node_point(route.nodes[0], extra_openings)
        pieces.append({"floor_id": start_floor, "points": [list(start_point)], "then": None})
        for previous, current, how in route.hops:
            floor_id, point = self.node_point(current, extra_openings)
            last = pieces[-1]
            if how in self.connectors:
                connector = self.connectors[how]
                last["then"] = {"kind": connector["kind"], "via": how, "name": connector["name"], "to_floor_id": floor_id}
                pieces.append({"floor_id": floor_id, "points": [list(point)], "then": None})
                continue
            last["points"].extend(list(p) for p in self.hop_points(previous, current, how, extra_openings)[1:])
        for piece in pieces:  # a door's landing can be the door itself, a centre point its own landing
            cleaned = [piece["points"][0]]
            for point in piece["points"][1:]:
                if math.dist(point, cleaned[-1]) > 1e-9:
                    cleaned.append(point)
            piece["points"] = cleaned
        return pieces

    def hop_points(
        self, previous: str, current: str, space_id: str, extra_openings: tuple[dict, ...] = ()
    ) -> list[tuple[float, float]]:
        """The walk of one hop through a space, as drawn: from one node, via its landing and the corners the
        walk bends round, to the next node."""
        start = self.node_point(previous, extra_openings)[1]
        end = self.node_point(current, extra_openings)[1]
        walk = self.walk_area(space_id).path(self.landing(space_id, previous, extra_openings),
                                             self.landing(space_id, current, extra_openings))
        return [tuple(start), *(tuple(p) for p in walk), tuple(end)]

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

    def reachable_rooms(
        self, start: str, floor_id: str, constraints: Constraints = Constraints(), types: frozenset[str] = ROOM_TYPES
    ) -> list[str]:
        distances = self.distances_from(start, constraints)
        return [space["id"] for space in self.spaces_on(floor_id) if space["type"] in types and space["id"] in distances]

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

    def wall_neighbours(
        self,
        space_id: str,
        min_length_m: float = MIN_SHARED_WALL_M,
        tolerance_m: float = WALL_TOLERANCE_M,
        types: frozenset[str] = WALL_NEIGHBOUR_TYPES,
    ) -> list[str]:
        """Spaces of the given types on the same floor with at least min_length_m of this space's outline
        within tolerance_m of theirs (walls have thickness)."""
        floor_id = self.spaces[space_id]["floor_id"]
        polygon = self.polygons[space_id]
        neighbours = []
        for other in self.spaces_on(floor_id):
            if other["id"] == space_id or other["type"] not in types:
                continue
            if self.polygons[other["id"]].distance(polygon) > tolerance_m:
                continue
            if self.shared_wall_length(space_id, other["id"], tolerance_m) >= min_length_m:
                neighbours.append(other["id"])
        return neighbours

    def straight_line_3d(self, first: str, second: str) -> float:
        return math.dist(self.centroid_3d(first), self.centroid_3d(second))

    def door_between(self, first: str, second: str, along: float = 0.5) -> dict:
        """A new door on the wall the two spaces share, at `along` (0..1) of its length; 0.5 is the middle."""
        wall = self.shared_wall(first, second)
        if wall is None:
            raise EngineError(f"{self.label(first)} and {self.label(second)} don't share a wall.")
        middle = wall.interpolate(min(max(along, 0.0), 1.0), normalized=True)
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
        """Walk from every place to its nearest open entrance (out of the building)."""
        graph = self.graph(constraints)
        exits = [door for door in self.exits(constraints) if door in graph]
        if not exits:
            return {}
        return nx.multi_source_dijkstra_path_length(graph, exits, weight="weight")

    def what_if_door(
        self,
        first: str,
        second: str,
        floor_id: str,
        threshold_m: float = WHAT_IF_IMPROVEMENT_M,
        types: frozenset[str] = ROOM_TYPES,
        constraints: Constraints = Constraints(),
    ) -> list[str]:
        """Spaces of the given types on floor_id whose walk to the nearest entrance gets shorter by more than
        threshold_m once a door is added in the middle of the wall first and second share."""
        before = self.distances_to_exit(constraints)
        door = self.door_between(first, second)
        after = self.distances_to_exit(
            Constraints(constraints.step_free, constraints.min_width_m, constraints.closed, (door,))
        )
        improved = []
        for space in self.spaces_on(floor_id):
            if space["type"] not in types:
                continue
            new = after.get(space["id"])
            if new is None:
                continue
            old = before.get(space["id"], math.inf)
            if old - new > threshold_m:
                improved.append(space["id"])
        return improved

