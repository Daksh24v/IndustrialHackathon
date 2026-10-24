"""Accuracy checks that don't use the dataset's answers, so they also run on the test buildings (no
answers there) and on transformed copies of buildings.

- an independent plain-Python implementation of areas and the route model must agree with navcore;
- moving, renaming, reordering or re-winding a building must not change any answer;
- route properties that must always hold (symmetry, triangle inequality, constraints never help)."""

import copy
import csv
import heapq
import itertools
import math
import random

import pytest
from shapely.geometry import Polygon

from holdout.split import BUILD_LIST, read
from navcore.engine import OUTSIDE, Building, Constraints, EngineError
from tests.conftest import DATA

PER_SOURCE = 3


def sample_buildings() -> list:
    """A few build buildings and a few test buildings per source (fixed seed)."""
    with (DATA / "manifest.csv").open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    build = read(BUILD_LIST)
    rng = random.Random(7)
    picked = []
    for split in ("build", "test"):
        for source in sorted({row["source"] for row in rows}):
            pool = [row for row in rows if row["source"] == source
                    and (row["building_id"] in build if split == "build" else row["split"] == "test")]
            picked += rng.sample(pool, min(PER_SOURCE, len(pool)))
    return [DATA / row["path"] for row in picked]


SAMPLE = sample_buildings()
_cache: dict = {}


def load(path) -> Building:
    if path not in _cache:
        _cache[path] = Building.load(path)
    return _cache[path]


def shoelace(points) -> float:
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(points, points[1:] + points[:1]))) / 2


def plain_dijkstra(building: Building, source: str, step_free: bool = False) -> dict[str, float]:
    """The README route model written again from scratch: adjacency lists and heapq, no networkx."""
    adjacency: dict[str, list[tuple[str, float]]] = {}

    def link(a, b, cost):
        adjacency.setdefault(a, []).append((b, cost))
        adjacency.setdefault(b, []).append((a, cost))

    anchors = {space_id: building.anchor(space_id) for space_id in building.spaces}
    for opening in building.data["openings"]:
        if step_free and not opening.get("step_free", True):
            continue
        door = "D" + opening["id"]
        for space_id in opening["space_ids"]:
            if space_id == OUTSIDE:
                link(OUTSIDE, door, 0.0)
            elif space_id in anchors:
                link(space_id, door, math.dist(anchors[space_id], opening["position"]))
    levels = {floor["id"]: floor["level"] for floor in building.data["floors"]}
    for connector in building.data["vertical_connectors"]:
        if step_free and not connector.get("step_free", connector["kind"] == "lift"):
            continue
        stops = sorted(zip(connector["floor_ids"], connector["space_ids"]), key=lambda stop: levels[stop[0]])
        for (floor_a, space_a), (floor_b, space_b) in zip(stops, stops[1:]):
            if space_a not in anchors or space_b not in anchors:
                continue
            span = abs(levels[floor_b] - levels[floor_a])
            link(space_a, space_b, 15.0 + 6.0 * span if connector["kind"] == "lift" else 12.0 * span)
    best = {source: 0.0}
    queue = [(0.0, source)]
    while queue:
        distance, node = heapq.heappop(queue)
        if distance > best.get(node, math.inf):
            continue
        for neighbour, cost in adjacency.get(node, []):
            if distance + cost < best.get(neighbour, math.inf) - 1e-12:
                best[neighbour] = distance + cost
                heapq.heappush(queue, (distance + cost, neighbour))
    return {node: value for node, value in best.items() if not node.startswith("D")}


@pytest.mark.parametrize("path", SAMPLE, ids=lambda path: path.name)
def test_independent_areas_agree(path):
    building = load(path)
    for space in building.data["spaces"]:
        if Polygon(space["polygon"]).is_valid:  # invalid outlines are repaired by navcore, so skip those
            assert building.area(space["id"]) == pytest.approx(shoelace(space["polygon"]), rel=1e-6, abs=1e-6)


@pytest.mark.parametrize("path", SAMPLE, ids=lambda path: path.name)
@pytest.mark.parametrize("step_free", [False, True])
def test_independent_router_agrees(path, step_free):
    building = load(path)
    rng = random.Random(path.name)
    sources = rng.sample(sorted(building.spaces), min(4, len(building.spaces)))
    for source in sources:
        expected = plain_dijkstra(building, source, step_free)
        actual = building.distances_from(source, Constraints(step_free=step_free))
        spaces = set(building.spaces) | {OUTSIDE}
        assert {n for n in actual if n in spaces} == {n for n in expected if n in spaces}
        for node, value in expected.items():
            assert actual[node] == pytest.approx(value, abs=1e-6)


# ---------- invariance ----------

def answers(building: Building, rng_seed: str) -> dict:
    """A fingerprint of everything the benchmark asks, keyed by names (not ids) so renaming can be compared."""
    rng = random.Random(rng_seed)
    label = {space_id: (space["name"], building.level(space["floor_id"])) for space_id, space in building.spaces.items()}
    rooms = sorted((s for s in building.spaces.values() if s["type"] == "room"), key=lambda s: label[s["id"]])
    picks = rng.sample(rooms, min(6, len(rooms)))
    result = {}
    for space in picks:
        space_id = space["id"]
        result[("area", label[space_id])] = round(building.area(space_id), 4)
        result[("walls", label[space_id])] = sorted(label[n] for n in building.wall_neighbours(space_id))
        for direction in ("above", "below"):
            other = building.stacked_room(space_id, direction)
            result[(direction, label[space_id])] = label[other] if other else None
        reachable = building.reachable_rooms(space_id, space["floor_id"], Constraints(step_free=True, min_width_m=1.0))
        result[("reach", label[space_id])] = len(reachable)
    for first, second in itertools.combinations(picks[:3], 2):
        result[("3d", label[first["id"]], label[second["id"]])] = round(building.straight_line_3d(first["id"], second["id"]), 4)
    return result


