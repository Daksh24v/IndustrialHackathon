"""Every tool on every build and test building (never the hold-out): nothing may crash or return nonsense.

The Sunday building is new, so the tools must cope with any building in this format."""

import csv
import math

import pytest

from holdout.split import HOLDOUT_LIST, read
from navagent.tools import Session
from navcore.engine import Building, EngineError
from tests.conftest import DATA


def paths() -> list:
    holdout = read(HOLDOUT_LIST)
    with (DATA / "manifest.csv").open(encoding="utf-8", newline="") as handle:
        return [DATA / row["path"] for row in csv.DictReader(handle) if row["building_id"] not in holdout]


@pytest.mark.parametrize("path", paths(), ids=lambda path: path.name)
def test_tools_work_on_every_building(path):
    session = Session(Building.load(path))
    building = session.building
    overview = session.overview()
    assert overview["floors"] and all(math.isfinite(floor["elevation_m"]) for floor in overview["floors"])
    rooms = [space for space in building.spaces.values() if space["type"] == "room"]
    for space in rooms[:: max(1, len(rooms) // 5)][:5]:
        details = session.room_details(space["id"])
        assert details["area_m2"] > 0
        assert all(math.isfinite(value) for value in details["centroid"])
        assert session.wall_neighbours(space["id"])["count"] >= 0
        for direction in ("above", "below"):
            try:
                session.stacked_room(space["id"], direction)
            except EngineError:
                pass  # no floor in that direction: a clear error, not a crash
        try:
            exit_walk = session.nearest_exit(space["id"])
            assert exit_walk["walk_m"] >= 0
        except EngineError:
            pass  # some rooms really have no way out in the data
    for floor in building.floors.values():
        listing = session.list_rooms(floor["id"])
        assert listing["total_area_m2"] >= 0
        for room_type in sorted({space["room_type"] for space in building.spaces_on(floor["id"])})[:3]:
            assert session.largest_room(floor["id"], room_type)["largest"]["area_m2"] > 0
