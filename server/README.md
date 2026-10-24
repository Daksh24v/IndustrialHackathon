# Backend server

One HTTP API for the app and the voice front end. Start it (the Anthropic key goes in `.env`):

```bash
uv sync
uv run --env-file .env uvicorn server.app:app --reload --port 8000
```

Interactive docs: http://localhost:8000/docs

## A conversation

```bash
# 1. start a conversation about one building
curl -X POST localhost:8000/sessions -H 'content-type: application/json' \
     -d '{"building_id": "proc-factory-dev-003"}'
# -> {"session_id": "…", "building_id": "…", "building_name": "Fertigung Ost 27"}

# 2. each thing the person says (typed, or transcribed speech)
curl -X POST localhost:8000/sessions/<session_id>/chat -H 'content-type: application/json' \
     -d '{"text": "Where is the nearest toilet?"}'
```

Every `/chat` answer has three fields:

| Field | What it is | What to do with it |
|---|---|---|
| `reply` | the agent's text (may be empty when it only asks something) | show it, or speak it (text-to-speech) |
| `question` | `null`, or `{question, options: [{label, description}], allow_free_text}` | show the options as buttons, or read them out; send the picked `label` (or anything the person says) as the next `text` |
| `map` | `null`, or what to draw: `you_are_here`, `target`, `route`, `focus_floor_id` | draw the glowing position, the pin and the route lines |

`map.route.pieces` is the route as lines, one piece per floor: `{floor_id, points: [[x, y], …], then}`.
`then` says what comes after the piece: `{kind: "lift" | "stairs", name, to_floor_id}` (show "Take Lift 1 to
Floor 2" and switch to that floor), `{kind: "outside"}`, or `null` at the end. Coordinates are metres in the
building's own frame, the same as `GET /buildings/{id}`.

## Other endpoints

- `GET /buildings` - the buildings this server knows.
- `GET /buildings/{id}` - everything to draw it: floors, spaces (polygon, type, name, area, anchor), openings,
  stairs and lifts, things.
- `POST /buildings/{id}/route` - a route without the agent:
  `{"start": "Quality lab 0.21 (Ground floor)", "destination": "Office 1.04 (Floor 1)", "step_free": true}`.
- `DELETE /sessions/{id}` - end a conversation.

Rules for the voice branch: call these endpoints and don't change `navcore/`, `navagent/` or `benchmark/`
(the scored backend). If something is missing, ask for it to be added on `main`.
