"""Level 5 profiles: walking, wheelchair, trolley, forklift. Which doors fit, steps, the spaces a forklift may
drive through (other rooms only as the destination), why a route isn't the plain walk, and the time."""

import itertools

import pytest
from fastapi.testclient import TestClient

from navagent.agent import BENCHMARK, CHAT, BuildingAgent
from navagent.tools import Session
from navcore.engine import Building, Constraints, EngineError
from navcore.profiles import PROFILES, apply, door_width, find_profile
from server import app as server
from server.reports import Reports
from tests.conftest import DATA
from tests.fake_claude import FakeClient, tool_names

BUILDING = "proc-factory-dev-003"


@pytest.fixture(scope="module")
def building():
    return Building.load(DATA / "dev" / BUILDING)


def space(building, name):
    return next(space_id for space_id, space in building.spaces.items() if space["name"] == name)


def test_without_through_types_the_graph_is_unchanged(building):
    plain, default = building.graph(Constraints()), building.graph(Constraints(through_types=None))
    assert plain is default and plain.graph["pockets"] == {}
    rooms = sorted(building.spaces)[:12]
    for start, end in itertools.combinations(rooms, 2):
        try:
            want = building.route(start, end).length_m
        except EngineError:
            continue
        assert building.route(start, end, Constraints(through_types=None)).length_m == want


def test_other_spaces_are_destinations_never_shortcuts(building):
    corridors_only = Constraints(through_types=frozenset({"corridor"}))
    start, end = space(building, "Warehouse zone H-C1"), space(building, "Logistics zone H-C5")
    route = building.route(start, end, corridors_only)  # both ends are halls: allowed as start and end
    assert all(building.spaces[s]["type"] == "corridor" for s in route.space_path[1:-1])
    distances = building.distances_from(start, corridors_only)
    assert distances[end] == pytest.approx(route.length_m)
    assert space(building, "Production zone H-A1") in distances  # reached, as a destination
    with_halls = building.route(start, end)
    assert route.length_m >= with_halls.length_m


def test_profiles_and_widths():
    assert find_profile("Fork-lift").name == "forklift" and find_profile("wheel chair").name == "wheelchair"
    with pytest.raises(ValueError):
        find_profile("hovercraft")
    assert door_width(PROFILES["trolley"], 0.8) == 0.9  # the trolley's width plus clearance
    assert door_width(PROFILES["wheelchair"]) == 0.9 and door_width(PROFILES["forklift"]) == 1.6
    forklift = apply(PROFILES["forklift"], Constraints(closed=frozenset({"x"})))
    assert forklift.step_free and forklift.min_width_m == 1.6 and forklift.closed == {"x"}
    assert "hall" in forklift.through_types and "office" not in forklift.through_types


def test_a_wheelchair_is_told_why_it_goes_round(building):
    wheelchair = apply(PROFILES["wheelchair"], Constraints())
    why = building.why_detour(space(building, "Staircase 0.17"), space(building, "Staircase 1.02"), wheelchair)
    assert why["reasons"] == ["Office staircase (stairs) is not step-free"] and why["extra_m"] > 20
    same = building.why_detour(space(building, "Warehouse zone H-C1"), space(building, "Logistics zone H-C5"),
                               wheelchair)
    assert same == {"reasons": [], "extra_m": 0.0, "walk_m": same["walk_m"]}


def test_forklift_session_blocked_aisle_detour_and_time(building):
    session = Session(building)
    plain = session.route("Warehouse zone H-C1", "Logistics zone H-C5")
    assert "profile" not in plain  # on foot, as the benchmark: nothing new in the answer
    assert session.set_mobility("forklift")["door_width_m"] == 1.6
    session.block_aisle("Main aisle H-B2")
    route = session.route("Warehouse zone H-C1", "Logistics zone H-C5")
    assert route["profile"] == "Forklift"
    assert route["why_detour"] == ["Main aisle H-B2 (Ground floor) is closed"]
    assert route["extra_m"] == pytest.approx(route["length_m"] - plain["length_m"], abs=0.2)
    assert route["time_s"] == pytest.approx(route["length_m"] / PROFILES["forklift"].speed_mps, abs=1)
    charger = session.nearest_with_asset("Warehouse zone H-C1", "forklift_charging_station")
    assert "charging" in str(charger).lower()
    with pytest.raises(EngineError):  # no lift for a forklift and the office doors are too narrow
        session.route("Warehouse zone H-C1", "Office 1.04")
    session.set_mobility("walk")
    assert session.profile is None and "profile" not in session.route("Warehouse zone H-C1", "Office 1.04")


def test_profile_tools_only_in_conversation(building):
    fake = FakeClient([([], "ok")])
    BuildingAgent(Session(building), fake, mode=BENCHMARK).ask("Where is the kitchen?")
    assert not {"set_mobility", "block_aisle"} & set(tool_names(fake.requests[0]))
    fake = FakeClient([([], "ok")])
    BuildingAgent(Session(building), fake, mode=CHAT).ask("hi")
    assert {"set_mobility", "block_aisle"} <= set(tool_names(fake.requests[0]))


def test_server_profile_chip_and_route(monkeypatch):
    fake = FakeClient([([("find_route", {"start": "Warehouse zone H-C1", "destination": "Logistics zone H-C5"})],
                        "Forklift: 89 m, about 44 s.")])
    monkeypatch.setattr(server, "client", lambda: fake)
    monkeypatch.setattr(server, "_reports", Reports(None))  # never the real .finni/reports.json
    with TestClient(server.app) as http:
        session_id = http.post("/sessions", json={"building_id": BUILDING}).json()["session_id"]
        chip = http.post(f"/sessions/{session_id}/mobility", json={"profile": "forklift"})
        assert chip.status_code == 200 and chip.json()["label"] == "Forklift"
        assert http.post(f"/sessions/{session_id}/mobility", json={"profile": "jetpack"}).status_code == 422
        http.post(f"/sessions/{session_id}/chat", json={"text": "forklift to the loading dock"})
        assert fake.log[-1][0] == "find_route" and "time_s" in str(fake.log[-1][3])
        answer = http.post(f"/buildings/{BUILDING}/route", json={
            "start": "Staircase 0.17", "destination": "Staircase 1.02", "profile": "wheelchair"}).json()
        assert answer["summary"]["why_detour"] == ["Office staircase (stairs) is not step-free"]
        assert answer["summary"]["time_s"] > 0
