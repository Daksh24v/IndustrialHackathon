"""scripts/osm_context.py without the network: the projection, the footprint fit and the baking of one
made-up Overpass answer."""

import importlib.util
import json

import pytest
from shapely import affinity
from shapely.geometry import Polygon

from tests.conftest import DATA

spec = importlib.util.spec_from_file_location("osm_context", DATA.parent / "scripts" / "osm_context.py")
osm_context = importlib.util.module_from_spec(spec)
spec.loader.exec_module(osm_context)

KINDS = {
    "building": {"industrial", "commercial", "office", "retail", "residential", "public", "religious", "parking",
                 "other"},
    "area": {"industrial", "commercial", "retail", "residential", "parking", "grass", "park", "forest", "farmland",
             "meadow", "sports", "construction", "brownfield", "cemetery", "allotments", "railway"},
}
L_SHAPE = Polygon([(0, 0), (80, 0), (80, 20), (25, 20), (25, 50), (0, 50)])


def test_frame_round_trips_and_turns_counterclockwise():
    frame = osm_context.Frame(48.1364, 11.6544, rotation_deg=90)
    lat, lon = frame.geographic(10.0, 0.0)  # local x turned 90 degrees counterclockwise points north
    assert lat > 48.1364 and lon == pytest.approx(11.6544)
    assert frame.local(lat, lon) == pytest.approx((10.0, 0.0), abs=1e-6)


@pytest.mark.parametrize("rotation", [0.0, 37.0, 160.0, 251.0])
def test_fit_recovers_a_turned_and_shifted_footprint(rotation):
    way = affinity.translate(affinity.rotate(L_SHAPE, rotation, origin=(0, 0)), -31.0, 12.5)
    fit = osm_context.fit_to_way(L_SHAPE, way)
    assert fit["iou"] > 0.98
    assert (fit["rotation_deg"] - rotation + 180) % 360 - 180 == pytest.approx(0, abs=1.0)


def test_neighbourhood_drops_our_building_clips_and_rounds(monkeypatch):
    frame = osm_context.Frame(48.0, 11.0)

    def way(id_, tags, points):
        nodes = [dict(zip(("lat", "lon"), frame.geographic(x, y))) for x, y in points]
        return {"type": "way", "id": id_, "tags": tags, "geometry": nodes}

    square = [(-10, -10), (10, -10), (10, 10), (-10, 10), (-10, -10)]
    elements = [
        way(1, {"building": "yes"}, [(x + 5, y) for x, y in square]),  # overlaps ours: dropped
        way(2, {"building": "office", "building:levels": "5"}, [(x + 40, y) for x, y in square]),
        way(3, {"building": "shed"}, [(x + 900, y) for x, y in square]),  # outside the radius
        way(4, {"highway": "primary", "name": "Through"}, [(-100, 0.04), (100, 0.04)]),
        way(5, {"highway": "service", "tunnel": "yes"}, [(-50, 30), (50, 30)]),
        way(6, {"leisure": "park"}, [(x * 3, y * 3 + 100) for x, y in square]),
        way(7, {"landuse": "industrial"}, [(x * 4 - 150, y * 4) for x, y in square]),
        way(8, {"building": "yes"}, [(x * 0.5 - 150, y * 0.5) for x, y in square]),  # takes the landuse's kind
        way(9, {"building": "apartments"}, [(x * 0.5 - 150, y * 0.5 - 200) for x, y in square]),
        way(10, {"amenity": "parking"}, [(x + 200, y) for x, y in square]),
        way(11, {"landuse": "brownfield"}, [(x * 5, y * 5) for x, y in square]),  # under all of ours: dropped
        way(12, {"natural": "tree_row"}, [(-100, -100), (-80, -100)]),
        {"type": "node", "id": 13, "tags": {"natural": "tree"},
         **dict(zip(("lat", "lon"), frame.geographic(0.0, -60.0)))},
        {"type": "node", "id": 14, "tags": {"natural": "tree"},
         **dict(zip(("lat", "lon"), frame.geographic(2.0, 2.0)))},
    ]
    monkeypatch.setattr(osm_context, "overpass", lambda query, cache=None: elements)
    ours = Polygon(square[:-1]).buffer(0)
    body = osm_context.neighbourhood(ours, {"lat": 48.0, "lon": 11.0, "rotation_deg": 0.0}, 500.0, None)
    assert body["license"] == "ODbL-1.0"
    kinds = {b["kind"]: b for b in body["buildings"]}
    assert set(kinds) == {"office", "industrial", "residential"}
    assert kinds["office"]["height_m"] == 16.0 and kinds["industrial"]["height_m"] == 10.0
    assert min(x for x, _ in kinds["office"]["polygon"]) == pytest.approx(30.0, abs=0.1)
    assert [road["kind"] for road in body["roads"]] == ["primary", "primary"]  # cut where it crosses ours
    assert all(road["width_m"] == 10.0 for road in body["roads"])
    assert len(body["green"]) == 1 and body["water"] == []
    assert [area["kind"] for area in body["areas"]] == ["industrial", "park", "parking"]  # biggest first
    # nearest first, every 8 m along the row, none inside ours
    assert body["trees"] == [[0.0, -60.0], [-84.0, -100.0], [-92.0, -100.0], [-100.0, -100.0]]
    assert all(round(v, 1) == v for b in body["buildings"] for point in b["polygon"] for v in point)


def test_baked_files_match_their_placements():
    placements = json.loads((DATA / "context" / "placements.json").read_text(encoding="utf-8"))
    for building_id in ("proc-factory-dev-003", "osm-way360544293"):
        baked = json.loads((DATA / "context" / f"{building_id}.json").read_text(encoding="utf-8"))
        assert baked["placement"] == {key: placements[building_id][key] for key in ("lat", "lon", "rotation_deg")}
        assert {b["kind"] for b in baked["buildings"]} <= KINDS["building"]
        assert {a["kind"] for a in baked["areas"]} <= KINDS["area"] and baked["trees"]
        assert all(len(point) == 2 for point in baked["trees"]) and len(baked["trees"]) <= 2000
    assert placements["osm-way360544293"]["fit"]["iou"] > 0.25
