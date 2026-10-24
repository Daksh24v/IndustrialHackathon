# Voice

Speech in, speech out for the building agent, with ElevenLabs. Speech to text is Scribe v2 (it is told the
building's room and machine names), text to speech is v4 Turbo with the voice "Tony Smyles". Everything here
talks to the backend through its normal HTTP API (`/sessions`, `/chat`, `/buildings/{id}`), so nothing in
`navcore/`, `navagent/` or `server/` changes.

## Run it

`.env` needs `ANTHROPIC_API_KEY` and `ELEVENLABS_API_KEY` (never commit it).

```bash
uv run --env-file .env uvicorn server.app:app --port 8000   # the backend
uv run --env-file .env uvicorn voice.app:app --port 8001    # voice
```

- **Demo page with the microphone:** http://localhost:8001 . Tap the button (or press space), ask, pause; it
  stops listening by itself and answers out loud. Options the agent asks back show as chips.
- **Terminal tester (type, hear):** `uv run python -m voice.talk [building_id]`
- **API docs:** http://localhost:8001/docs

## API (for the app)

| Endpoint | Body | |
|---|---|---|
| `POST /voice/sessions` | `{"building_id": "..."}` | same answer as `POST /sessions` |
| `POST /voice/sessions/{id}/turn` | the recording itself, with its `Content-Type` (`audio/webm`, `audio/mp4`, `audio/m4a`, `audio/wav`) | one spoken turn |
| `POST /voice/sessions/{id}/say` | `{"text": "...", "audio": true}` | one typed turn, or a tapped option |
| `DELETE /voice/sessions/{id}` | | end it |

Every turn answers the backend's `/chat` fields plus:

| Field | |
|---|---|
| `heard` | what the person said (transcript), or what they typed |
| `sent` | what went to the agent: an option label when they clearly picked one ("first floor" → "Floor 1") |
| `reply`, `question`, `map` | exactly as `/chat` |
| `spoken` | the words in the audio: short, no markdown, the question read with its options |
| `audio_base64` | MP3 of `spoken` (null if ElevenLabs failed; then `audio_error` says why) |
| `playback_rate` | play at this rate with pitch kept (1.08: v4 Turbo ignores ElevenLabs' own speed setting) |

When nothing was heard, the turn says "Sorry, I didn't catch that…" without calling the agent.

In Expo: record with `expo-audio` (m4a), `fetch(url, {method: "POST", headers: {"content-type": "audio/m4a"},
body: file})`, then play `audio_base64` with the rate set and pitch correction on.

## Settings (`.env`, all optional)

| Variable | Default |
|---|---|
| `ELEVENLABS_VOICE_ID` | `q1OMOTZNtqpS50TIQtu4` (Tony Smyles; add him to "My Voices" in the ElevenLabs account first) |
| `ELEVENLABS_TTS_MODEL` / `ELEVENLABS_STT_MODEL` | `eleven_v4_turbo` / `scribe_v2` |
| `VOICE_PLAYBACK_RATE` | `1.08` |
| `NAV_BACKEND_URL` | `http://localhost:8000` |

Spoken audio is cached in `voice/.cache/` (gitignored), so repeated lines cost no credits.

## Serving voice from the backend instead (one process)

`voice.app.router` holds all `/voice/...` endpoints, so `server/app.py` can mount them:

```python
from voice.app import router as voice_router
app.include_router(voice_router)
```

Voice still reaches the agent over HTTP at `NAV_BACKEND_URL`, which is then the backend itself.

## Wished for on main (backend)

- `POST /sessions` with `"voice": true`: the agent answers in one or two spoken sentences with no markdown.
  Today `voice/speech.py` cleans replies up and keeps the first two sentences.

## Tests

`uv run pytest tests/test_voice.py` (free: ElevenLabs is faked, Claude is the scripted fake from `tests/`).
