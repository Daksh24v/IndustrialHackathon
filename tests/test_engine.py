"""The engine on a hand-made building whose answers are worked out by hand."""

import math

import pytest

from navcore.engine import OUTSIDE, Building, Constraints, EngineError


def test_areas_and_largest(tiny: Building):
    assert tiny.area("T-F0-S1") == pytest.approx(16.0)
    assert tiny.largest_room("T-F0", "office") == ("T-F0-S1", pytest.approx(16.0))
    assert tiny.floor_area_total("T-F0", "lab") == pytest.approx(16.0)
    with pytest.raises(EngineError):
        tiny.largest_room("T-F1", "lab")


def test_route_uses_cheapest_vertical_connector(tiny: Building):
    route = tiny.route("T-F0-S1", "T-F1-S1")
    anchor_to_door = math.dist(tiny.anchor("T-F0-S1"), (4, 2))
    corridor_to_door = math.dist(tiny.anchor("T-F0-S0"), (4, 2))
    upstairs = math.dist(tiny.anchor("T-F1-S0"), (4, 2)) + math.dist(tiny.anchor("T-F1-S1"), (4, 2))
    assert route.length_m == pytest.approx(anchor_to_door + corridor_to_door + 12.0 + upstairs)
    assert route.space_path == ["T-F0-S1", "T-F0-S0", "T-F1-S0", "T-F1-S1"]
    assert "T-V-stairs" in route.element_path


def test_step_free_takes_the_lift(tiny: Building):
    stairs = tiny.route("T-F0-S0", "T-F1-S0").length_m
    lift = tiny.route("T-F0-S0", "T-F1-S0", Constraints(step_free=True)).length_m
    assert stairs == pytest.approx(12.0)
    assert lift == pytest.approx(15.0 + 6.0)


def test_closures_and_widths(tiny: Building):
    closed = Constraints(step_free=True, closed=frozenset({"T-V-lift"}))
    with pytest.raises(EngineError):
        tiny.route("T-F0-S0", "T-F1-S0", closed)
    wide = Constraints(step_free=True, min_width_m=1.1)
    assert tiny.reachable_rooms("T-F0-S0", "T-F0", wide) == ["T-F0-S2"]  # the office door is 0.9 m
    assert sorted(tiny.reachable_rooms("T-F0-S0", "T-F0")) == ["T-F0-S1", "T-F0-S2"]


def test_entrance_is_not_step_free(tiny: Building):
    assert OUTSIDE in tiny.distances_from("T-F0-S0")
    assert OUTSIDE not in tiny.distances_from("T-F0-S0", Constraints(step_free=True))


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
