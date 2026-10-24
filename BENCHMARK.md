# Benchmark run

One command, no manual steps between input and output:

```bash
uv sync
uv run --env-file .env python -m navagent.benchmark <input> --out <answers.csv>
```

`.env` holds `ANTHROPIC_API_KEY=...` (gitignored, so create it in a fresh clone). `<input>` can be any of:

| Input | Example |
|---|---|
| A split directory with `<building_id>/questions.jsonl` | `data/test` |
| One building directory with `building.json` and `questions.jsonl` (the Sunday building) | `data/sunday/<building_id>` |
| A `questions.csv` or `.jsonl` with `id`, `building_id`, `question`, next to the building directories | `data/test/questions.csv` |

Options: `--per-kind N` (first N questions of each kind), `--buildings <file>` (only these building ids),
`--double-check` (each question twice, a third run on disagreement), `--resume` (keep answers already in
`--out`; an interrupted run never pays twice). The CSV is rewritten after every question.

## How it answers

- **Claude reads every question** (`navagent/agent.py`, benchmark mode, `claude-opus-5-5`, effort high).
  No templates or word-for-word matching: it decides what is asked and calls tools.
- **The engine does every calculation** (`navcore/engine.py`): the README's route graph, areas,
  shared walls, stacking, reachability, what-if doors. The tools return its numbers.
- **The `Answer:` line is written by code** from Claude's `submit_answer` call (a number copied from a tool
  result, or a room id; room areas come from the engine), so the format the scorer needs never depends on prose.
- Every question's full tool log is saved to `agent_output/logs/<question_id>.json`.

## Hold-out

`holdout/build.txt` (192 buildings) is for development, `holdout/holdout.txt` (48) is locked: split by site
(`group_id`), stratified by source (`holdout/split.py`). Tests use build buildings; `uv run pytest --holdout`
checks the hold-out and is run only at checkpoints. The kit's `data/test` is a second blind set.

## Results

All live runs use the Claude agent (benchmark mode) with the engine's tools.

| Run (date 2026-10-24) | Buildings | Correct |
|---|---|---|
| Smoke test, one question per kind | build | 9 / 9 |
| Benchmark questions, 3 per kind | build | 24 / 24 |
| Warm-up questions (where is, how many, routes, step-free, closures, tours) | build | 18 / 18 |
| Both sets reworded by Claude (casual, terse, formal, roundabout) | build | 41 / 41 |
| **Hold-out, run once, nothing tuned on it** | **hold-out** | **34 / 36 (94%)** |
| After the same-name fix and definitions-as-parameters: benchmark, warm-up, reworded | build | 83 / 83 |
| Novel questions the dataset never asks (16 kinds, `evals/novel.py`) | build | 31 / 31 |

The two hold-out misses (`osm-way37850565-H03`, `osm-way52060470-H06`) name a room whose name exists more
than once on its floor ("Büro" three times, "Genusswerk" twice), so the question doesn't say which one is
meant. This was known before the split (see the Phase 1 notes); the hold-out questions themselves were not read.

Offline checks (`uv run pytest`, free): tools + code-written answer lines on every build-set benchmark
question; warm-up routes exact to the centimetre; an independent router; invariance under renaming,
reordering, moving and rotating; stress buildings; every tool on every build and test building.

Cost: about $0.03–0.04 per question (prompt caching on).

## The test-set submission

`submission/team_answers.csv` (145 answers) was made on 2026-10-24 by the Claude agent with

```bash
uv run --env-file .env python -m navagent.benchmark data/test --out agent_output/test_run.csv --resume
```

(single run, $3.99), then checked for free with
`uv run python -m evals.check_submission submission/team_answers.csv --reference <other run>`:
format OK (UTF-8, header, every test id once, under 5 MB), every answer line readable by the scorer, and
145/145 answers agree with an independent earlier run (the Phase 1 template reader, 138/138 on dev).
No answer was edited by hand.

## Sunday dry run

From a fresh clone of this repository: `uv sync`, create `.env`, then the command above on one test building
directory (`data/test/osm-way363805324`, 7 questions): a valid CSV in 44 s (about 6 s per question, run one
after another), all 7 answers the same as in the submission. A Sunday building with 20 questions takes about
2–3 minutes and costs under $1.

## Level 4: buildings from floor plans

`navcore/plans.py` reads `floor_<level>.svg` plans (rooms, kind of space, room numbers, doors, entrances,
title), measures the scale from the drawing's 2 m margin, lines the floors up (stair and lift shafts first,
walls to fine-tune, centred when no shafts) and links stairs and lifts. What the plans don't contain (room
types, door widths, floor heights, stairs drawn like corridors, labels the renderer left out) is asked in a
builder conversation (`navagent/builder.py`, server `POST /imports`).

`uv run python -m evals.plans` rebuilds buildings from their own plans and compares with `building.json`
(geometry floor by floor; floor alignment only where the dataset's floors share one frame):

| Buildings | Rooms | Doors | Stairs/lifts | Floors lined up | Routes | Shared walls | Above/below | Room numbers |
|---|---|---|---|---|---|---|---|---|
| Build (192) | 100% | 99.5% | 28% | 79% | 57% | 100% | 100% | 83% |
| **Hold-out (48), run once** | **100%** | **97%** | **22%** | **95%** | **55%** | **100%** | **100%** | **81%** |
| Procedural only, build and hold-out | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |

The low stairs/routes numbers come from Swiss Dwellings, whose stairwells are drawn like corridors (the
builder asks which spaces are the stairs, with suggestions), and from OSM floors that the data itself maps a
few decimetres apart. Missing room numbers are not in the drawings at all; the builder lets the person name them.
