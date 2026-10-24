"""The engine and the agent's tools against the dataset's own answers.

By default only the 'build' buildings (holdout/build.txt) are used. The locked hold-out runs only with
--holdout, at checkpoints: never tune anything on it."""

import pytest

from benchmark.score import score_reply
from holdout.split import BUILD_LIST, HOLDOUT_LIST, read
from navagent.tools import Session
from navcore.engine import Building, Constraints, EngineError
from tests.conftest import questions

_buildings: dict = {}


def building(directory) -> Building:
    if directory not in _buildings:
        _buildings[directory] = Building.load(directory)
    return _buildings[directory]


def selected(config, filename: str) -> list:
    keep = read(HOLDOUT_LIST) if config.getoption("--holdout") else read(BUILD_LIST)
    items = questions("train", filename) + questions("dev", filename)
    return [item for item in items if item[0].name in keep]


def pytest_generate_tests(metafunc):
    if "route_question" in metafunc.fixturenames:
        items = [item for item in selected(metafunc.config, "questions_basic.jsonl")
                 if item[1]["kind"] in ("route", "route_step_free", "route_with_closure", "tour")]
        metafunc.parametrize("route_question", items, ids=[item[1]["id"] for item in items])
    if "benchmark_question" in metafunc.fixturenames:
        items = selected(metafunc.config, "questions.jsonl")
        metafunc.parametrize("benchmark_question", items, ids=[item[1]["id"] for item in items])


def test_route_lengths_match_to_the_centimetre(route_question):
    directory, question = route_question
    answer = question["answer"]
    closed = frozenset([answer["closed_element_id"]]) if answer.get("closed_element_id") else frozenset()
    constraints = Constraints(step_free=question["kind"] == "route_step_free", closed=closed)
    target = building(directory)
    if answer.get("reachable") is False:
        with pytest.raises(EngineError):
            target.route(answer["from_space_id"], answer["to_space_id"], constraints)
        return
    if question["kind"] == "tour":
        length = sum(leg.length_m for leg in target.tour(answer["stops"], constraints))
    else:
        length = target.route(answer["from_space_id"], answer["to_space_id"], constraints).length_m
    assert length == pytest.approx(answer["optimal_length_m"], abs=0.011)


def call_tools_like_the_agent(session: Session, question: dict) -> None:
    """What a correct agent does for each kind, using the dataset's resolved inputs: the tools plus
    submit_answer must then produce a reply the official scorer accepts."""
    inputs, kind = question["inputs"], question["kind"]
    text = question["question"].replace("’", "'")
    if kind == "largest_room":
        best = session.largest_room(inputs["floor_id"], inputs["room_type"])["largest"]["id"]
        session.submit_answer("room", room=best, include_area=True)
    elif kind == "floor_area_total":
        session.submit_answer("number", session.list_rooms(inputs["floor_id"], inputs["room_type"])["total_area_m2"])
    elif kind == "errand":
        target = session.largest_room(inputs["floor_id"], inputs["room_type"])["largest"]["id"]
        step_free = "can't carry" in text or "cannot carry" in text
        walk = session.errand_walk(inputs["start"], inputs["asset_type"], target, step_free)
        session.submit_answer("number", walk["total_walk_m"])
    elif kind == "wide_delivery_count":
        result = session.reachable_rooms(inputs["start"], inputs["floor_id"], True, inputs["min_width"])
        session.submit_answer("number", result["reachable_rooms"])
    elif kind == "step_free_reachable_count":
        result = session.reachable_rooms(inputs["start"], inputs["floor_id"], True, avoid=[inputs["closed"]])
        session.submit_answer("number", result["reachable_rooms"])
    elif kind == "room_stacked":
        stacked = session.stacked_room(inputs["start"], inputs["direction"])["stacked"]["id"]
        session.submit_answer("room", room=stacked)
    elif kind == "shared_walls_count":
        session.submit_answer("number", session.wall_neighbours(inputs["start"])["count"])
    elif kind == "straight_line_3d":
        session.submit_answer("number", session.straight_line(inputs["first"], inputs["second"])["distance_m"])
    elif kind == "what_if_door":
        result = session.what_if_door(inputs["first"], inputs["second"], inputs["floor_id"])
        session.submit_answer("number", result["rooms_with_shorter_exit"])
    else:
        pytest.fail(f"unknown kind {kind}")


def test_tools_and_answer_line_score(benchmark_question):
    directory, question = benchmark_question
    session = Session(building(directory))
    call_tools_like_the_agent(session, question)
    reply = f"Worked it out with the tools.\n{session.answer_line()}"
    assert score_reply(question["answer"], reply), reply
