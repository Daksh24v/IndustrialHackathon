"""One command from questions to the submission CSV (documented in BENCHMARK.md).

  uv run --env-file .env python -m navagent.benchmark data/test --out submission.csv

The input can be
- a split directory with <building_id>/questions.jsonl (data/test, data/dev),
- one building directory with building.json and questions.jsonl (the Sunday building),
- a questions.csv / .jsonl with id (or question_id), building_id and question, next to the building directories.
Any *question*.jsonl / .csv name is found; without building_id the only building there is used. A building
given only as floor plans (floor_*.svg) is built from them first (with equipment.csv when present). A question
that can't be answered becomes an error row, never a stopped run; --resume answers those rows again.
If the questions carry answers (train/dev), the replies are also scored."""

import argparse
import csv
import json
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from benchmark.score import score_reply
from navagent.answer import answer
from navcore.plans import enrich_from_equipment, import_plans

QUESTION_FILES = ("questions.jsonl", "questions.csv")
QUESTION_GLOBS = ("*question*.jsonl", "*question*.csv")  # e.g. test_questions.jsonl, sunday_questions.csv
ID_FIELDS = ("id", "question_id", "qid")
ERROR_PREFIX = "Error while answering: "
TEXT_FIELDS = ("question", "text", "prompt")


@dataclass
class Item:
    """One question to answer: its id, its text and the building it is about (or why that wasn't found)."""

    id: str
    question: dict
    building: Path | None
    problem: str | None = None


def read_table(path: Path) -> list[dict]:
    if path.suffix == ".csv":
        with path.open(encoding="utf-8-sig", newline="") as handle:
            return [{key.strip(): value for key, value in row.items() if key} for row in csv.DictReader(handle)]
    return [json.loads(line) for line in path.read_text(encoding="utf-8-sig").splitlines() if line.strip()]


def question_files(directory: Path) -> list[Path]:
    """The questions file of a directory: questions.jsonl / .csv, else any *question*.jsonl / .csv."""
    exact = [directory / name for name in QUESTION_FILES if (directory / name).is_file()]
    if exact:
        return exact[:1]
    found = sorted(path for pattern in QUESTION_GLOBS for path in directory.glob(pattern) if path.is_file())
    return found[:1]


def is_building(directory: Path) -> bool:
    """A building directory: building.json, or floor plans to build it from (floor_*.svg)."""
    return (directory / "building.json").is_file() or any(directory.glob("floor_*.svg"))


def buildings_under(root: Path) -> list[Path]:
    if is_building(root):
        return [root]
    return sorted({path for path in [*root.glob("*"), *root.glob("*/*")] if path.is_dir() and is_building(path)})


def building_json_id(directory: Path) -> str | None:
    try:
        return json.loads((directory / "building.json").read_text(encoding="utf-8"))["building"]["id"]
    except (OSError, ValueError, KeyError, TypeError):
        return None


def find_building(root: Path, building_id: str | None) -> Path:
    """The building a question is about: by its id near the questions, else the only building there is."""
    if building_id:
        for candidate in (root / building_id, root.parent / building_id, *root.glob(f"*/{building_id}")):
            if is_building(candidate):
                return candidate
        for candidate in buildings_under(root):  # the folder may be named differently from the building's id
            if candidate.name == building_id or building_json_id(candidate) == building_id:
                return candidate
        raise FileNotFoundError(f"No building {building_id} (building.json or floor plans) under {root}")
    candidates = buildings_under(root)
    if len(candidates) == 1:
        return candidates[0]
    if is_building(root):
        return root
    raise FileNotFoundError(f"No building.json or floor plans for {building_id or 'this question'} under {root}")


def item(root: Path, row: dict, index: int, building: Path | None = None) -> Item:
    """Never raises: a question whose building can't be found becomes an error row, not a crashed run."""
    building_id = str(row.get("building_id") or "").strip() or None
    problem = None
    if building is None:
        try:
            building = find_building(root, building_id)
        except FileNotFoundError as error:
            problem = str(error)
    question_id = next((str(row[field]).strip() for field in ID_FIELDS if str(row.get(field) or "").strip()), None)
    if question_id is None:
        question_id = f"{building_id or (building.name if building else root.name)}-Q{index + 1:03d}"
    text = next((str(row[field]) for field in TEXT_FIELDS if str(row.get(field) or "").strip()), None)
    if text is None:
        problem = problem or "No question text in this row."
    return Item(question_id, {**row, "question": text or ""}, building, problem)


def load_questions(source: Path) -> list[Item]:
    """Questions in a stable order, from a questions file, one building directory or a split directory."""
    if source.is_file():
        return [item(source.parent, row, index) for index, row in enumerate(read_table(source))]
    if is_building(source):
        rows = [row for path in question_files(source) for row in read_table(path)]
        return [item(source, row, index, source) for index, row in enumerate(rows)]
    items: list[Item] = []
    for directory in buildings_under(source):  # data/test: <building>/questions.jsonl
        rows = [row for path in question_files(directory) for row in read_table(path)]
        items += [item(directory, row, index, directory) for index, row in enumerate(rows)]
    if not items:  # a questions table next to the building directories
        for path in question_files(source):
            items += [item(source, row, index) for index, row in enumerate(read_table(path))]
    return items


