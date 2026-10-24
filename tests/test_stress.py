"""Small hand-made buildings for cases the dataset rarely shows; every answer is worked out by hand."""

import math

import pytest
from shapely.geometry import Point

from navagent.tools import Session
from navcore.engine import Building, Constraints, EngineError
from navcore.resolve import AmbiguousSpace, find_space
from tests.conftest import square


def make(floors, spaces, openings=(), connectors=(), assets=()) -> Building:
    return Building({
        "building": {"id": "S", "name": "Stress", "source": "test", "units": "m"},
        "floors": [{"id": f"S-F{level}", "level": level, "name": name, "elevation_m": 4.0 * level, "height_m": 4.0}
                   for level, name in floors],
        "spaces": [{"id": space_id, "floor_id": f"S-F{level}", "type": kind, "room_type": room_type, "name": name,
                    "ref": None, "polygon": polygon, "synthetic": False}
                   for space_id, level, kind, room_type, name, polygon in spaces],
        "openings": [{"id": opening_id, "floor_id": "S-F0", "space_ids": ids, "kind": kind, "position": position,
                      "width_m": width, "step_free": step_free, "synthetic": False}
                     for opening_id, ids, kind, position, width, step_free in openings],
        "vertical_connectors": list(connectors),
        "assets": list(assets),
    })


def test_l_shaped_room_area_and_largest():
    l_shape = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]]  # 6x2 + 2x4 = 20 m²
    building = make([(0, "Ground floor")], [
        ("S-L", 0, "room", "office", "Office L", l_shape),
        ("S-Q", 0, "room", "office", "Office Q", square(10, 0, 4, 4)),  # 16 m²
    ])
    assert building.area("S-L") == pytest.approx(20.0)
    assert building.largest_room("S-F0", "office")[0] == "S-L"
    assert building.polygons["S-L"].contains(Point(building.anchor("S-L")))


def test_stacking_skips_missing_levels():
    building = make([(-2, "Basement 2"), (0, "Ground floor"), (1, "Floor 1")], [
        ("S-B", -2, "room", "storage", "Store -2", square(0, 0, 4, 4)),
        ("S-G", 0, "room", "office", "Office 0", square(0, 0, 4, 4)),
        ("S-U", 1, "room", "office", "Office 1", square(1, 1, 4, 4)),
    ])
    assert building.stacked_room("S-G", "below") == "S-B"
    assert building.stacked_room("S-B", "above") == "S-G"
    assert building.stacked_room("S-G", "above") == "S-U"
    assert building.stacked_room("S-U", "above") is None


def test_stacking_picks_the_largest_overlap_not_the_first():
    building = make([(0, "Ground floor"), (1, "Floor 1")], [
        ("S-G", 0, "room", "office", "Office 0", square(0, 0, 10, 4)),
        ("S-A", 1, "room", "office", "Small", square(0, 0, 3, 4)),
        ("S-B", 1, "room", "office", "Big", square(3, 0, 7, 4)),
    ])
    assert building.stacked_room("S-G", "above") == "S-B"


def two_cores() -> Building:
    """Ground floor corridor 0..20 m, lift at the west end, stairs at the east end, office upstairs east."""
    return make([(0, "Ground floor"), (1, "Floor 1")], [
        ("S-C0", 0, "corridor", "corridor", "Corridor 0", square(0, 0, 20, 2)),
        ("S-LW0", 0, "lift", "lift", "West lift 0", square(0, 2, 2, 2)),
        ("S-SE0", 0, "stair", "stairwell", "East stairs 0", square(18, 2, 2, 2)),
        ("S-C1", 1, "corridor", "corridor", "Corridor 1", square(0, 0, 20, 2)),
        ("S-LW1", 1, "lift", "lift", "West lift 1", square(0, 2, 2, 2)),
        ("S-SE1", 1, "stair", "stairwell", "East stairs 1", square(18, 2, 2, 2)),
        ("S-O1", 1, "room", "office", "Office 1.01", square(18, -4, 2, 4)),
    ], openings=[
        ("S-O-lw0", ["S-C0", "S-LW0"], "door", [1, 2], 1.1, True),
        ("S-O-se0", ["S-C0", "S-SE0"], "door", [19, 2], 1.2, True),
        ("S-O-lw1", ["S-C1", "S-LW1"], "door", [1, 2], 1.1, True),
        ("S-O-se1", ["S-C1", "S-SE1"], "door", [19, 2], 1.2, True),
        ("S-O-of1", ["S-C1", "S-O1"], "door", [19, 0], 0.9, True),
        ("S-O-in", ["outside", "S-C0"], "entrance", [10, 0], 1.6, False),
    ], connectors=[
        {"id": "S-V-lift", "kind": "lift", "name": "West lift", "floor_ids": ["S-F0", "S-F1"],
         "space_ids": ["S-LW0", "S-LW1"]},  # no step_free field: a lift is step-free
        {"id": "S-V-stairs", "kind": "stairs", "name": "East stairs", "floor_ids": ["S-F0", "S-F1"],
         "space_ids": ["S-SE0", "S-SE1"]},  # no step_free field: stairs are not
    ])


