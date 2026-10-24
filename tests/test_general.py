"""Question definitions are parameters, general tools, and same-named rooms (the 'readings')."""

import json

import pytest

from navagent.agent import BENCHMARK, BuildingAgent, make_tools
from navagent.tools import Session
from navcore.engine import Building, EngineError
from tests.conftest import square
from tests.fake_claude import FakeClient
from tests.test_stress import make


def strip() -> Building:
    """Ground floor: Office A (0..4) | Office B (4..10) | hall H (10..16), all 4 m deep; a corridor below.
    A-B share 4 m of wall, B-H 4 m. Office C (x 0..5.2, y 4..5.5) sits on top of A and B: within the
    0.35 m band it runs 1.9 m along B (1.2 m of top edge, 0.35 m on each side), so it counts at 1 m, not 2 m."""
    return make([(0, "Ground floor")], [
        ("S-A", 0, "room", "office", "Office A", square(0, 0, 4, 4)),
        ("S-B", 0, "room", "office", "Office B", square(4, 0, 6, 4)),
        ("S-H", 0, "hall", "production_zone", "Hall H", square(10, 0, 6, 4)),
        ("S-C", 0, "room", "office", "Office C", square(0, 4, 5.2, 1.5)),
        ("S-K", 0, "corridor", "corridor", "Corridor K", square(0, -2, 16, 2)),
    ], openings=[
        ("S-O-a", ["S-K", "S-A"], "door", [2, 0], 0.9, True),
        ("S-O-b", ["S-K", "S-B"], "door", [7, 0], 1.2, True),
        ("S-O-h", ["S-K", "S-H"], "door", [13, 0], 1.6, True),
        ("S-O-c", ["S-A", "S-C"], "door", [2, 4], 0.8, False),
        ("S-O-in", ["outside", "S-K"], "entrance", [8, -2], 1.6, True),
    ])


def test_wall_length_and_types_are_parameters():
    session = Session(strip())
    assert session.wall_neighbours("Office B")["count"] == 3  # A, C (1.5 m) and hall H
    assert session.wall_neighbours("Office B", min_length_m=2.0)["count"] == 2  # C drops out
    assert session.wall_neighbours("Office B", count_types=["room"])["count"] == 2  # the hall drops out
    assert session.wall_neighbours("Office B", count_types=["rooms", "corridor", "hall"])["count"] == 4
    with pytest.raises(EngineError):
        session.wall_neighbours("Office B", count_types=["kitchen"])


def test_reachable_count_types_are_parameters():
    session = Session(strip())
    assert session.reachable_rooms("Corridor K", "Ground floor", step_free=True)["reachable_rooms"] == 2  # A, B
    with_halls = session.reachable_rooms("Corridor K", "Ground floor", step_free=True, count_types=["room", "hall"])
    assert with_halls["reachable_rooms"] == 3


def test_what_if_threshold_is_a_parameter(tiny: Building):
    # The office door moved to the far end of its wall: a new door in the middle saves about 1.5 m.
    tiny.openings["T-O-office"]["position"] = [4.0, 3.9]
    tiny._graphs.clear()
    session = Session(tiny)
    assert session.what_if_door("Office 0.01", "Corridor 0.00", "Ground floor")["rooms_with_shorter_exit"] == 1
    assert session.what_if_door("Office 0.01", "Corridor 0.00", "Ground floor", threshold_m=0.0)[
        "rooms_with_shorter_exit"] == 1
    assert session.what_if_door("Office 0.01", "Corridor 0.00", "Ground floor", threshold_m=5.0)[
        "rooms_with_shorter_exit"] == 0


def test_query_spaces_statistics_and_sorting():
    session = Session(strip())
    offices = session.query_spaces(room_type="office", sort_by="area_asc")
    assert offices["count"] == 3
    assert offices["spaces"][0]["name"] == "Office C" and offices["min_area_m2"] == pytest.approx(7.8)
    assert offices["mean_area_m2"] == pytest.approx(round((16 + 24 + 7.8) / 3, 2))
    big = session.query_spaces(min_area_m2=20, space_type="room")
    assert [row["name"] for row in big["spaces"]] == ["Office B"]
    near = session.query_spaces(space_type="room", sort_by="distance", distance_from="Office A")
    assert near["spaces"][0]["name"] == "Office A" and near["spaces"][0]["walk_m"] == 0
    with pytest.raises(EngineError):
        session.query_spaces(sort_by="distance")


def test_list_doors_filters():
    session = Session(strip())
    assert session.list_doors(floor="Ground floor")["count"] == 5
    narrow = session.list_doors(max_width_m=0.9)
    assert narrow["count"] == 2 and narrow["narrowest_m"] == 0.8
    assert session.list_doors(kind="entrance")["count"] == 1
    assert session.list_doors(step_free=False)["count"] == 1
    assert session.list_doors(room="Office A")["count"] == 2


def test_find_assets_sorted_by_walk(tiny: Building):
    found = Session(tiny).find_assets("fire extinguisher", near="Office 1.01")
    assert found["count"] == 1 and found["assets"][0]["room"] == "Lab 0.02 (Ground floor)"


def twins() -> Building:
    """Two rooms called 'Büro' on the ground floor: one under Office 1, one under nothing."""
    return make([(0, "Ground floor"), (1, "Floor 1")], [
        ("S-B1", 0, "room", "office", "Büro", square(0, 0, 4, 4)),
        ("S-B2", 0, "room", "office", "Büro", square(10, 0, 4, 4)),
        ("S-U", 1, "room", "office", "Office 1", square(0, 0, 4, 4)),
    ])


def test_same_named_room_gives_every_reading():
    tools = {tool.name: tool for tool in make_tools(Session(twins()), BENCHMARK)}
    result = json.loads(tools["room_details"].call({"room": "Büro (Ground floor)"}))
    assert result["ambiguous_name"] == "Büro (Ground floor)"
    assert [reading["space_id"] for reading in result["readings"]] == ["S-B1", "S-B2"]
    assert result["all_readings_agree"] is False
    stacked = json.loads(tools["stacked_room"].call({"room": "Büro (Ground floor)", "direction": "above"}))
    assert stacked["readings"][0]["result"]["stacked"]["name"] == "Office 1"
    assert "error" in stacked["readings"][1]  # nothing above the second Büro


def test_readings_agree_when_duplicates_dont_matter():
    tools = {tool.name: tool for tool in make_tools(Session(twins()), BENCHMARK)}
    result = json.loads(tools["wall_neighbours"].call({"room": "Büro (Ground floor)"}))
    assert result["all_readings_agree"] is True


def test_readings_inside_lists():
    tools = {tool.name: tool for tool in make_tools(Session(twins()), BENCHMARK)}
    result = json.loads(tools["straight_line_distance"].call({"first": "Office 1 (Floor 1)", "second": "Büro (Ground floor)"}))
    distances = [reading["result"]["distance_m"] for reading in result["readings"]]
    assert distances[0] == pytest.approx(4.0) and distances[1] > distances[0]


def test_agent_sees_the_readings(tiny: Building):
    client = FakeClient([([("room_details", {"room": "Büro (Ground floor)"}),
                           ("submit_answer", {"answer_type": "number", "value": 16})], "ok")])
    BuildingAgent(Session(twins()), client, mode=BENCHMARK).answer_benchmark("How big is Büro?")
    assert '"readings"' in client.log[0][3] and client.log[0][2] is False
