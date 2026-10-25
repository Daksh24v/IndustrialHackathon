"""Free checks on a submission CSV before it is handed in (no API calls).

  uv run python -m evals.check_submission <answers.csv or answers.json> [--reference <other.csv>]
  uv run python -m evals.check_submission results/team_answers.csv --write-json SUBMISSION/answers.json

The organisers grade SUBMISSION/answers.json (with SUBMISSION/BENCHMARK.md, nothing else in the folder): a list
of {"question_id": ..., "answer": full reply}, written from the CSV the benchmark run makes, never edited by hand.

1. format: UTF-8, header question_id,answer, at most 5 MB, every test id exactly once, nothing extra;
2. answer lines: each reply has an 'Answer:' line that the scorer can read for its kind
   (number kinds: exactly one number; largest_room: a room and an area; room_stacked: a room);
3. agreement (with --reference): compares each answer with another run's, within the scorer's tolerances,
   and lists the questions where they differ so their logs can be read. Answers are never edited by hand."""

import argparse
import csv
import io
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

from benchmark.score import committed_answer, numbers_in
from navagent.benchmark import answers_json

DATA = Path(__file__).resolve().parent.parent / "data"
MAX_BYTES = 5 * 1024 * 1024
HEADER = ["question_id", "answer"]
# Tolerances from CHALLENGE.md section 6: (relative, absolute).
NUMBER_KINDS = {
    "errand": (0.01, 1.0),
    "floor_area_total": (0.05, 0.0),
    "wide_delivery_count": (0.0, 0.0),
    "step_free_reachable_count": (0.0, 0.0),
    "shared_walls_count": (0.0, 0.0),
    "what_if_door": (0.0, 0.0),
    "straight_line_3d": (0.02, 0.0),
}
ROOM_KINDS = {"largest_room", "room_stacked"}


@dataclass
class Report:
    format_errors: list[str] = field(default_factory=list)
    answer_errors: list[str] = field(default_factory=list)
    agree: int = 0
    disagreements: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.format_errors and not self.answer_errors


