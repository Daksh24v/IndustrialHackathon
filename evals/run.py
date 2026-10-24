"""Run the live (paid) agent on an evaluation set and score it.

  uv run --env-file .env python -m evals.run build      # build_benchmark + build_warmup + build_reworded
  uv run --env-file .env python -m evals.run holdout    # the locked hold-out: checkpoints only

Benchmark questions are scored with the official benchmark/score.py. Warm-up questions (no answer format
in the question) are checked against their dataset answers: the room for "where is", the count, and the
route length within 1% (at least 1 m), or "no route" when none exists. For the hold-out only ids and
OK/BAD are printed, never the questions."""

import argparse
import json
import re
from collections import Counter
from pathlib import Path

from benchmark.evaluate import PRICE_PER_MILLION
from benchmark.score import committed_answer, numbers_in, score_reply
from evals.sets import DATA, holdout_sets, load
from navagent import answer as answer_module
from navcore.engine import Building

RESULTS = Path("agent_output") / "evals"


def check_warmup(question: dict, reply: str) -> bool:
    text = committed_answer(reply)
    if text is None:
        return False
    answer, kind = question["answer"], question["kind"]
    if kind == "locate":
        building = Building.load(DATA / question["building_path"])
        space = building.spaces[answer["space_id"]]
        names = [space["name"]] + ([space["ref"]] if space.get("ref") else [])
        return any(re.search(rf"(?<![\w.]){re.escape(name)}(?!\w)", text, re.IGNORECASE) for name in names)
    numbers = numbers_in(text)
    if kind == "count":
        return len(numbers) == 1 and numbers[0] == answer["count"]
    if answer.get("reachable") is False:
        # "no route" in words, and no distance (room names like "Bedroom 1.23" may hold numbers)
        says_no = re.search(r"\b(no|not|none|unreachable|impossible)\b", text, re.IGNORECASE) is not None
        gives_distance = re.search(r"\d\s*(m|metres|meters)\b", text, re.IGNORECASE) is not None
        return says_no and not gives_distance
    expected = answer["optimal_length_m"]
    return len(numbers) == 1 and abs(numbers[0] - expected) <= max(0.01 * expected, 1.0)


def score(question: dict, reply: str) -> bool:
    if isinstance(question.get("answer"), dict) and "type" in question["answer"]:
        return score_reply(question["answer"], reply)
    return check_warmup(question, reply)


def run_set(name: str, items: list[dict], quiet: bool) -> Counter:
    results: Counter = Counter()
    RESULTS.mkdir(parents=True, exist_ok=True)
    with (RESULTS / f"{name}.jsonl").open("w", encoding="utf-8") as log:
        for item in items:
            try:
                reply = answer_module.answer(DATA / item["building_path"], item["question"], f"{name}-{item['id']}")
            except Exception as error:  # report and go on
                reply = f"Error: {type(error).__name__}: {error}"
            correct = score(item, reply)
            results[(item["kind"], correct)] += 1
            log.write(json.dumps({"id": item["id"], "kind": item["kind"], "correct": correct, "reply": reply},
                                 ensure_ascii=False) + "\n")
            shown = "" if quiet else f"  {(committed_answer(reply) or '(no answer line)')[:60]}"
            print(f"{'OK ' if correct else 'BAD'} {name:18s} {item['id']:34s}{shown}", flush=True)
    return results


def report(name: str, results: Counter) -> None:
    print(f"\n{name}")
    for kind in sorted({kind for kind, _ in results}):
        print(f"  {kind:26s} {results[(kind, True)]:3d} / {results[(kind, True)] + results[(kind, False)]}")
    correct = sum(count for (_, ok), count in results.items() if ok)
    total = sum(results.values())
    print(f"  {'all':26s} {correct:3d} / {total}  ({correct / max(total, 1):.0%})")


def main() -> None:
    parser = argparse.ArgumentParser(prog="evals.run")
    parser.add_argument("which", choices=["build", "holdout"])
    parser.add_argument("--only", nargs="+", default=None, help="only these set names")
    arguments = parser.parse_args()
    if arguments.which == "build":
        names = ["build_benchmark", "build_warmup", "build_reworded"]
        sets = {name: load(name) for name in names if (Path(__file__).parent / "sets" / f"{name}.jsonl").exists()}
    else:
        sets = holdout_sets()
    if arguments.only:
        sets = {name: items for name, items in sets.items() if name in arguments.only}
    totals = {name: run_set(name, items, quiet=arguments.which == "holdout") for name, items in sets.items()}
    for name, results in totals.items():
        report(name, results)
    cost = sum(answer_module.USAGE[key] * price / 1_000_000 for key, price in PRICE_PER_MILLION.items())
    print(f"\ncost: ${cost:.2f}  tokens: {dict(answer_module.USAGE)}")


if __name__ == "__main__":
    main()
