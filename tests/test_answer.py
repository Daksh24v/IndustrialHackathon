"""The one-command benchmark run, with a fake answer function (no API)."""

import csv

from navagent import benchmark
from navagent.benchmark import load_questions, run, select
from tests.conftest import DATA


def test_question_sources():
    assert len(load_questions(DATA / "test")) == 145
    assert len(load_questions(DATA / "test" / "questions.csv")) == 145
    single = load_questions(DATA / "dev" / "proc-factory-dev-003")
    assert single and all(item.building.name == "proc-factory-dev-003" for item in single)


def test_select_per_kind_and_buildings():
    items = load_questions(DATA / "test")
    one_each = select(items, 1, None)
    assert len(one_each) == len({item.question["kind"] for item in items})
    only = select(items, None, {"osm-way363805324"})
    assert only and all(item.building.name == "osm-way363805324" for item in only)


def test_run_writes_csv_scores_and_resumes(tmp_path, monkeypatch):
    calls = []

    def fake_answer(directory, text, question_id=None, double_check=False):
        calls.append(question_id)
        return "Answer: 1"

    monkeypatch.setattr(benchmark, "answer", fake_answer)
    out = tmp_path / "answers.csv"
    source = DATA / "dev" / "proc-factory-dev-003"
    run(source, out)
    with out.open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert rows and set(rows[0]) == {"question_id", "answer"}
    first_run = len(calls)
    run(source, out, resume=True)  # everything is answered already: no new calls, no new cost
    assert len(calls) == first_run


def test_a_crashing_question_does_not_stop_the_run(tmp_path, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(benchmark, "answer", broken)
    out = tmp_path / "answers.csv"
    run(DATA / "dev" / "proc-factory-dev-003", out)
    assert "boom" in out.read_text(encoding="utf-8")