def test_kinds() -> dict[str, str]:
    kinds = {}
    for path in sorted((DATA / "test").glob("*/questions.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                question = json.loads(line)
                kinds[question["id"]] = question["kind"]
    return kinds


def read_rows(raw: bytes, report: Report) -> dict[str, str]:
    if len(raw) > MAX_BYTES:
        report.format_errors.append(f"file is {len(raw)} bytes, more than 5 MB")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        report.format_errors.append("not UTF-8")
        return {}
    reader = csv.reader(io.StringIO(text, newline=""))
    header = next(reader, None)
    if header != HEADER:
        report.format_errors.append(f"header is {header}, expected {HEADER}")
    rows: dict[str, str] = {}
    for row in reader:
        if len(row) != 2:
            report.format_errors.append(f"row with {len(row)} columns: {row[:1]}")
            continue
        if row[0] in rows:
            report.format_errors.append(f"duplicate id {row[0]} (only the first counts)")
            continue
        rows[row[0]] = row[1]
    return rows


def read_json(raw: bytes, report: Report) -> dict[str, str]:
    if len(raw) > MAX_BYTES:
        report.format_errors.append(f"file is {len(raw)} bytes, more than 5 MB")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        report.format_errors.append(f"not UTF-8 JSON: {error}")
        return {}
    if not isinstance(data, list) or not all(
            isinstance(row, dict) and set(row) == {"question_id", "answer"}
            and isinstance(row["question_id"], str) and isinstance(row["answer"], str) for row in data):
        report.format_errors.append('expected a list of {"question_id": ..., "answer": ...}')
        return {}
    rows: dict[str, str] = {}
    for row in data:
        if row["question_id"] in rows:
            report.format_errors.append(f"duplicate id {row['question_id']} (only the first counts)")
            continue
        rows[row["question_id"]] = row["answer"]
    return rows


def write_json(rows: dict[str, str], path: Path) -> None:
    """The answers as SUBMISSION/answers.json, in the CSV's order."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(answers_json(rows), encoding="utf-8")


def read_any(path: Path, report: Report) -> dict[str, str]:
    return read_json(path.read_bytes(), report) if path.suffix == ".json" else read_rows(path.read_bytes(), report)


def room_part(line: str) -> str:
    """The room named in an answer line: everything before ', <area> m²' if there is one."""
    return line.split(",")[0].strip().lower()


def answers_agree(kind: str, first: str, second: str) -> bool:
    a, b = committed_answer(first), committed_answer(second)
    if a is None or b is None:
        return False
    if kind in NUMBER_KINDS:
        relative, absolute = NUMBER_KINDS[kind]
        x, y = numbers_in(a), numbers_in(b)
        if len(x) != 1 or len(y) != 1:
            return False
        return abs(x[0] - y[0]) <= max(abs(y[0]) * relative, absolute) + 1e-9
    room_a, room_b = room_part(a), room_part(b)
    same_room = room_a == room_b or room_a in room_b or room_b in room_a
    if kind == "largest_room":
        areas_a, areas_b = numbers_in(a)[-1:], numbers_in(b)[-1:]
        return same_room and bool(areas_a and areas_b) and abs(areas_a[0] - areas_b[0]) <= 0.05 * areas_b[0]
    return same_room


def check(path: Path, reference: Path | None = None) -> Report:
    report = Report()
    kinds = test_kinds()
    with (DATA / "test" / "submission_template.csv").open(encoding="utf-8", newline="") as handle:
        expected_ids = [row["question_id"] for row in csv.DictReader(handle)]
    rows = read_any(path, report)
    missing = [qid for qid in expected_ids if qid not in rows]
    extra = [qid for qid in rows if qid not in set(expected_ids)]
    if missing:
        report.format_errors.append(f"{len(missing)} test ids missing, e.g. {missing[:3]}")
    if extra:
        report.format_errors.append(f"{len(extra)} unknown ids, e.g. {extra[:3]}")
    for qid, reply in rows.items():
        kind = kinds.get(qid, "?")
        line = committed_answer(reply)
        if line is None:
            report.answer_errors.append(f"{qid}: no 'Answer:' line")
            continue
        if reply.startswith("Error while answering"):
            report.answer_errors.append(f"{qid}: the run failed")
        if kind in NUMBER_KINDS and len(numbers_in(line)) != 1:
            report.answer_errors.append(f"{qid} ({kind}): answer line needs exactly one number: {line[:60]}")
        if kind == "largest_room" and not (numbers_in(line) and "," in line):
            report.answer_errors.append(f"{qid} (largest_room): needs '<room>, <area> m²': {line[:60]}")
        if kind == "room_stacked" and not line.strip():
            report.answer_errors.append(f"{qid} (room_stacked): empty answer")
    if reference is not None:
        other = read_any(reference, Report())
        for qid, reply in rows.items():
            if qid not in other:
                continue
            if answers_agree(kinds.get(qid, "?"), reply, other[qid]):
                report.agree += 1
            else:
                report.disagreements.append(
                    f"{qid} ({kinds.get(qid)}): {committed_answer(reply)!r} vs {committed_answer(other[qid])!r}")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(prog="evals.check_submission")
    parser.add_argument("csv", type=Path, help="the answers, .csv or .json")
    parser.add_argument("--reference", type=Path, default=None, help="another run's answers to compare with")
    parser.add_argument("--write-json", type=Path, default=None, help="also write them as answers.json here")
    arguments = parser.parse_args()
    report = check(arguments.csv, arguments.reference)
    if arguments.write_json and not report.format_errors:
        write_json(read_any(arguments.csv, Report()), arguments.write_json)
        print(f"wrote {arguments.write_json}")
    print(f"format: {'OK' if not report.format_errors else 'PROBLEMS'}")
    for error in report.format_errors:
        print(f"  {error}")
    print(f"answer lines: {'OK' if not report.answer_errors else 'PROBLEMS'}")
    for error in report.answer_errors:
        print(f"  {error}")
    if arguments.reference:
        total = report.agree + len(report.disagreements)
        print(f"agreement with {arguments.reference}: {report.agree} / {total}")
        for line in report.disagreements:
            print(f"  {line}")
    sys.exit(0 if report.ok else 1)


if __name__ == "__main__":
    main()
