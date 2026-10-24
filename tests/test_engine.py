"""The engine on a hand-made building whose answers are worked out by hand."""

import math

import pytest
from shapely.geometry import Polygon

from navcore.engine import Building, Constraints, EngineError
from starter_agent.building_map import walking_lengths


def test_areas_and_largest(tiny: Building):
    assert tiny.area("T-F0-S1") == pytest.approx(16.0)
    assert tiny.largest_room("T-F0", "office") == ("T-F0-S1", pytest.approx(16.0))
    assert tiny.floor_area_total("T-F0", "lab") == pytest.approx(16.0)
    with pytest.raises(EngineError):
        tiny.largest_room("T-F1", "lab")


def test_route_uses_cheapest_vertical_connector(tiny: Building):
    # Kit 1.1.0: centre (2, 2) -> the office door's landing 30 cm inside (3.7, 2) is 1.7 m, plus 0.3 m to the
    # door: 2 m on each side of each door. Stairs: 2 m per metre climbed, 4 m up = 8 m; the lift: 15 + 4 = 19 m.
    route = tiny.route("T-F0-S1", "T-F1-S1")
    assert route.length_m == pytest.approx(2.0 + 2.0 + 8.0 + 2.0 + 2.0)
    assert route.space_path == ["T-F0-S1", "T-F0-S0", "T-F1-S0", "T-F1-S1"]
    assert route.element_path == ["T-O-office", "T-V-stairs", "T-O-office1"]


def test_step_free_takes_the_lift(tiny: Building):
    stairs = tiny.route("T-F0-S0", "T-F1-S0").length_m
    lift = tiny.route("T-F0-S0", "T-F1-S0", Constraints(step_free=True)).length_m
    assert stairs == pytest.approx(2.0 * 4.0)
    assert lift == pytest.approx(15.0 + 1.0 * 4.0)


def test_corridor_is_walked_door_to_door(tiny: Building):
    # Office -> lab crosses the corridor from door (4, 2) to door (8, 2), not via its centre point.
    route = tiny.route("T-F0-S1", "T-F0-S2")
    assert route.length_m == pytest.approx(2.0 + (0.3 + 3.4 + 0.3) + 2.0)
    assert route.space_path == ["T-F0-S1", "T-F0-S0", "T-F0-S2"]
    assert route.element_path == ["T-O-office", "T-O-lab"]


def test_walks_go_round_corners_never_through_walls():
    # An L-shaped room: from the far end of one arm to the far end of the other the straight line leaves the
    # room, so the walk bends round the inner corner, 15 cm off it.
    room = [[0, 0], [10, 0], [10, 2], [2, 2], [2, 10], [0, 10]]
    building = Building({
        "building": {"id": "L", "name": "L", "source": "test", "units": "m"},
        "floors": [{"id": "F", "level": 0, "name": "Ground floor", "elevation_m": 0.0}],
        "spaces": [{"id": "R", "floor_id": "F", "type": "room", "room_type": "office", "name": "L room", "ref": None,
                    "polygon": room}],
        "openings": [
            {"id": "A", "floor_id": "F", "space_ids": ["R", "outside"], "kind": "entrance", "position": [10, 1]},
            {"id": "B", "floor_id": "F", "space_ids": ["R", "outside"], "kind": "entrance", "position": [1, 10]},
        ],
        "vertical_connectors": [], "assets": [],
    })
    walk = next(length for first, second, length in building.space_walks("R") if {first, second} == {"door:A", "door:B"})
    # Doors land 30 cm inside, at (9.7, 1) and (1, 9.7); the walk bends round the wall corner (2, 2) at 15 cm.
    round_the_corner = math.dist((9.7, 1.0), (2.0, 1.85)) + math.dist((1.85, 2.0), (1.0, 9.7))
    assert round_the_corner + 0.6 < walk < round_the_corner + 0.6 + 0.3  # plus a short arc round the corner
    assert walk > math.dist((10, 1), (1, 10))
    reference = walking_lengths(Polygon(room), [(9.7, 1.0), (1.0, 9.7)])[(0, 1)]
    assert walk == pytest.approx(reference + 0.6, abs=1e-9)


