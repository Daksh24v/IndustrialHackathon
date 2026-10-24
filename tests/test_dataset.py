"""The engine and the question parser against the dataset's own answers (dev split; train with --train)."""

import pytest

from benchmark.score import score_reply
from navcore.engine import Building, Constraints, EngineError
from navcore.questions import answer_deterministic, parse_all
from tests.conftest import questions

_buildings: dict = {}


def building(directory) -> Building:
    if directory not in _buildings:
        _buildings[directory] = Building.load(directory)
    return _buildings[directory]


def splits(config) -> list[str]:
    return ["dev", "train"] if config.getoption("--train") else ["dev"]


def pytest_generate_tests(metafunc):
    selected = splits(metafunc.config)
    if "route_question" in metafunc.fixturenames:
        items = [item for split in selected for item in questions(split, "questions_basic.jsonl")
                 if item[1]["kind"] in ("route", "route_step_free", "route_with_closure", "tour")]
        metafunc.parametrize("route_question", items, ids=[item[1]["id"] for item in items])
    if "benchmark_question" in metafunc.fixturenames:
        items = [item for split in selected for item in questions(split)]
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


# Rooms whose name exists several times on their floor; no rule in the question picks the right one.
GENUINELY_AMBIGUOUS = {"osm-way37850565-H03", "osm-way37850565-H04"}


def test_parser_reads_the_question_like_the_generator(benchmark_question):
    directory, question = benchmark_question
    readings = parse_all(building(directory), question["question"])
    assert readings, "wording not recognised"
    assert readings[0].kind == question["kind"]
    expected = {key: value for key, value in question["inputs"].items() if key not in ("target",)}
    assert any(all(reading.inputs.get(key) == value for key, value in expected.items()) for reading in readings)


def test_benchmark_reply_scores(benchmark_question):
    directory, question = benchmark_question
    if question["id"] in GENUINELY_AMBIGUOUS:
        pytest.xfail("room name is ambiguous in the source data")
    reply = answer_deterministic(building(directory), question["question"])
    assert reply is not None
    assert score_reply(question["answer"], reply), reply
