"""The agent's tools, called directly (no API)."""

import json

import pytest
from anthropic.lib.tools import ToolError

from navagent.agent import BuildingAgent, make_tools
from navagent.tools import Session
from navcore.engine import Building, EngineError


@pytest.fixture
def session(tiny: Building) -> Session:
    return Session(tiny)


def test_overview_lists_floors_and_connectors(session: Session):
    overview = session.overview()
    assert [floor["name"] for floor in overview["floors"]] == ["Ground floor", "Floor 1"]
    assert {item["name"] for item in overview["stairs_and_lifts"]} == {"Stairs 1", "Lift 1"}
    assert overview["entrances"][0]["into"] == "Corridor 0.00 (Ground floor)"


def test_search_and_list_rooms(session: Session):
    found = session.search("fire extinguisher")
    assert found["assets"][0]["in"] == "Lab 0.02 (Ground floor)"
    listed = session.list_rooms("ground floor", "office")
    assert listed["count"] == 1 and listed["total_area_m2"] == pytest.approx(16.0)
    with pytest.raises(EngineError):
        session.search("submarine")


def test_room_details(session: Session):
    details = session.room_details("Office 0.01 (Ground floor)")
    assert details["directly_above"] == "Office 1.01 (Floor 1)"
    assert details["doors"][0]["width_m"] == 0.9


def test_route_with_closure_and_tour(session: Session):
    open_route = session.route("Office 0.01", "Office 1.01")
    session.set_closed("Stairs 1", True)
    detour = session.route("Office 0.01", "Office 1.01")
    assert detour["length_m"] > open_route["length_m"]  # the lift costs more than the stairs
    assert any("lift" in step.lower() for step in detour["legs"][0]["steps"])
    tour = session.route("Office 0.01", "Office 1.01", via=["Lab 0.02"])
    assert len(tour["legs"]) == 2


def test_wide_load_and_reachability(session: Session):
    result = session.reachable_rooms("Corridor 0.00", "ground floor", step_free=True, min_width_m=1.1)
    assert result["reachable_rooms"] == 1 and result["rooms_on_floor"] == 2


def test_add_door_changes_routes(session: Session):
    with pytest.raises(EngineError):
        session.add_door("Office 0.01", "Lab 0.02")  # no shared wall
    added = session.add_door("Office 0.01", "Corridor 0.00", width_m=1.2)
    assert added["added"]["width_m"] == 1.2
    assert session.room_details("Office 0.01")["doors"][-1]["width_m"] == 1.2


def test_nearest_exit_and_asset(session: Session):
    assert session.nearest_exit("Lab 0.02")["walk_m"] > 0
    with pytest.raises(EngineError):
        session.nearest_exit("Lab 0.02", step_free=True)  # the entrance has a step
    assert session.nearest_with_asset("Office 0.01", "fire extinguisher")["space_id"] == "T-F0-S2"


def test_claude_tools_have_schemas_and_turn_errors_into_tool_errors(session: Session):
    tools = {tool.name: tool for tool in make_tools(session)}
    assert {"find_route", "list_rooms", "room_details", "reachable_rooms", "what_if_door"} <= set(tools)
    schema = tools["find_route"].to_dict()["input_schema"]
    assert schema["required"] == ["start", "destination"]
    assert json.loads(tools["list_rooms"].call({"floor": "Ground floor"}))["count"] == 3
    with pytest.raises(ToolError):
        tools["room_details"].call({"room": "nowhere"})


class FakeClient:
    """Stands in for anthropic.Anthropic: the agent's construction must not need the network."""

    beta = None


def test_agent_builds_a_cached_system_prompt(session: Session):
    agent = BuildingAgent(session, client=FakeClient())
    assert agent.system[0]["cache_control"] == {"type": "ephemeral"}
    assert "Tiny" in agent.system[0]["text"]
