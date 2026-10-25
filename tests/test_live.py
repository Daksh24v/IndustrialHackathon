"""Paid tests: they call the Claude API. Skipped unless run with --live (and a key in .env)."""

import pytest

from navagent.agent import CHAT, BuildingAgent
from navagent.tools import Session
from navcore.engine import Building
from tests.conftest import DATA

pytestmark = pytest.mark.live

FACTORY = DATA / "dev" / "proc-factory-dev-003"


def test_nearest_question_on_several_floors_asks_for_the_floor_with_options():
    agent = BuildingAgent(Session(Building.load(FACTORY)), mode=CHAT)
    agent.ask("Where is the nearest toilet?")
    question = agent.session.pending_question
    assert question is not None, "it should ask where the person is"
    building = agent.session.building
    real = ({floor["name"] for floor in building.floors.values()} | {space["name"] for space in building.spaces.values()}
            | {asset["name"] for asset in building.assets.values()} | {c["name"] for c in building.connectors.values()})
    labels = [option["label"] for option in question["options"]]
    assert 2 <= len(labels) <= 4
    assert all(any(name.lower() in label.lower() for name in real) for label in labels), labels  # nothing made up


def test_it_does_not_ask_what_it_was_told():
    agent = BuildingAgent(Session(Building.load(FACTORY)), mode=CHAT)
    reply = agent.ask("I'm in Quality lab 0.21 on the ground floor. How far is it to the nearest exit?")
    assert agent.session.pending_question is None
    assert "m" in reply


# ---------- the scripted tricky users of the Interaction test ----------

LAB = "proc-factory-dev-003-F0-S021"  # Quality lab 0.21 (Ground floor)
OFFICE = "proc-factory-dev-003-F1-S004"  # Office 1.04 (Floor 1)


def factory_agent() -> BuildingAgent:
    return BuildingAgent(Session(Building.load(FACTORY)), mode=CHAT)


def test_a_room_that_does_not_exist_is_said_plainly():
    agent = factory_agent()
    reply = agent.ask("I'm in the quality lab. Take me to room 9.99.")
    assert agent.session.active_route is None, "no route to a room that doesn't exist"
    assert "9.99" in reply or agent.session.pending_question is not None


def test_a_name_without_its_number_is_understood_and_echoed():
    agent = factory_agent()
    reply = agent.ask("Where is the quality lab?")
    assert agent.session.pending_question is None
    assert "0.21" in reply or "Quality lab" in reply
    assert agent.session.map_view and agent.session.map_view["target"]["space_id"] == LAB


def test_a_phone_position_is_used_and_progress_is_followed():
    agent = factory_agent()
    agent.session.set_position("Quality lab 0.21 (Ground floor)", source="phone")
    agent.ask("Take me to office 1.04.")
    assert agent.session.pending_question is None, "it knew where the person was"
    route = agent.session.active_route
    assert route and route["stops"][0] == LAB and route["destination"] == OFFICE
    halfway = agent.session.building.label(route["spaces"][len(route["spaces"]) // 2])
    agent.ask(f"OK, I'm in {halfway.split(' (')[0]} now.")
    assert agent.session.position.label == halfway, "it recorded where they said they are"
    assert agent.session.pending_question is None


def test_changing_their_mind_halfway_reroutes_from_where_they_are():
    agent = factory_agent()
    agent.session.set_position("Quality lab 0.21 (Ground floor)", source="phone")
    agent.ask("Take me to office 1.04.")
    agent.ask("Actually, I need the locker room instead.")
    route = agent.session.active_route
    assert route and agent.session.building.spaces[route["destination"]]["name"].startswith("Locker room")
    assert route["stops"][0] == LAB


def test_a_wheelchair_user_is_not_asked_twice():
    agent = factory_agent()
    agent.ask("I use a wheelchair and I'm in the quality lab. How do I get to office 1.04?")
    assert agent.session.active_route and agent.session.active_route["step_free"]
    agent.ask("And then to the locker room?")
    assert agent.session.active_route["step_free"], "it remembered the wheelchair"
    assert agent.session.pending_question is None


def test_an_unknown_position_is_asked_once_by_landmarks():
    agent = factory_agent()
    agent.ask("I'm lost on the ground floor. Get me to the locker room.")
    question = agent.session.pending_question
    assert question is not None, "it should ask where they are"
    agent.ask(question["options"][0]["label"])
    assert agent.session.pending_question is None, "one question was enough"
    assert agent.session.active_route is not None


def test_a_facility_manager_closes_the_lift_and_moves_a_machine():
    agent = factory_agent()
    agent.session.set_position("Quality lab 0.21 (Ground floor)", source="phone")
    agent.ask("The office lift is out of service today, and I've moved the coordinate measuring machine to "
              "office 1.04.")
    assert "proc-factory-dev-003-V02" in agent.session.closed, "the lift is closed"
    assert agent.session.moved, "the machine was moved"
    assert agent.session.map_view and agent.session.map_view["changes"], "the map shows the changes"
    reply = agent.ask("I'm in a wheelchair. Take me to the coordinate measuring machine.")
    route = agent.session.active_route
    assert route is None or route["step_free"], "with the only lift closed there is no step-free way up"
    assert "lift" in reply.lower() and "step-free" in reply.lower(), "it says why"


def test_a_forklift_driver_gets_a_forklift_route_around_the_blocked_aisle():
    agent = factory_agent()
    reply = agent.ask("I'm driving a forklift in Warehouse zone H-C1 and Main aisle H-B2 is blocked by a pallet. "
                      "Take me to Logistics zone H-C5.")
    session = agent.session
    assert session.profile is not None and session.profile.name == "forklift"
    assert "proc-factory-dev-003-F0" in str(session.closed) and session.active_route is not None
    assert "H-B2" not in " ".join(session.building.spaces[s]["name"] for s in session.active_route["spaces"])
    assert "forklift" in reply.lower()


def test_a_wheelchair_user_hears_why_the_route_goes_round():
    agent = factory_agent()
    reply = agent.ask("I use a wheelchair. I'm at Staircase 0.17, how do I get to Staircase 1.02?")
    assert agent.session.profile is not None and agent.session.profile.name == "wheelchair"
    assert "lift" in reply.lower() and ("step" in reply.lower() or "stairs" in reply.lower())