def test_closures_and_widths(tiny: Building):
    closed = Constraints(step_free=True, closed=frozenset({"T-V-lift"}))
    with pytest.raises(EngineError):
        tiny.route("T-F0-S0", "T-F1-S0", closed)
    wide = Constraints(step_free=True, min_width_m=1.1)
    assert tiny.reachable_rooms("T-F0-S0", "T-F0", wide) == ["T-F0-S2"]  # the office door is 0.9 m
    assert sorted(tiny.reachable_rooms("T-F0-S0", "T-F0")) == ["T-F0-S1", "T-F0-S2"]


def test_entrance_is_not_step_free(tiny: Building):
    assert tiny.distances_to_exit()["T-F0-S0"] == pytest.approx(1.7 + 0.3)
    assert tiny.distances_to_exit(Constraints(step_free=True)) == {}


def test_no_way_round_the_outside():
    # Two rooms that only meet outside: each has its own entrance, there is no door between them.
    def room(space_id, x):
        return {"id": space_id, "floor_id": "F", "type": "room", "room_type": "office", "name": space_id,
                "ref": None, "polygon": [[x, 0], [x + 4, 0], [x + 4, 4], [x, 4]]}

    building = Building({
        "building": {"id": "O", "name": "O", "source": "test", "units": "m"},
        "floors": [{"id": "F", "level": 0, "name": "Ground floor", "elevation_m": 0.0}],
        "spaces": [room("West", 0), room("East", 10)],
        "openings": [
            {"id": "W", "floor_id": "F", "space_ids": ["outside", "West"], "kind": "entrance", "position": [2, 0]},
            {"id": "E", "floor_id": "F", "space_ids": ["outside", "East"], "kind": "entrance", "position": [12, 0]},
        ],
        "vertical_connectors": [], "assets": [],
    })
    with pytest.raises(EngineError):
        building.route("West", "East")
    assert building.exit_route("East").element_path == ["E"]


def test_stacking_and_3d_distance(tiny: Building):
    assert tiny.stacked_room("T-F0-S1", "above") == "T-F1-S1"
    assert tiny.stacked_room("T-F1-S1", "below") == "T-F0-S1"
    assert tiny.stacked_room("T-F0-S2", "above") is None
    assert tiny.straight_line_3d("T-F0-S1", "T-F1-S0") == pytest.approx(math.hypot(4.0, 4.0))


def test_shared_walls_skip_corridors(tiny: Building):
    assert tiny.wall_neighbours("T-F0-S1") == []  # its only neighbour is the corridor
    # 4 m of wall, plus 0.35 m of each perpendicular wall that falls inside the wall-thickness band
    assert tiny.shared_wall_length("T-F0-S1", "T-F0-S0") == pytest.approx(4.7, abs=0.01)


def test_door_between_sits_in_the_middle_of_the_shared_wall(tiny: Building):
    door = tiny.door_between("T-F0-S1", "T-F0-S0")
    assert door["position"] == pytest.approx([4.0, 2.0])
    with pytest.raises(EngineError):
        tiny.door_between("T-F0-S1", "T-F0-S2")


def test_errand_and_nearest_asset(tiny: Building):
    via, total = tiny.errand("T-F0-S1", "fire_extinguisher", "T-F1-S1")
    assert via == "T-F0-S2"
    expected = tiny.route("T-F0-S1", "T-F0-S2").length_m + tiny.route("T-F0-S2", "T-F1-S1").length_m
    assert total == pytest.approx(expected)


def test_what_if_door_shortens_walks_out(tiny: Building):
    # Move the office door to the far end of its wall: a new door in the middle is then a shortcut out.
    tiny.openings["T-O-office"]["position"] = [4.0, 3.9]
    tiny._graphs.clear()
    assert tiny.what_if_door("T-F0-S1", "T-F0-S0", "T-F0") == ["T-F0-S1"]
    assert tiny.what_if_door("T-F0-S1", "T-F0-S0", "T-F1") == []  # upstairs doesn't walk through it
