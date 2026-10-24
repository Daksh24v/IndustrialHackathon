"""The eval machinery itself: warm-up checker, rewrite faithfulness, set construction respecting 80/20."""

from evals.reword import faithful, protected_names
from evals.run import check_warmup
from evals.sets import build_sets
from holdout.split import BUILD_LIST, HOLDOUT_LIST, read
from navcore.engine import Building


def test_build_sets_never_touch_the_holdout():
    holdout = read(HOLDOUT_LIST)
    build = read(BUILD_LIST)
    for items in build_sets().values():
        assert items
        assert all(item["building_id"] in build and item["building_id"] not in holdout for item in items)


def test_warmup_checker():
    route = {"kind": "route", "answer": {"optimal_length_m": 100.0}}
    assert check_warmup(route, "Go there.\nAnswer: 100.5")
    assert not check_warmup(route, "Answer: 102")  # more than 1% off
    assert not check_warmup(route, "Answer: 100 or 105")  # two numbers
    assert not check_warmup(route, "No answer line")
    short = {"kind": "route", "answer": {"optimal_length_m": 20.0}}
    assert check_warmup(short, "Answer: 20.9")  # at least 1 m tolerance
    blocked = {"kind": "route_step_free", "answer": {"reachable": False}}
    assert check_warmup(blocked, "Answer: No step-free route exists.")
    assert not check_warmup(blocked, "Answer: 40")
    assert check_warmup(blocked, "Answer: No route from Bedroom 1.23 (Floor 1) to Bedroom 2.28 (Floor 2).")
    assert not check_warmup(blocked, "Answer: not via stairs, 40 m via the lift")
    count = {"kind": "count", "answer": {"count": 3}}
    assert check_warmup(count, "Answer: 3") and not check_warmup(count, "Answer: 4")


def test_locate_checker_uses_the_room(tiny: Building, monkeypatch):
    monkeypatch.setattr("evals.run.Building.load", lambda path: tiny)
    question = {"kind": "locate", "building_path": "x", "answer": {"space_id": "T-F0-S2"}}
    assert check_warmup(question, "Answer: Lab 0.02")
    assert not check_warmup(question, "Answer: Office 0.01")


def test_rewrite_must_keep_names_and_numbers(tiny: Building):
    original = "I'm moving a 1.1 m wide trolley into Lab 0.02 (Ground floor). Finish with a line 'Answer: <number>'."
    assert protected_names(tiny, original) == ["Ground floor", "Lab 0.02"]
    good = "Got a trolley, 1.1 m wide - can it reach Lab 0.02 (Ground floor)? Finish with a line 'Answer: <number>'."
    assert faithful(original, good, tiny)
    assert not faithful(original, good.replace("1.1", "1.2"), tiny)  # number changed
    assert not faithful(original, good.replace("Lab 0.02", "the lab"), tiny)  # name lost
    assert not faithful(original, original, tiny)  # not reworded at all
