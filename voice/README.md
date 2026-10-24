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

- **Demo page with the microphone:** http://localhost:8001 . Press Start once, then just talk: it hears when
  you stop (0.8 s of quiet), answers out loud, and listens again. Talk over it (or press space) to interrupt;
  "End conversation" stops it. Says "One moment." if the agent takes over 1.2 s, and shows where the time went.
  Headphones work best (on speakers, interrupting needs you to speak up). Options also show as chips.
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
| `audio_url` | the same MP3 as a URL on this service (`/voice/audio/<id>.mp3`), for players that stream |
| `playback_rate` | play at this rate with pitch kept (1.15: v4 Turbo ignores ElevenLabs' own speed setting) |
| `timings_ms` | where the time went: `transcribe`, `agent`, `speak` |

When nothing was heard, the turn says "Sorry, I didn't catch that…" without calling the agent.

## In the Expo app (`app/`)

Done with way A: `app/src/useVoice.ts` (expo-audio) and `app/src/voice.ts` (this API). The mic button
starts a spoken conversation: it stops listening on a pause (recorder metering), hands the words to the
app's normal `send()`, plays the answer from `audio_url` at `playback_rate`, says "One moment." when
the agent is slow, and listens again. Set `EXPO_PUBLIC_VOICE_URL` (default `http://localhost:8001`).
The pattern, for new features:

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
| `VOICE_PLAYBACK_RATE` | `1.15` |
| `VOICE_BRIEF` | `1`: turns are sent as spoken (one short sentence, lower effort); `0` as normal chat turns |
| `NAV_BACKEND_URL` | `http://localhost:8000` |

Spoken audio is cached in `voice/.cache/` (gitignored), so repeated lines cost no credits.

## Serving voice from the backend instead (one process)

`voice.app.router` holds all `/voice/...` endpoints, so `server/app.py` can mount them:

```python
from voice.app import router as voice_router
app.include_router(voice_router)
```

Voice still reaches the agent over HTTP at `NAV_BACKEND_URL`, which is then the backend itself.

## Spoken turns in the backend

`POST /sessions/{id}/chat` takes `"spoken": true`: the agent answers in one short sentence for the ear, with
no markdown, at lower effort (faster). Voice sends every turn that way (unless `VOICE_BRIEF=0`), and so does
the app while the mic conversation is on. `voice/speech.py` still trims replies as a safety net: only the
question when the agent asks back, no "on your map" talk, at most two sentences and 35 words.

## Tests

`uv run pytest tests/test_voice.py` (free: ElevenLabs is faked, Claude is the scripted fake from `tests/`).
