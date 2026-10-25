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
| One building directory with `building.json` and a questions file (the Sunday building) | `data/sunday/<building_id>` |
| A questions `.csv` or `.jsonl` next to the building directories | `data/test/questions.csv` |
| One building directory with **only floor plans** (`floor_*.svg`, no `building.json`) | built first, see below |

It takes what it is given:
- the question id from `id`, `question_id` or `qid` (else `<building>-Q001` …), the text from `question`,
  `text` or `prompt`;
- any `*question*.jsonl` / `.csv` file name (`questions.jsonl` first);
- the building by `building_id`, by the id inside a `building.json`, or the only building there is. A
  `building_id` that isn't there is an error row for that question, never another building;
- **plans only:** the building is built from `floor_*.svg` once, without a conversation (`navcore/plans.py`),
  names, room types and things are filled in from `equipment.csv` when it is there, and it is saved as
  `building.json` (the run prints what was assumed: floor heights 3.5 m, doors 0.9 m and step-free).

Options: `--per-kind N` (first N questions of each kind), `--buildings <file>` (only these building ids),
`--double-check` (each question twice, a third run on disagreement; a run that fails doesn't spoil the
others), `--resume` (keep the answers already in `--out`, answer the rest **and every error row or row without
an `Answer:` line again**; an interrupted run never pays twice), `--force` (replace an `--out` file that has
more answers than this run: without it a short test run refuses to overwrite a full submission). A question that
fails becomes an error row, never a stopped run, and an answer key the scorer doesn't know shows `?` instead of
stopping the run. The CSV is replaced after every question (written aside, then moved, so stopping the run never
leaves half a file). Each Claude call times out after 180 s and is retried.

## How it answers

- **Claude reads every question** (`navagent/agent.py`, benchmark mode, `claude-opus-5-5`, effort high).
  No templates or word-for-word matching: it decides what is asked and calls tools.
- **The engine does every calculation** (`navcore/engine.py`): the brief's route graph (CHALLENGE.md), areas,
  shared walls, stacking, reachability, what-if doors. The tools return its numbers.
- **The `Answer:` line is written by code** from Claude's `submit_answer` call (a number copied from a tool
  result, or a room id; room areas come from the engine), so the format the scorer needs never depends on prose.
- **Routes are written out by code too:** for a route or tour, a `Route:` line before the `Answer:` line lists
  the rooms in order with their ids and the doors, stairs and lifts used (`Route: A (Floor) → B (Floor) … |
  spaces: … | doors and stairs: …`); the `Answer:` line stays last with the length. A route that doesn't
  exist is always `Answer: No route exists.`
- Every question's full tool log is saved to `agent_output/logs/<question_id>.json`.

## Hold-out

`holdout/build.txt` (192 buildings) is for development, `holdout/holdout.txt` (48) is locked: split by site
(`group_id`), stratified by source (`holdout/split.py`). Tests use build buildings; `uv run pytest --holdout`
checks the hold-out and is run only at checkpoints. The kit's `data/test` is a second blind set.

## Results

