"""One command from questions to the submission CSV (documented in BENCHMARK.md).

  uv run --env-file .env python -m navagent.benchmark data/test --out submission.csv

The input can be
- a split directory with <building_id>/questions.jsonl (data/test, data/dev),
- one building directory with building.json and questions.jsonl (the Sunday building),
- a questions.csv / .jsonl with id, building_id and question, next to the building directories.
If the questions carry answers (train/dev), the replies are also scored."""

import argparse
import csv
import json
import sys
from collections import Counter
from pathlib import Path

from benchmark.score import score_reply
from navagent.answer import answer

QUESTION_FILES = ("questions.jsonl", "questions.csv")


def read_table(path: Path) -> list[dict]:
    if path.suffix == ".csv":
        with path.open(encoding="utf-8", newline="") as handle:
            return list(csv.DictReader(handle))
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def find_building(root: Path, building_id: str) -> Path:
    for candidate in (root / building_id, root.parent / building_id, *root.glob(f"*/{building_id}")):
        if (candidate / "building.json").exists():
            return candidate
    if (root / "building.json").exists():
        return root
    raise FileNotFoundError(f"No building.json for {building_id} under {root}")


def load_questions(source: Path) -> list[tuple[Path, dict]]:
    """(building directory, question) pairs in a stable order."""
    if source.is_file():
        return [(find_building(source.parent, row["building_id"]), row) for row in read_table(source)]
    if (source / "building.json").exists():
        rows = next((read_table(source / name) for name in QUESTION_FILES if (source / name).exists()), [])
        return [(source, row) for row in rows]
    pairs = []
    for path in sorted(source.glob("*/questions.jsonl")):
        pairs += [(path.parent, row) for row in read_table(path)]
    if not pairs:
        table = next((source / name for name in QUESTION_FILES if (source / name).exists()), None)
        if table is not None:
            pairs = [(find_building(source, row["building_id"]), row) for row in read_table(table)]
    return pairs


def select(pairs: list[tuple[Path, dict]], per_kind: int | None, buildings: set[str] | None) -> list:
    """Optionally keep only some buildings, and at most per_kind questions of each kind (first ones)."""
    if buildings is not None:
        pairs = [pair for pair in pairs if pair[0].name in buildings]
    if per_kind is None:
        return pairs
    seen: Counter = Counter()
    kept = []
    for pair in pairs:
        kind = pair[1].get("kind", "?")
        if seen[kind] < per_kind:
            seen[kind] += 1
            kept.append(pair)
    return kept


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
) -> Counter:
    pairs = select(load_questions(source), per_kind, buildings)
    if not pairs:
        sys.exit(f"No questions found in {source}")
    done = read_existing(out) if resume else {}
    results: Counter = Counter()
    rows: dict[str, str] = {}
    out.parent.mkdir(parents=True, exist_ok=True)
    for building_directory, question in pairs:
        if question["id"] in done:
            reply = done[question["id"]]
        else:
            try:
                reply = answer(building_directory, question["question"], question["id"], double_check)
            except Exception as error:  # one bad question must not stop the run
                reply = f"Error while answering: {type(error).__name__}: {error}"
        rows[question["id"]] = reply
        write_csv(out, rows)  # after every question, so an interrupted run keeps what it paid for
        if isinstance(question.get("answer"), dict):
            correct = score_reply(question["answer"], reply)
            results[(question.get("kind", "?"), correct)] += 1
            mark = "OK " if correct else "BAD"
        else:
            mark = "   "
        last = reply.splitlines()[-1] if reply else ""
        print(f"{mark} {question['id']:36s} {last[:70]}", flush=True)
    print(f"\n{len(rows)} answers written to {out}")
    if results:
        for kind in sorted({kind for kind, _ in results}):
            print(f"  {kind:26s} {results[(kind, True)]:4d} / {results[(kind, True)] + results[(kind, False)]}")
        correct = sum(count for (_, ok), count in results.items() if ok)
        print(f"  {'all':26s} {correct:4d} / {sum(results.values())}")
    return results


def write_csv(out: Path, rows: dict[str, str]) -> None:
    with out.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(("question_id", "answer"))
        writer.writerows(rows.items())


def main() -> None:
    parser = argparse.ArgumentParser(prog="navagent.benchmark", description=__doc__.splitlines()[0])
    parser.add_argument("source", type=Path, help="split directory, building directory or questions file")
    parser.add_argument("--out", type=Path, default=Path("submission.csv"), help="CSV to write")
    parser.add_argument("--per-kind", type=int, default=None, help="only the first N questions of each kind")
    parser.add_argument("--buildings", type=Path, default=None, help="file with building ids to keep, one per line")
    parser.add_argument("--double-check", action="store_true", help="run each question twice (+1 on disagreement)")
    parser.add_argument("--resume", action="store_true", help="keep answers already in --out, answer the rest")
    arguments = parser.parse_args()
    buildings = None
    if arguments.buildings:
        buildings = {line.strip() for line in arguments.buildings.read_text().splitlines() if line.strip()}
    run(arguments.source, arguments.out, arguments.per_kind, buildings, arguments.double_check, arguments.resume)


if __name__ == "__main__":
    main()