def test_two_cores_and_missing_step_free_flags():
    building = two_cores()
    walking = building.route("S-C0", "S-O1")
    assert "S-V-stairs" in walking.element_path
    wheelchair = building.route("S-C0", "S-O1", Constraints(step_free=True))
    assert "S-V-lift" in wheelchair.element_path and wheelchair.length_m > walking.length_m
    lift_out = Constraints(step_free=True, closed=frozenset({"S-V-lift"}))
    assert building.reachable_rooms("S-C0", "S-F1", lift_out) == []
    assert building.reachable_rooms("S-C0", "S-F1", Constraints(step_free=True)) == ["S-O1"]


def test_step_only_entrance_blocks_wheelchairs_from_outside():
    building = two_cores()
    assert "S-C0" in building.distances_to_exit()
    assert "S-C0" not in building.distances_to_exit(Constraints(step_free=True))


def test_duplicate_names_are_reported_with_labels():
    building = make([(0, "Ground floor")], [
        ("S-1", 0, "room", "office", "Büro", square(0, 0, 4, 4)),
        ("S-2", 0, "room", "office", "Büro", square(4, 0, 5, 4)),
    ])
    with pytest.raises(AmbiguousSpace) as error:
        find_space(building, "Büro (Ground floor)")
    assert error.value.candidates == ["S-1", "S-2"]
    assert "S-2 = Büro (Ground floor), 20.0 m²" in str(error.value)
    with pytest.raises(EngineError):
        Session(building).room_details("Büro")


def test_bow_tie_outline_is_repaired_not_crashing():
    building = make([(0, "Ground floor")], [
        ("S-X", 0, "room", "office", "Twisted", [[0, 0], [4, 4], [4, 0], [0, 4]]),
    ])
    assert building.area("S-X") > 0
    assert building.wall_neighbours("S-X") == []


def test_connector_with_a_missing_stop_is_skipped():
    building = make([(0, "Ground floor"), (1, "Floor 1")], [
        ("S-A", 0, "lift", "lift", "Lift 0", square(0, 0, 2, 2)),
    ], connectors=[{"id": "S-V", "kind": "lift", "name": "Lift", "floor_ids": ["S-F0", "S-F1"],
                    "space_ids": ["S-A", "S-MISSING"], "step_free": True}])
    assert building.distances_from("S-A") == {"S-A": 0.0}


def test_lift_cost_model_over_several_floors():
    building = make([(0, "Ground floor"), (1, "Floor 1"), (2, "Floor 2")], [
        (f"S-L{level}", level, "lift", "lift", f"Lift {level}", square(0, 0, 2, 2)) for level in (0, 1, 2)
    ], connectors=[{"id": "S-V", "kind": "lift", "name": "Lift", "floor_ids": ["S-F0", "S-F1", "S-F2"],
                    "space_ids": ["S-L0", "S-L1", "S-L2"], "step_free": True}])
    # kit 1.1.0: one ride pays the 15 m once, plus 1 m per metre climbed (two floors of 4 m)
    assert building.route("S-L0", "S-L2").length_m == pytest.approx(15 + 8.0)
    assert building.route("S-L0", "S-L2").element_path == ["S-V"]
    assert math.isclose(building.straight_line_3d("S-L0", "S-L2"), 8.0)
