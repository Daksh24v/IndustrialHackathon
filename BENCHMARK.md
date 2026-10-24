# Benchmark run

One command, no manual steps between input and output:

```bash
uv sync
uv run --env-file .env python -m navagent.benchmark <input> --out <answers.csv>
```

`<input>` can be any of:

| Input | Example |
|---|---|
| A split directory with `<building_id>/questions.jsonl` | `data/test` |
| One building directory with `building.json` and `questions.jsonl` (the Sunday building) | `data/sunday/<building_id>` |
| A `questions.csv` or `.jsonl` with `id`, `building_id`, `question`, next to the building directories | `data/test/questions.csv` |

The output is the submission CSV (`question_id,answer`, full replies, each ending with an `Answer:` line).
When the questions carry answers (train/dev), the run also prints the score per kind.

## The test-set submission

```bash
uv run --env-file .env python -m navagent.benchmark data/test --out submission/team_answers.csv
```

The committed `submission/team_answers.csv` was produced by exactly this command.

## How it answers

1. **`navcore` (deterministic).** It loads `building.json` and builds the README's route graph (space anchors at
   `representative_point()`, door nodes, stairs 12 m per floor, lifts 15 m + 6 m per floor, one `outside` node).
   Geometry comes from shapely: areas, centroids, wall sharing (1 m within 0.35 m), floor stacking by overlap.
2. **Question reading.** Known benchmark wordings are parsed and every name is resolved to an id
   ("Garderobe A (Floor 1)", "the basement 1", "fire extinguisher", "Lift 2"). If a room name exists several times
   on a floor, every reading is solved and the most common answer is used.
3. **Claude fallback.** Any question the parser doesn't recognise goes to the Claude agent (`navagent/agent.py`),
   which reaches the same engine through tools. Without `ANTHROPIC_API_KEY` set, or with `NAVAGENT_OFFLINE=1`,
   recognised questions still work; others get a reply without an `Answer:` line.

## Results

| Split | Correct |
|---|---|
| dev (138 questions) | 138 / 138 |
| train (517 questions) | 515 / 517 (the 2 misses name a room that exists three or nine times on its floor) |
| dev warm-up routes, step-free, closures, tours (229) | all match the optimal length to the centimetre |

Reproduce with `uv run pytest --train` or `uv run python -m navagent.benchmark data/dev --out dev.csv`.
