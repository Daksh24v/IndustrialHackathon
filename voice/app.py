"""Voice front end for the building agent: the only place the ElevenLabs key lives. It talks to the backend
(server/, port 8000) over its normal HTTP API and never changes it.

  uv run --env-file .env uvicorn server.app:app --port 8000          # the backend
  uv run --env-file .env uvicorn voice.app:app --port 8001           # this; demo page at http://localhost:8001

Endpoints (all under /voice, so `router` can also be mounted in the backend app; see voice/README.md)
- POST /voice/sessions                 start a conversation about one building (same body as /sessions)
- POST /voice/sessions/{id}/turn       one turn from speech: the raw recording as the body (webm, mp4, wav...)
- POST /voice/sessions/{id}/say        one turn from text: {"text": "..."} (typed, or a tapped option)
- DELETE /voice/sessions/{id}          end it
- POST /voice/speak                    say it, no agent: {"text": "Turn left now."} (AR guidance, alerts) or
                                       {"answer": <a /chat answer>} (short, with the question and its options)
- POST /voice/transcribe               a recording to text only, no agent; ?building_id= or ?session_id= helps
                                       it hear the building's names
- GET  /voice/audio/{id}.mp3           a spoken answer again by URL (`audio_url`), for players that stream

Every turn answers {heard, sent, reply, question, map, spoken, audio_base64, audio_error, playback_rate}:
`heard` is what the person said, `sent` what went to the agent (an option label when they clearly picked one),
`spoken` the words in `audio_base64` (MP3), to be played at `playback_rate`; `timings_ms` says where the time
went (transcribe, agent, speak).
"""

import base64
import hashlib
import os
import time
from collections import OrderedDict
from pathlib import Path

import httpx
from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from voice.elevenlabs import ElevenLabs, VoiceError
from voice.speech import DIDNT_GET_IT, keyterms, match_option, speakable, spoken_text

BACKEND = os.environ.get("NAV_BACKEND_URL", "http://localhost:8000")
# v4 Turbo ignores ElevenLabs' speed setting, so players speed up instead (pitch kept)
PLAYBACK_RATE = float(os.environ.get("VOICE_PLAYBACK_RATE") or 1.15)
# Each turn is sent as spoken: the backend's agent then answers in one short sentence for the ear, at lower
# effort (faster). VOICE_BRIEF=0 sends the words as a normal chat turn.
BRIEF = os.environ.get("VOICE_BRIEF", "1") != "0"
MAX_AUDIO_BYTES = 10_000_000
MAX_SPEAK_CHARS = 1000  # one spoken line, not a book: protects the credits
MAX_CLIPS = 200  # recent spoken answers kept for audio_url
PAGE = Path(__file__).resolve().parent / "web" / "index.html"

router = APIRouter(prefix="/voice", tags=["voice"])

_last_question: dict[str, dict | None] = {}  # per session: the options the person is answering
_session_building: dict[str, str] = {}       # per session: its building
_keyterms: dict[str, list[str]] = {}         # per building: names worth listening for in speech to text
_clips: OrderedDict[str, bytes] = OrderedDict()  # audio_url id -> MP3
_backend: httpx.Client | None = None
_voice: ElevenLabs | None = None


def backend() -> httpx.Client:
    """The building agent's HTTP API; tests replace this function with the in-process app."""
    global _backend
    if _backend is None:
        _backend = httpx.Client(base_url=BACKEND, timeout=120.0)
    return _backend


def voice() -> ElevenLabs:
    """The ElevenLabs client; tests replace this function with a fake."""
    global _voice
    if _voice is None:
        _voice = ElevenLabs()
    return _voice


def call_backend(method: str, path: str, **request) -> dict | list:
    try:
        response = backend().request(method, path, **request)
    except httpx.HTTPError as error:
        raise HTTPException(503, f"Can't reach the building backend at {BACKEND}: {error}") from error
    if response.status_code != 200:
        try:
            detail = response.json().get("detail", response.text)
        except ValueError:
            detail = response.text
        raise HTTPException(response.status_code, detail)
    return response.json()


class SessionRequest(BaseModel):
    building_id: str


class SayRequest(BaseModel):
    text: str = Field(min_length=1, description="what the person said or typed")
    audio: bool = Field(True, description="false: only the words, no ElevenLabs call (free)")


class SpeakRequest(BaseModel):
    text: str | None = Field(None, min_length=1, max_length=MAX_SPEAK_CHARS,
                             description="what to say, e.g. 'Turn left now.'")
    answer: dict | None = Field(None, description="a /chat answer {reply, question, map} to read out")
    clean: bool = Field(True, description="for text: read room numbers and units naturally, drop markdown")


@router.post("/sessions")
def start_session(request: SessionRequest) -> dict:
    session = call_backend("POST", "/sessions", json={"building_id": request.building_id})
    _last_question[session["session_id"]] = None
    _session_building[session["session_id"]] = request.building_id
    building_terms(request.building_id)
    return session