def ensure_building(directory: Path) -> None:
    """Plans only (floor_*.svg, no building.json): build the building from them once, without a conversation,
    fill in names, room types and things from equipment.csv when it is there, and save it as building.json."""
    if (directory / "building.json").is_file():
        return
    plans = sorted(directory.glob("floor_*.svg"))
    if not plans:
        raise FileNotFoundError(f"No building.json and no floor_*.svg plans in {directory}")
    building, notes = import_plans(plans, directory.name)
    equipment = directory / "equipment.csv"
    if equipment.is_file():
        notes += enrich_from_equipment(building, read_table(equipment))
    (directory / "building.json").write_text(json.dumps(building, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Built {directory / 'building.json'} from {len(plans)} floor plans:", *notes, sep="\n  ", flush=True)


def select(items: list[Item], per_kind: int | None, buildings: set[str] | None) -> list[Item]:
    """Optionally keep only some buildings, and at most per_kind questions of each kind (first ones)."""
    if buildings is not None:
        items = [entry for entry in items if entry.building is not None and entry.building.name in buildings]
    if per_kind is None:
        return items
    seen: Counter = Counter()
    kept = []
    for entry in items:
        kind = entry.question.get("kind", "?")
        if seen[kind] < per_kind:
            seen[kind] += 1
            kept.append(entry)
    return kept


def finished(reply: str) -> bool:
    """A reply worth keeping on --resume: it has an Answer: line and isn't an error."""
    return not reply.startswith(ERROR_PREFIX) and any(line.startswith("Answer:") for line in reply.splitlines())


def read_existing(out: Path) -> dict[str, str]:
    if not out.exists():
        return {}
    with out.open(encoding="utf-8", newline="") as handle:
        return {row["question_id"]: row["answer"] for row in csv.DictReader(handle)}


def run(
    source: Path,
    out: Path,
    per_kind: int | None = None,
    buildings: set[str] | None = None,
    double_check: bool = False,
    resume: bool = False,
    force: bool = False,
) -> Counter:
    items = select(load_questions(source), per_kind, buildings)
    if not items:
        sys.exit(f"No questions found in {source}")
    existing = read_existing(out)
    if not resume and not force and len(existing) > len(items):
        sys.exit(f"{out} already has {len(existing)} answers and this run has only {len(items)} questions: it would "
                 f"replace them. Use --resume to keep them, another --out, or --force to replace.")
    done = {key: reply for key, reply in read_existing(out).items() if finished(reply)} if resume else {}
    results: Counter = Counter()
    rows: dict[str, str] = {}
    out.parent.mkdir(parents=True, exist_ok=True)
    for entry in items:
        question = entry.question
        if entry.id in done:
            reply = done[entry.id]
        else:
            try:  # one bad question (or building) must not stop the run
                if entry.problem:
                    raise ValueError(entry.problem)
                ensure_building(entry.building)
                reply = answer(entry.building, question["question"], entry.id, double_check)
            except Exception as error:
                reply = f"{ERROR_PREFIX}{type(error).__name__}: {error}"
        rows[entry.id] = reply
        write_csv(out, rows)  # after every question, so an interrupted run keeps what it paid for
        mark = "   "
        if isinstance(question.get("answer"), dict):
            try:  # scoring is only a check: an answer key in another format must not stop the run
                correct = score_reply(question["answer"], reply)
                results[(question.get("kind", "?"), correct)] += 1
                mark = "OK " if correct else "BAD"
            except Exception:
                mark = " ? "
        last = reply.splitlines()[-1] if reply else ""
        print(f"{mark} {entry.id:36s} {last[:70]}", flush=True)
    print(f"\n{len(rows)} answers written to {out}")
    if results:
        for kind in sorted({kind for kind, _ in results}):
            print(f"  {kind:26s} {results[(kind, True)]:4d} / {results[(kind, True)] + results[(kind, False)]}")
        correct = sum(count for (_, ok), count in results.items() if ok)
        print(f"  {'all':26s} {correct:4d} / {sum(results.values())}")
    return results


def write_csv(out: Path, rows: dict[str, str]) -> None:
    """Written to a temporary file and moved into place, so stopping the run never leaves half a CSV."""
    partial = out.with_name(out.name + ".partial")
    with partial.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(("question_id", "answer"))
        writer.writerows(rows.items())
    partial.replace(out)


def main() -> None:
    parser = argparse.ArgumentParser(prog="navagent.benchmark", description=__doc__.splitlines()[0])
    parser.add_argument("source", type=Path, help="split directory, building directory or questions file")
    parser.add_argument("--out", type=Path, default=Path("submission.csv"), help="CSV to write")
    parser.add_argument("--per-kind", type=int, default=None, help="only the first N questions of each kind")
    parser.add_argument("--buildings", type=Path, default=None, help="file with building ids to keep, one per line")
    parser.add_argument("--double-check", action="store_true", help="run each question twice (+1 on disagreement)")
    parser.add_argument("--resume", action="store_true", help="keep answers already in --out, answer the rest")
    parser.add_argument("--force", action="store_true", help="replace an --out file that has more answers than this run")
    arguments = parser.parse_args()
    buildings = None
    if arguments.buildings:
        buildings = {line.strip() for line in arguments.buildings.read_text().splitlines() if line.strip()}
    run(arguments.source, arguments.out, arguments.per_kind, buildings, arguments.double_check, arguments.resume,
        arguments.force)


if __name__ == "__main__":
    main()
