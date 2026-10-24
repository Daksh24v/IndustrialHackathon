# Benchmark run

One command, no manual steps between input and output:

```bash
uv sync
uv run --env-file .env python -m navagent.benchmark <input> --out <answers.csv>
```

`.env` holds `ANTHROPIC_API_KEY=...` (gitignored). `<input>` can be any of:

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

| Check | Result |
|---|---|
| Offline: tools + code-written answer line on all build-set benchmark questions | all pass (`uv run pytest`) |
| Offline: build-set warm-up routes, step-free, closures, tours | match the official lengths to the centimetre |
| Live agent: build sample / hold-out / test submission | pending the paid runs |

`submission/team_answers.csv` is from the earlier template-based version and will be replaced by the
agent's run.