@router.post("/sessions/{session_id}/turn")
async def turn_from_speech(session_id: str, request: Request) -> dict:
    """The body is the recording itself, with its Content-Type (what the browser or phone recorded)."""
    started = time.perf_counter()
    heard = await transcribe_body(request, _session_building.get(session_id))
    transcribed = {"transcribe": since(started)}
    if not heard:
        return nothing_heard(transcribed)
    answer = turn(session_id, heard)
    answer["timings_ms"] = transcribed | answer["timings_ms"]
    return answer


@router.post("/sessions/{session_id}/say")
def say(session_id: str, request: SayRequest) -> dict:
    return turn(session_id, request.text, request.audio)


@router.delete("/sessions/{session_id}")
def end_session(session_id: str) -> dict:
    _last_question.pop(session_id, None)
    _session_building.pop(session_id, None)
    return call_backend("DELETE", f"/sessions/{session_id}")


@router.post("/speak")
def speak_text(request: SpeakRequest) -> dict:
    """Say anything the app decides itself (an AR step, an alert), or a /chat answer it got, without the agent."""
    if request.answer is not None:
        return speak(spoken_text(request.answer)[:MAX_SPEAK_CHARS])
    if request.text is None:
        raise HTTPException(422, "Send `text` or `answer`.")
    return speak(speakable(request.text) if request.clean else request.text)


@router.post("/transcribe")
async def transcribe(request: Request, building_id: str | None = None, session_id: str | None = None) -> dict:
    """What was said, as text, for an app that sends it to /chat itself. Pass the building (or a voice
    session) so names like "Quality lab 0.21" are heard right."""
    return {"heard": await transcribe_body(request, building_id or _session_building.get(session_id or ""))}


async def transcribe_body(request: Request, building_id: str | None) -> str:
    audio = await request.body()
    if not audio or len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(422, "Send the recording (up to 10 MB) as the request body.")
    content_type = request.headers.get("content-type", "audio/webm").split(";")[0]
    terms = building_terms(building_id) if building_id else []
    try:
        return voice().transcribe(audio, content_type, terms)
    except VoiceError as error:
        raise HTTPException(502, str(error)) from error


@router.get("/audio/{clip_id}.mp3", include_in_schema=False)
def audio(clip_id: str) -> Response:
    clip = _clips.get(clip_id)
    if clip is None:
        raise HTTPException(404, "No such clip (they are kept for the last 200 answers).")
    return Response(clip, media_type="audio/mpeg", headers={"cache-control": "max-age=3600"})


def building_terms(building_id: str) -> list[str]:
    if building_id not in _keyterms:
        _keyterms[building_id] = keyterms(call_backend("GET", f"/buildings/{building_id}"))
    return _keyterms[building_id]


def turn(session_id: str, heard: str, with_audio: bool = True) -> dict:
    """What the person said -> the agent -> what we say back."""
    question = _last_question.get(session_id)
    sent = match_option(heard, question["options"]) if question else heard
    started = time.perf_counter()
    answer = call_backend("POST", f"/sessions/{session_id}/chat", json={"text": sent, "spoken": BRIEF})
    asked = since(started)
    _last_question[session_id] = answer.get("question")
    spoken = speak(spoken_text(answer), with_audio)
    spoken["timings_ms"] = {"agent": asked} | spoken["timings_ms"]
    return {"heard": heard, "sent": sent, **answer, **spoken}


def nothing_heard(timings_ms: dict) -> dict:
    """Silence or noise: ask again without bothering the agent (the open question stays open)."""
    spoken = speak(DIDNT_GET_IT)
    spoken["timings_ms"] = timings_ms | spoken["timings_ms"]
    return {"heard": "", "sent": None, "reply": "", "question": None, "map": None, **spoken}


def speak(text: str, with_audio: bool = True) -> dict:
    audio, audio_url, audio_error = None, None, None
    started = time.perf_counter()
    if with_audio:
        try:
            clip = voice().speak(text)
            audio, audio_url = base64.b64encode(clip).decode(), keep_clip(clip)
        except VoiceError as error:
            audio_error = str(error)  # the words still go back, so the app can show them
    return {"spoken": text, "audio_base64": audio, "audio_url": audio_url, "audio_error": audio_error,
            "playback_rate": PLAYBACK_RATE, "timings_ms": {"speak": since(started)}}


def keep_clip(clip: bytes) -> str:
    """Remember the MP3 for a while and return its path under this router."""
    clip_id = hashlib.sha256(clip).hexdigest()[:24]
    _clips[clip_id] = clip
    _clips.move_to_end(clip_id)
    while len(_clips) > MAX_CLIPS:
        _clips.popitem(last=False)
    return f"{router.prefix}/audio/{clip_id}.mp3"


def since(started: float) -> int:
    return round((time.perf_counter() - started) * 1000)


app = FastAPI(title="Talk to your building: voice", version="0.2")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(router)


@app.get("/", include_in_schema=False)
def page() -> FileResponse:
    """The hands-free demo page (microphone in, speaker out)."""
    return FileResponse(PAGE)
