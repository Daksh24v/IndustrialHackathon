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
    floors = {floor["name"] for floor in agent.session.building.floors.values()}
    rooms = {space["name"] for space in agent.session.building.spaces.values()}
    labels = [option["label"] for option in question["options"]]
    assert 2 <= len(labels) <= 4
    assert all(any(name in label for name in floors | rooms) for label in labels), labels


def test_it_does_not_ask_what_it_was_told():
    agent = BuildingAgent(Session(Building.load(FACTORY)), mode=CHAT)
    reply = agent.ask("I'm in Quality lab 0.21 on the ground floor. How far is it to the nearest exit?")
    assert agent.session.pending_question is None
    assert "m" in reply
