"""The one-command run on every input we might get on Sunday, with a fake agent (free, no API): every question
gets a row, whatever the file is called or how the building comes; failures are rows, and --resume redoes them."""

import csv
import json
import shutil
from pathlib import Path

import pytest

from navagent import benchmark
from navcore.engine import Building

DATA = Path(__file__).resolve().parent.parent / "data"
TEST = DATA / "test"
SMALL = "resplan-3573"  # one floor, a few rooms: quick to copy and to build from its plan


def fake_answer(building_directory, question, question_id, double_check):
    spaces = len(Building.load(building_directory).spaces)  # the building really loads
    return f"Thought about it.\nAnswer: {spaces}"


@pytest.fixture
def fake(monkeypatch):
    monkeypatch.setattr(benchmark, "answer", fake_answer)


def answers(out: Path) -> dict[str, str]:
    with out.open(encoding="utf-8", newline="") as handle:
        return {row["question_id"]: row["answer"] for row in csv.DictReader(handle)}


def ids_in(path: Path, field: str) -> list[str]:
    with path.open(encoding="utf-8", newline="") as handle:
        return [row[field] for row in csv.DictReader(handle)]


def test_the_kits_questions_csv_with_question_id(fake, tmp_path):
    expected = ids_in(TEST / "questions.csv", "question_id")[:12]
    table = tmp_path / "test" / "questions.csv"
    table.parent.mkdir()
    with (TEST / "questions.csv").open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))[:12]
    with table.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    for row in rows:  # the buildings next to the table, as in data/test
        if not (table.parent / row["building_id"]).exists():
            (table.parent / row["building_id"]).symlink_to(TEST / row["building_id"])
    out = tmp_path / "answers.csv"
    benchmark.run(table, out)
    written = answers(out)
    assert list(written) == expected and all("Answer:" in reply for reply in written.values())


def test_one_building_with_a_renamed_questions_file_and_no_ids(fake, tmp_path):
    building = tmp_path / "sunday-building"
    shutil.copytree(TEST / SMALL, building)
    questions = [json.loads(line) for line in (building / "questions.jsonl").read_text().splitlines() if line]
    (building / "questions.jsonl").unlink()
    (building / "sunday_questions.jsonl").write_text(
        "".join(json.dumps({"question": q["question"]}) + "\n" for q in questions), encoding="utf-8")
    out = tmp_path / "answers.csv"
    benchmark.run(building, out)
    written = answers(out)
    assert list(written) == [f"sunday-building-Q{n:03d}" for n in range(1, len(questions) + 1)]
    assert all("Answer:" in reply for reply in written.values())


def test_plans_only_are_built_first_with_the_equipment_list(fake, tmp_path):
    building = tmp_path / SMALL
    shutil.copytree(TEST / SMALL, building)
    (building / "building.json").unlink()
    out = tmp_path / "answers.csv"
    benchmark.run(building, out)
    built = json.loads((building / "building.json").read_text())
    truth = json.loads((TEST / SMALL / "building.json").read_text())
    assert len(built["spaces"]) == len(truth["spaces"])
    assert built["assets"] and {space["name"] for space in built["spaces"]} & {space["name"] for space in truth["spaces"]}
    assert all("Answer:" in reply for reply in answers(out).values())


def test_a_missing_building_is_an_error_row_and_resume_redoes_it(fake, tmp_path, monkeypatch):
    table = tmp_path / "questions.csv"
    table.write_text("question_id,building_id,question\nq1,nowhere,Where is it?\n"
                     f"q2,{SMALL},How big?\n", encoding="utf-8")
    (tmp_path / SMALL).symlink_to(TEST / SMALL)
    out = tmp_path / "answers.csv"
    benchmark.run(table, out)
    first = answers(out)
    assert first["q1"].startswith(benchmark.ERROR_PREFIX) and "Answer:" in first["q2"]
    (tmp_path / "nowhere").symlink_to(TEST / SMALL)  # the building turns up
    calls = []
    monkeypatch.setattr(benchmark, "answer", lambda *args: calls.append(args[2]) or fake_answer(*args))
    benchmark.run(table, out, resume=True)
    assert calls == ["q1"], "only the failed row is answered again"
    assert "Answer:" in answers(out)["q1"]