All live runs use the Claude agent (benchmark mode) with the engine's tools, scored against the kit 1.1.0
answers (the organisers' route rules: door to door, stairs and lifts by height, no way round the outside).

| Run (date 2026-10-24, kit 1.1.0) | Buildings | Correct |
|---|---|---|
| Benchmark questions, 3 per kind | build | 24 / 24 |
| Warm-up questions (where is, how many, routes, step-free, closures, tours) | build | 18 / 18 |
| Both sets reworded by Claude (casual, terse, formal, roundabout) | build | 41 / 41 |
| Novel questions the dataset never asks (16 kinds, `evals/novel.py`) | build | 31 / 31 |
| **Hold-out, run once, nothing tuned on it** | **hold-out** | **35 / 36 (97%)** |

Build sets: 114/114, $4.46. After the code-written `Route:` line and the fixed no-route answer were added, the benchmark and warm-up sets were run again: 24/24 and 18/18 ($2.20). Hold-out: benchmark 23/24 and warm-up 12/12, $1.59; the one miss is a
room-stacked question, and as for every hold-out run its questions were not read and nothing was changed
for it. The engine alone (`tests/test_dataset.py`, free) reproduces every route, step-free route, closure,
tour, errand, what-if and reachability answer of all build and hold-out buildings to the centimetre.

Before kit 1.1.0 (old route rules, old answers) the same sets gave build 83/83 and hold-out 34/36; those
numbers are kept only for the record.

Offline checks (`uv run pytest`, free): tools + code-written answer lines on every build-set benchmark
question; warm-up routes exact to the centimetre; an independent router; invariance under renaming,
reordering, moving and rotating; stress buildings; every tool on every build and test building.

Cost: about $0.03–0.04 per question (prompt caching on).

## The test-set submission

`submission/team_answers.csv` (145 answers) was made on 2026-10-24, after the kit 1.1.0 route rules, by the
Claude agent with

```bash
uv run --env-file .env python -m navagent.benchmark data/test --out agent_output/test_run.csv --double-check --resume
```

(every question twice, a third run only on disagreement: the two runs agreed on 145/145, so none was needed;
290 runs, $6.54), then checked for free with
`uv run python -m evals.check_submission submission/team_answers.csv --reference <other run>`:
format OK (UTF-8, header, every test id once, under 5 MB) and every answer line readable by the scorer.

Against the previous submission (made with the 1.0.0 route rules) 124/145 answers are the same; the 21 that
changed are exactly the route-dependent ones the new rules move (19 errands, 2 what-if doors), and each new
answer equals the engine's 1.1.0 result computed directly from the question. The 18 wide-delivery counts did
not change. No answer was edited by hand.

## Sunday dry run

From a fresh clone of this repository (2026-10-24, after kit 1.1.0): `uv sync` (1 s with the uv cache),
create `.env`, then the command above on one test building directory (`data/test/osm-way363805324`,
7 questions): a valid CSV in 43 s (about 6 s per question, run one after another), every answer line readable
by the scorer, all 7 answers the same as in the submission. A Sunday building with 20 questions takes about
2–3 minutes and costs under $1.

Again after the input hardening (fresh clone of e4b9e83):
- `data/test/questions.csv --per-kind 1` (the kit's table, `question_id` column): 8 answers in 54 s, the same as
  in the submission;
- a plans-only copy of `data/test/resplan-3573` (its `building.json` deleted): built from the plan with
  `equipment.csv` (names and room types for 9 rooms, 31 things), 5 answers in 40 s; 4 of 5 are the same as with
  the real `building.json`. The fifth, a wide-delivery count, can't be right from plans alone: plans don't
  record door widths, so every door is taken as 0.9 m.

## Level 4: buildings from floor plans

`navcore/plans.py` reads `floor_<level>.svg` plans (rooms, kind of space, room numbers, doors, entrances,
title), measures the scale from the drawing's 2 m margin, lines the floors up (stair and lift shafts first,
walls to fine-tune, centred when no shafts) and links stairs and lifts. What the plans don't contain (room
types, door widths, floor heights, stairs drawn like corridors, labels the renderer left out) is asked in a
builder conversation (`navagent/builder.py`, server `POST /imports`).

`uv run python -m evals.plans` rebuilds buildings from their own plans and compares with `building.json`
(geometry floor by floor; floor alignment only where the dataset's floors share one frame):

| Buildings | Rooms | Doors | Stairs/lifts | Stair flights | Floors lined up | Routes | Shared walls | Above/below | Room numbers |
|---|---|---|---|---|---|---|---|---|---|
| Build (192) | 100% | 99.5% | 40% | 89% | 79% | 90% | 100% | 100% | 83% |
| **Hold-out (48), run once** | **100%** | **97%** | **33%** | **75%** | **95%** | **82%** | **100%** | **100%** | **81%** |
| Procedural only, build and hold-out | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |

Swiss Dwellings plans draw no stair or lift shafts: their stairs are corridor-coloured landings. `stair_halls`
finds them (corridors that open onto two or more other corridors through at most 4 doors, that have only one
or two doors, or that have the entrance; a flat's own hallway opens into its rooms instead), joins the ones
that lie over each other floor to floor, and joins the two nearest landings where nothing overlaps (the stairs
reach every floor). Swiss routes went from 38% to 83% on the build set (hold-out, all sources: 82%, up from
55% at its earlier run). "Stairs/lifts" counts exact connectors, and the dataset splits the same stairs sometimes into one
connector through every floor and sometimes one per flight (and adds a lift the plans don't show), so
"Stair flights" also counts the floor-to-floor joins. The builder shows the stair halls it found and asks if
they are right and whether there is a lift. The other gaps come from OSM floors that the data itself maps a
few decimetres apart. Missing room numbers are not in the drawings at all; the builder lets the person name them.