def routes(building: Building, rng_seed: str) -> dict:
    rng = random.Random(rng_seed)
    names = sorted(building.spaces, key=lambda s: (building.spaces[s]["name"], building.level(building.spaces[s]["floor_id"])))
    picks = rng.sample(names, min(5, len(names)))
    result = {}
    for first, second in itertools.combinations(picks, 2):
        try:
            result[(building.spaces[first]["name"], building.spaces[second]["name"])] = round(
                building.route(first, second).length_m, 4)
        except EngineError:
            result[(building.spaces[first]["name"], building.spaces[second]["name"])] = None
    return result


def transformed(data: dict, move=None, rename: bool = False, shuffle: bool = False, rewind: bool = False) -> Building:
    data = copy.deepcopy(data)
    if move:
        for space in data["spaces"]:
            space["polygon"] = [move(point) for point in space["polygon"]]
        for item in (*data["openings"], *data["assets"]):
            item["position"] = move(item["position"])
    if rewind:
        for space in data["spaces"]:
            space["polygon"] = space["polygon"][::-1]
    if shuffle:
        rng = random.Random(3)
        for key in ("spaces", "openings", "vertical_connectors", "assets", "floors"):
            rng.shuffle(data[key])
    if rename:
        mapping = {}
        for key in ("floors", "spaces", "openings", "vertical_connectors", "assets"):
            for index, item in enumerate(data[key]):
                mapping[item["id"]] = f"X{key[0]}{index:05d}"
        def swap(value):
            return mapping.get(value, value)
        for key in ("floors", "spaces", "openings", "vertical_connectors", "assets"):
            for item in data[key]:
                item["id"] = swap(item["id"])
                for field in ("floor_id", "space_id"):
                    if field in item:
                        item[field] = swap(item[field])
                for field in ("space_ids", "floor_ids"):
                    if field in item:
                        item[field] = [swap(value) for value in item[field]]
    return Building(data)


def rotate(angle_deg: float):
    angle = math.radians(angle_deg)
    cos, sin = math.cos(angle), math.sin(angle)
    return lambda point: [point[0] * cos - point[1] * sin, point[0] * sin + point[1] * cos]


@pytest.mark.parametrize("path", SAMPLE, ids=lambda path: path.name)
def test_answers_survive_renaming_shuffling_and_rewinding(path):
    original = load(path)
    expected, expected_routes = answers(original, path.name), routes(original, path.name)
    for variant in (transformed(original.data, rename=True), transformed(original.data, shuffle=True),
                    transformed(original.data, rewind=True)):
        assert answers(variant, path.name) == expected
        assert routes(variant, path.name) == expected_routes


@pytest.mark.parametrize("path", SAMPLE, ids=lambda path: path.name)
def test_answers_survive_moving_the_building(path):
    original = load(path)
    shifted = transformed(original.data, move=lambda p: [p[0] + 1234.5, p[1] - 678.25])
    expected, actual = answers(original, path.name), answers(shifted, path.name)
    assert actual.keys() == expected.keys()
    for key, value in expected.items():
        assert actual[key] == (pytest.approx(value, abs=1e-3) if isinstance(value, float) else value), key
    for key, value in routes(original, path.name).items():
        shifted_value = routes(shifted, path.name)[key]
        assert (shifted_value is None) == (value is None)
        if value is not None:
            assert shifted_value == pytest.approx(value, abs=1e-3)


@pytest.mark.parametrize("path", SAMPLE, ids=lambda path: path.name)
def test_geometry_answers_survive_rotation(path):
    """Areas, walls, stacking and 3D distances don't depend on orientation (route anchors may move,
    because representative_point isn't rotation-invariant, so routes aren't compared here)."""
    original = load(path)
    rotated = transformed(original.data, move=rotate(37.0))
    expected, actual = answers(original, path.name), answers(rotated, path.name)
    for key, value in expected.items():
        assert actual[key] == (pytest.approx(value, abs=1e-3) if isinstance(value, float) else value), key


# ---------- route properties ----------

@pytest.mark.parametrize("path", SAMPLE, ids=lambda path: path.name)
def test_route_properties(path):
    building = load(path)
    rng = random.Random(path.name + "props")
    spaces = sorted(building.spaces)
    for _ in range(6):
        a, b, c = rng.sample(spaces, 3)
        normal = building.distances_from(a)
        if b not in normal:
            continue
        assert building.distances_from(b)[a] == pytest.approx(normal[b])  # symmetric
        if c in normal:
            assert normal[c] <= normal[b] + building.distances_from(b)[c] + 1e-9  # triangle inequality
        step_free = building.distances_from(a, Constraints(step_free=True))
        if b in step_free:
            assert step_free[b] >= normal[b] - 1e-9  # a constraint never makes a route shorter
        narrow = building.distances_from(a, Constraints(step_free=True, min_width_m=1.2))
        assert set(narrow) <= set(step_free)  # a wider load never reaches more
        connector = next(iter(building.connectors), None)
        if connector:
            closed = building.distances_from(a, Constraints(closed=frozenset([connector])))
            if b in closed:
                assert closed[b] >= normal[b] - 1e-9  # closing something never helps
