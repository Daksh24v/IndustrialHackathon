# Finni: architecture and tech stack

Finni is Google Maps for the inside of a building: ask it by voice or text, and it finds things, finds you,
and walks you there. **Claude understands the person; a deterministic engine supplies every fact.**

```
 website (Expo, react-native-web)        FastAPI server (server/app.py)            engine (navcore/)
 ┌───────────────────────────┐   HTTP   ┌──────────────────────────────┐  calls  ┌──────────────────────────┐
 │ chat + mic (ElevenLabs)   │────────▶│ sessions: one Claude agent   │───────▶│ building.json → graph     │
 │ 3D / 2D floor, route, pin │◀────────│ per conversation (navagent/) │◀───────│ routes, areas, walls,     │
 │ tap "I'm here", picker    │  reply,  │ /position, /voice, /imports  │  JSON   │ reachability, what-if,    │
 └───────────────────────────┘  map    └──────────────────────────────┘         │ names → ids (resolve.py)  │
                                                                                   └──────────────────────────┘
 one command for scored runs: python -m navagent.benchmark <questions or building> --out answers.csv
```

## The three layers

| Layer | Code | What it does |
|---|---|---|
| **Engine** (deterministic) | `navcore/engine.py`, `navcore/resolve.py`, `navcore/plans.py` | Loads `building.json` (fills in missing fields), builds the route graph with the judges' 1.1.0 rules (door to door, 15 cm off the walls, stairs 2 m per metre climbed, a lift ride 15 m + 1 m per metre, no way round the outside), answers areas, shared walls, rooms above/below, reachability, errands, what-if doors, straight-line 3D. Turns words into ids: exact first, forgiving only when nothing is exact, typos only *suggested*. Builds a building from SVG floor plans (Level 4). |
| **Agent** (Claude) | `navagent/agent.py`, `navagent/tools.py`, `navagent/builder.py` | `claude-opus-5-5` with ~25 tools over the engine. Three modes: *chat* (asks back with 2–4 options, remembers, shows on the map), *benchmark* (never asks, code writes the `Answer:` and `Route:` lines from its `submit_answer` call), *builder* (sets up a building from plans by conversation). The person's position, history and route progress are session state, not prompt text. |
| **Server + website** | `server/app.py`, `voice/`, `app/` | FastAPI: buildings, sessions, chat, position (a place or a tapped point), route without the agent, plan imports, ElevenLabs speech in/out (keys stay on the server). Website: Expo built for the web: building picker, chat (desktop: side by side with the map), 3D and 2D floors drawn in SVG, animated route, building edits on the map, tap "I'm here", hands-free voice. |

## Why it's built this way

- **Every number from code.** The model never estimates a distance or an area; it picks tools and reads
  results. The scored answer line is written by code, so its format never depends on prose.
- **No templates.** Claude reads every question, so new wordings and new kinds of question work
  (`evals/novel.py`: 16 kinds the dataset never asks, 31/31).
- **The judges' route model, imported.** The walking model reuses the kit's reference functions, so route
  lengths match the expected answers to the centimetre (`tests/test_dataset.py`, every build and hold-out
  route).
- **Locate people like people do** (`LOCATING.md`): what we know (tap, what they said, the entrance, the
  route), then one question by landmarks they can see. No GPS, WiFi or beacons: the data has none, and GPS
  can't tell floors.
- **Robust to an unseen building** (`tests/test_unseen.py`, `tests/test_benchmark_input.py`): any question
  file layout, plans only (built from `floor_*.svg` + `equipment.csv`), missing fields, broken outlines; a
  failure is one error row, never a stopped run.

## Interaction design (the tricky users)

| Person | What Finni does |
|---|---|
| First day ("where do I get coffee?") | One question, "What can you see near you?", with real landmarks; then "turn left into the office corridor … by the coffee machine". |
| Wheelchair user | Step-free from then on without asking twice; says plainly when there is no step-free way (e.g. the only lift is closed) and offers alternatives. |
| Technician, hands full | Voice in and out, one short spoken sentence, landmarks instead of room ids. |
| Facility manager | Closes lifts and rooms, adds doors, moves machines; the map shows each change at once. |
| Vague or wrong ("the printer", "room 9.99") | Asks once with options; says a room doesn't exist instead of guessing. |

Checked by `tests/test_live.py --live` (9 scripted conversations against the real agent).

## Tech stack

- Python 3.12, `uv`; FastAPI + uvicorn; networkx (graph), shapely + numpy (geometry, visibility walks).
- Anthropic Python SDK (tool runner, prompt caching); ElevenLabs text-to-speech and speech-to-text.
- Expo 58 / React Native 0.88 for the web (react-native-web), react-native-svg for the 3D view without a
  3D engine, expo-audio for the microphone.
- Tests: pytest (offline: engine, tools, server, every dataset answer, unseen buildings, input layouts;
  `--live`: real conversations), jest for the website.

## Numbers (SUBMISSION/BENCHMARK.md)

Test set: 145 answers, double-checked, kit 1.1.0 rules. Build sets 114/114, hold-out 35/36 (run once, nothing
tuned on it). Sunday: one command, any layout, about 6 s per question.

## Not done, and how it would go

- **Several buildings and walkways (Level 3):** the data has none (every site is one building). The graph
  would get a node per walkway joining two buildings' entrances, with its length; the agent's tools already
  take ids, so they would work across the joined graph.
- **AR:** the position endpoint already takes a point on a floor; an AR anchor would send exactly that.
