"""Level 4 conversation: the draft and its edits, the builder agent's tools, the server's import endpoints."""

import json

import pytest
from fastapi.testclient import TestClient

from navagent import builder as builder_module
from navagent.agent import BUILDER, BuildingAgent, make_tools
from navagent.builder import Draft
from navagent.tools import Session
from navcore.engine import Building, Constraints, EngineError
from server import app as server
from tests.conftest import DATA
from tests.fake_claude import FakeClient, tool_names
from tests.test_plans import ground_plan, upper_plan


@pytest.fixture
def draft(tmp_path) -> Draft:
    files = [(path.name, path.read_text(encoding="utf-8")) for path in (ground_plan(tmp_path), upper_plan(tmp_path))]
    return Draft.from_svgs(files, "imported-test")


def test_summary_shows_what_was_understood_and_open_points(draft):
    summary = draft.summary()
    assert summary["name"] == "Test Hall"
    assert [floor["level"] for floor in summary["floors"]] == [0, 1]
    assert summary["floors"][0]["kinds"] == {"room": 2, "corridor": 1, "stair": 1, "lift": 1}
    assert sorted(summary["stairs_and_lifts"]) == ["Lift 1", "Stairs 1"]
    assert any("Room types" in point for point in summary["open_points"])


def test_room_types_and_renames(draft):
    draft.set_room_type(["0.01", "0.02"], "office")
    names = {space["ref"]: space["name"] for space in draft.building["spaces"]}
    assert names["0.01"] == "Office 0.01" and names["0.02"] == "Office 0.02"
    assert not any(point.startswith("Room types") for point in draft.notes)
    draft.rename("Office 0.02", number="0.05")
    assert any(space["name"] == "Office 0.05" for space in draft.building["spaces"])
    draft.rename("0.05", name="Boss office")
    assert draft.loaded().spaces  # still a valid building
    with pytest.raises(EngineError):
        draft.set_room_type(["0.01"], "spaceship")


def test_doors_widths_and_steps(draft):
    draft.set_door("0.01", "0.00 (Ground floor)", width_m=1.2)
    draft.set_door("0.00 (Ground floor)", "outside", step_free=False)
    building = draft.loaded()
    office = next(s for s in building.spaces.values() if s["ref"] == "0.01")["id"]
    door = next(o for o in building.openings.values() if office in o["space_ids"])
    assert door["width_m"] == 1.2
    assert "outside" not in building.distances_from(office, Constraints(step_free=True))
    changed = draft.set_all_doors(1.6, ["corridor"])
    assert changed["doors_changed"] >= 3
    with pytest.raises(EngineError):
        draft.set_door("0.01", "0.02", width_m=1.0)  # no door between the two offices
    added = draft.add_door("0.01", "0.02")
    assert added["added"] and len(draft.loaded().openings) == len(building.openings) + 1


def test_heights_scale_and_save(draft, tmp_path):
    result = draft.set_floor_height("Ground floor", 8.0)
    assert [f["elevation_m"] for f in result["floors"]] == [0.0, 8.0]
    office = next(s for s in draft.building["spaces"] if s["ref"] == "0.01")
    draft.set_known_length("0.01", 16.0)  # it was drawn 8 m long
    assert draft.loaded().area(office["id"]) == pytest.approx(4 * 48.0)
    path = draft.save("My Hall", directory=tmp_path)
    saved = json.loads((path / "building.json").read_text())
    assert saved["building"]["name"] == "My Hall" and Building(saved).spaces


def test_marking_unmarked_stairs(tmp_path):
    files = [(p.name, p.read_text()) for p in (ground_plan(tmp_path), upper_plan(tmp_path, with_shafts=False))]
    draft = Draft.from_svgs(files, "x")
    assert draft.building["vertical_connectors"] == []
    with pytest.raises(EngineError):
        draft.mark_stairs(["0.00 (Ground floor)"])  # one floor isn't a staircase
    upstairs_corridor = next(s for s in draft.building["spaces"] if s["floor_id"].endswith("F1")
                             and s["type"] == "corridor")
    draft.mark_stairs(["0.00 (Ground floor)", upstairs_corridor["id"]], name="Main stairs")
    connector = draft.building["vertical_connectors"][0]
    assert connector["name"] == "Main stairs" and connector["step_free"] is False


def test_builder_agent_has_edit_tools_and_sees_edits(draft):
    session = Session(draft.loaded(), draft=draft)
    client = FakeClient([
        ([("plan_summary", {}), ("set_room_type", {"rooms": ["0.01"], "room_type": "lab"}),
          ("room_details", {"room": "Lab 0.01"})], "Room 0.01 is now a lab."),
    ])
    agent = BuildingAgent(session, client, mode=BUILDER)
    assert agent.ask("0.01 is a lab") == "Room 0.01 is now a lab."
    names = tool_names(client.requests[0])
    assert {"plan_summary", "set_room_type", "mark_stairs", "save_building", "ask_user", "show_on_map"} <= names
    assert "submit_answer" not in names and "set_closed" not in names
    assert all(not error for _, _, error, _ in client.log)  # the lookup after the edit found "Lab 0.01"


def test_builder_tools_only_in_builder_mode(tiny):
    assert "plan_summary" not in {tool.name for tool in make_tools(Session(tiny))}


@pytest.fixture
def http(monkeypatch, tmp_path):
    monkeypatch.setattr(builder_module, "IMPORTED", tmp_path / "imported")
    monkeypatch.setattr(server, "DATA", tmp_path)  # only imported buildings are listed in this test
    server.forget_buildings()
    with TestClient(server.app) as client:
        yield client
    server.forget_buildings()


def test_import_chat_and_save_over_http(http, tmp_path, monkeypatch):
    plans = [{"name": p.name, "svg": p.read_text()} for p in (ground_plan(tmp_path), upper_plan(tmp_path))]
    fake = FakeClient([([("set_room_type", {"rooms": ["0.01", "0.02"], "room_type": "office"}),
                         ("save_building", {"name": "Test Hall"})], "Saved.")])
    monkeypatch.setattr(server, "client", lambda: fake)
    started = http.post("/imports", json={"files": plans}).json()
    assert started["summary"]["floors"][1]["level"] == 1
    reply = http.post(f"/sessions/{started['session_id']}/chat", json={"text": "both are offices, save it"}).json()
    assert reply["reply"] == "Saved."
    ids = [row["id"] for row in http.get("/buildings").json()]
    assert started["building_id"] in ids
    detail = http.get(f"/buildings/{started['building_id']}").json()
    assert any(space["name"] == "Office 0.01" for space in detail["spaces"])


def test_import_errors_and_explicit_save(http, tmp_path):
    bad = http.post("/imports", json={"files": [{"name": "floor_0.svg", "svg": "<svg xmlns='http://www.w3.org/2000/svg'/>"}]})
    assert bad.status_code == 422
    plans = [{"name": "floor_0.svg", "svg": ground_plan(tmp_path).read_text()}]
    started = http.post("/imports", json={"files": plans, "name": "Shed"}).json()
    saved = http.post(f"/imports/{started['session_id']}/save", json={}).json()
    assert saved["saved"] and http.get(f"/buildings/{saved['building_id']}").status_code == 200


def test_real_building_round_trip_through_the_builder(tmp_path):
    path = DATA / "dev" / "proc-factory-dev-003"
    files = [(p.name, p.read_text()) for p in sorted(path.glob("floor_*.svg"))]
    draft = Draft.from_svgs(files, "rt")
    truth = Building.load(path)
    assert len(draft.building["spaces"]) == len(truth.spaces)
    assert draft.summary()["name"] == truth.info["name"]
