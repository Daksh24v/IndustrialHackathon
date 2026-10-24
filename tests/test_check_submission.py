"""The free pre-submission checker."""

import csv

from evals.check_submission import answers_agree, check
from tests.conftest import DATA


def template_ids() -> list[str]:
    with (DATA / "test" / "submission_template.csv").open(encoding="utf-8", newline="") as handle:
        return [row["question_id"] for row in csv.DictReader(handle)]


def write(path, rows, header=("question_id", "answer")):
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)
    return path


def test_the_committed_submission_has_the_right_format():
    assert not check(DATA.parent / "submission" / "team_answers.csv").format_errors


def test_missing_duplicate_and_unknown_ids_are_reported(tmp_path):
    ids = template_ids()
    rows = [(qid, "Answer: 1") for qid in ids[1:]] + [(ids[1], "Answer: 2"), ("nope", "Answer: 3")]
    report = check(write(tmp_path / "a.csv", rows))
    text = " ".join(report.format_errors)
    assert "missing" in text and "duplicate" in text and "unknown" in text


def test_bad_header_and_answer_lines(tmp_path):
    report = check(write(tmp_path / "a.csv", [(qid, "no answer here") for qid in template_ids()], ("id", "reply")))
    assert any("header" in error for error in report.format_errors)
    assert len(report.answer_errors) == len(template_ids())


def test_agreement_rules():
    assert answers_agree("errand", "Answer: 50.39", "x\nAnswer: 50.9")  # within 1 m
    assert not answers_agree("errand", "Answer: 50", "Answer: 55")
    assert answers_agree("shared_walls_count", "Answer: 5", "Answer: 5")
    assert not answers_agree("shared_walls_count", "Answer: 5", "Answer: 6")
    assert answers_agree("largest_room", "Answer: Festsaal, 557.68 m²", "Answer: Festsaal (1.05), 557.7 m²")
    assert not answers_agree("largest_room", "Answer: Festsaal, 557.68 m²", "Answer: Loggia, 80 m²")
    assert answers_agree("room_stacked", "Answer: Großer Saal (E01)", "Answer: Großer Saal")
    assert not answers_agree("room_stacked", "Answer: Passage", "Answer: Büro")
