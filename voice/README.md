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

Two ways to use it; pick per feature.

**A. Building blocks: the app keeps its own chat flow (`api.chat`) and adds voice around it.**

| Endpoint | Body | Answer |
|---|---|---|
| `POST /voice/transcribe?building_id=...` | the recording itself, with its `Content-Type` (`audio/m4a`, `audio/webm`, `audio/mp4`, `audio/wav`) | `{"heard": "..."}` (empty when nothing was said). `building_id` (or `session_id` of a voice session) makes it hear the building's names. |
| `POST /voice/speak` | `{"answer": <the /chat answer>}` | `{spoken, audio_base64, audio_error, playback_rate}`: the reply, short, plus the question and its options |
| `POST /voice/speak` | `{"text": "Turn left at Office 1.04."}` (max 1000 characters; `"clean": false` to say it exactly as written) | same; for anything the app decides itself: AR steps, alerts, "One moment…" |

**B. One call per turn: voice talks to the agent for you.**

| Endpoint | Body | |
|---|---|---|
| `POST /voice/sessions` | `{"building_id": "..."}` | same answer as `POST /sessions` |
| `POST /voice/sessions/{id}/turn` | the recording itself, with its `Content-Type` | one spoken turn |
| `POST /voice/sessions/{id}/say` | `{"text": "...", "audio": true}` | one typed turn, or a tapped option |
| `DELETE /voice/sessions/{id}` | | end it |

Every B turn answers the backend's `/chat` fields plus:

| Field | |
|---|---|
| `heard` | what the person said (transcript), or what they typed |
| `sent` | what went to the agent: an option label when they clearly picked one ("first floor" → "Floor 1") |
| `reply`, `question`, `map` | exactly as `/chat` |
| `spoken` | the words in the audio: short, no markdown, the question read with its options |
| `audio_base64` | MP3 of `spoken` (null if ElevenLabs failed; then `audio_error` says why) |
| `playback_rate` | play at this rate with pitch kept (1.08: v4 Turbo ignores ElevenLabs' own speed setting) |

When nothing was heard, the turn says "Sorry, I didn't catch that…" without calling the agent.

## Wiring it into the Expo app (`app/`)

`ChatSheet` already has an `onMic` prop for this. With way A, `App.tsx` stays in charge of the conversation:

```ts
// 1. microphone -> words -> the normal send()
const recording = await record();                       // expo-audio, m4a
const { heard } = await voiceApi.transcribe(recording, buildingId);
if (heard) send(heard);                                 // the existing path: api.chat + map + chips

// 2. after each api.chat reply, say it
const { audio_base64, playback_rate } = await voiceApi.speak({ answer: reply });
play(audio_base64, playback_rate);                      // expo-audio player, rate set, pitch correction on

// 3. later, AR guidance (or anything else) just speaks text
await voiceApi.speak({ text: 'Turn left at the press, then 10 m straight on.' });
```

- Record with `expo-audio` (not in `app/package.json` yet), and send the file as the body:
  `fetch(url, {method: "POST", headers: {"content-type": "audio/m4a"}, body})`.
- Tapped option chips are text: send them with `send(label)` as today. Spoken picks ("first floor") are
  matched to the option by way B only; with way A the agent reads the person's words, which works too.
- Where voice lives: either mount `voice.app.router` in the backend (one URL, `EXPO_PUBLIC_API_URL`; see
  below) or run it on port 8001 and give the app `EXPO_PUBLIC_VOICE_URL`.

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
