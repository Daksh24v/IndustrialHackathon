"""Checks that need no expected answers, on the 40 test buildings (layouts train never has: campus basements,
more cores, bigger halls), standing in for the Sunday building: nothing crashes, every name people see
resolves back to its room, routes are never shorter than a straight line, and locating works everywhere."""

import math
from pathlib import Path

import pytest

from navagent.tools import Session
from navcore.engine import Building, Constraints
from navcore.resolve import AmbiguousSpace, find_space

TEST = Path(__file__).resolve().parent.parent / "data" / "test"
BUILDINGS = sorted(path.name for path in TEST.iterdir() if (path / "building.json").exists())


@pytest.mark.parametrize("building_id", BUILDINGS)
def test_unseen_building(building_id):
    building = Building.load(TEST / building_id)
    for space_id in building.spaces:  # every label resolves to its own room, or names the duplicates
        try:
            assert find_space(building, building.label(space_id)) == space_id
        except AmbiguousSpace as error:
            assert space_id in error.candidates
    start = min(building.spaces, key=lambda space_id: (building.spaces[space_id]["type"] != "corridor", space_id))
    distances = building.distances_from(start, Constraints())
    for space_id, walk in distances.items():
        if space_id in building.spaces and building.spaces[space_id]["floor_id"] == building.spaces[start]["floor_id"]:
            # edges are rounded to the millimetre, as in the kit
            assert walk + 0.01 >= math.dist(building.anchor(start), building.anchor(space_id))
    step_free = building.distances_from(start, Constraints(step_free=True))
    assert all(step_free[node] + 1e-6 >= distances[node] for node in step_free)  # fewer ways, never shorter
    session = Session(building)
    for floor_id in building.floors:
        assert session.where_am_i_options(floor_id)["landmarks"] or not building.spaces_on(floor_id)
    session.set_position(start)
    assert session.where_am_i_options()["last_known"] == building.label(start)
