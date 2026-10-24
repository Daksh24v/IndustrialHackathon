"""The benchmark entry point and the one-command run."""

import csv

from navagent import answer as answer_module
from navagent.benchmark import load_questions, run
from tests.conftest import DATA, questions


def test_every_test_question_is_recognised(monkeypatch):
    monkeypatch.setenv(answer_module.OFFLINE_ENVIRONMENT_VARIABLE, "1")
    for directory, question in questions("test"):
        reply = answer_module.answer(directory, question["question"])
        assert "Answer:" in reply, question["id"]


def test_unknown_wording_goes_to_the_agent(monkeypatch):
    asked = []

    class FakeAgent:
        def __init__(self, session):
            self.session = session

        def ask(self, text):
            asked.append(text)
            return "Answer: 42"

    monkeypatch.delenv(answer_module.OFFLINE_ENVIRONMENT_VARIABLE, raising=False)
    monkeypatch.setattr("navagent.agent.BuildingAgent", FakeAgent)
    directory = DATA / "dev" / "proc-factory-dev-003"
    assert answer_module.answer(directory, "Where can I get coffee?") == "Answer: 42"
    assert asked == ["Where can I get coffee?"]


def test_question_sources():
    assert len(load_questions(DATA / "test")) == 145
    assert len(load_questions(DATA / "test" / "questions.csv")) == 145
    single = load_questions(DATA / "dev" / "proc-factory-dev-003")
    assert single and all(directory.name == "proc-factory-dev-003" for directory, _ in single)


def test_run_writes_the_submission_and_scores(tmp_path, monkeypatch):
    monkeypatch.setenv(answer_module.OFFLINE_ENVIRONMENT_VARIABLE, "1")
    out = tmp_path / "answers.csv"
    results = run(DATA / "dev" / "proc-factory-dev-003", out)
    with out.open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert rows and set(rows[0]) == {"question_id", "answer"}
    assert sum(count for (_, ok), count in results.items() if not ok) == 0
