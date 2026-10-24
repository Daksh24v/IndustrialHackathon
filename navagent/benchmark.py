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


def run(source: Path, out: Path) -> Counter:
    pairs = load_questions(source)
    if not pairs:
        sys.exit(f"No questions found in {source}")
    results: Counter = Counter()
    rows = []
    for building_directory, question in pairs:
        try:
            reply = answer(building_directory, question["question"])
        except Exception as error:  # one bad question must not stop the run
            reply = f"Error while answering: {error}"
        rows.append((question["id"], reply))
        if isinstance(question.get("answer"), dict):
            results[(question.get("kind", "?"), score_reply(question["answer"], reply))] += 1
        print(f"{question['id']:36s} {reply.splitlines()[-1][:70]}", flush=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(("question_id", "answer"))
        writer.writerows(rows)
    print(f"\n{len(rows)} answers written to {out}")
    if results:
        for kind in sorted({kind for kind, _ in results}):
            print(f"  {kind:26s} {results[(kind, True)]:4d} / {results[(kind, True)] + results[(kind, False)]}")
        correct = sum(count for (_, ok), count in results.items() if ok)
        print(f"  {'all':26s} {correct:4d} / {sum(results.values())}")
    return results


def main() -> None:
    parser = argparse.ArgumentParser(prog="navagent.benchmark", description=__doc__.splitlines()[0])
    parser.add_argument("source", type=Path, help="split directory, building directory or questions file")
    parser.add_argument("--out", type=Path, default=Path("submission.csv"), help="CSV to write")
    arguments = parser.parse_args()
    run(arguments.source, arguments.out)


if __name__ == "__main__":
    main()
