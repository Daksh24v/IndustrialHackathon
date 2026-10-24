"""Evaluation sets for the live (paid) agent checks, built with a fixed seed.

- build sets come only from holdout/build.txt buildings and are what we develop against;
- the hold-out set comes only from holdout/holdout.txt and is created and run in one go by
  `python -m evals.run holdout`: its questions are never written to the repo or printed.

  uv run python -m evals.sets            # writes evals/sets/build_*.jsonl
"""

import json
import random
from collections import defaultdict
from pathlib import Path

from holdout.split import BUILD_LIST, HOLDOUT_LIST, read

DATA = Path(__file__).resolve().parent.parent / "data"
SETS = Path(__file__).resolve().parent / "sets"
SEED = 1024
BENCHMARK_PER_KIND = 3
WARMUP_PER_KIND = 3
WARMUP_KINDS = ("locate", "count", "route", "route_step_free", "route_with_closure", "tour")


def questions(buildings: set[str], filename: str) -> list[dict]:
    found = []
    for split in ("train", "dev"):
        for path in sorted((DATA / split).glob(f"*/{filename}")):
            if path.parent.name not in buildings:
                continue
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    question = json.loads(line)
                    question["building_path"] = str(path.parent.relative_to(DATA))
                    found.append(question)
    return found


def sample(items: list[dict], per_kind: int, kinds: tuple[str, ...] | None, seed: int) -> list[dict]:
    """per_kind questions of each kind, from different buildings where possible."""
    rng = random.Random(seed)
    by_kind: dict[str, list[dict]] = defaultdict(list)
    for item in items:
        if kinds is None or item["kind"] in kinds:
            by_kind[item["kind"]].append(item)
    picked = []
    for kind in sorted(by_kind):
        pool = by_kind[kind][:]
        rng.shuffle(pool)
        first_per_building = {}
        for item in pool:
            first_per_building.setdefault(item["building_id"], item)
        varied = list(first_per_building.values())
        rest = [item for item in pool if item not in varied]
        picked += (varied + rest)[:per_kind]
    return picked


def build_sets() -> dict[str, list[dict]]:
    buildings = read(BUILD_LIST)
    return {
        "build_benchmark": sample(questions(buildings, "questions.jsonl"), BENCHMARK_PER_KIND, None, SEED),
        "build_warmup": sample(questions(buildings, "questions_basic.jsonl"), WARMUP_PER_KIND, WARMUP_KINDS, SEED),
    }


def holdout_sets() -> dict[str, list[dict]]:
    buildings = read(HOLDOUT_LIST)
    return {
        "holdout_benchmark": sample(questions(buildings, "questions.jsonl"), BENCHMARK_PER_KIND, None, SEED + 1),
        "holdout_warmup": sample(questions(buildings, "questions_basic.jsonl"), 2, WARMUP_KINDS, SEED + 1),
    }


def write(name: str, items: list[dict]) -> Path:
    SETS.mkdir(parents=True, exist_ok=True)
    path = SETS / f"{name}.jsonl"
    path.write_text("".join(json.dumps(item, ensure_ascii=False) + "\n" for item in items), encoding="utf-8")
    return path


def load(name: str) -> list[dict]:
    path = SETS / f"{name}.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> None:
    for name, items in build_sets().items():
        print(f"{write(name, items)}: {len(items)} questions")


if __name__ == "__main__":
    main()
