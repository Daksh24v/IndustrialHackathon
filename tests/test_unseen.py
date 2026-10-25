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
    farthest = max((space_id for space_id in distances if space_id in building.spaces), key=distances.get)
    steps = [step for leg in session.route(None, farthest)["legs"] for step in leg["steps"]]
    assert steps and steps[-1].startswith("Walk about")  # turn-by-turn works in buildings never seen


def test_a_building_json_with_missing_fields_and_broken_outlines_still_answers():
    """What an unseen file might do wrong: no heights or floor names, spaces without type or name, no
    equipment list, a lift whose floors and spaces don't pair up, an outline that crosses itself."""
    import json

    data = json.loads((TEST / "proc-campus-test-013" / "building.json").read_text())
    for floor in data["floors"]:
        floor.pop("elevation_m"), floor.pop("name")
    for space in data["spaces"][::7]:
        space.pop("room_type"), space.pop("name")
    data.pop("assets")
    data["vertical_connectors"][0]["space_ids"] = data["vertical_connectors"][0]["space_ids"][:-1]
    room = next(space for space in data["spaces"] if space["type"] == "room")
    (x0, y0), (x1, y1) = room["polygon"][0], room["polygon"][2]
    room["polygon"] = [[x0, y0], [x1, y1], [x1, y0], [x0, y1]]  # a bow tie
    building = Building(data)
    session = Session(building)
    assert session.overview()["floors"] and building.floors[building.floor_by_level(1)]["elevation_m"] == 3.0
    rooms = [space_id for space_id, space in building.spaces.items() if space["type"] == "room"]
    assert session.route(rooms[0], rooms[-1])["length_m"] > 0
    assert building.distances_from(room["id"], Constraints())  # the bow-tie room is walkable
