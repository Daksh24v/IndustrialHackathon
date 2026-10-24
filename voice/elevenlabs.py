"""The two ElevenLabs calls voice needs, over plain HTTP (httpx is already a dependency, so nothing new to
install): speech to text (Scribe) and text to speech. Spoken audio is cached on disk, so repeated lines and
demo retakes cost no credits.

Settings (from .env): ELEVENLABS_API_KEY, and optionally ELEVENLABS_VOICE_ID, ELEVENLABS_TTS_MODEL,
ELEVENLABS_STT_MODEL."""

import hashlib
import os
from pathlib import Path

import httpx

API = "https://api.elevenlabs.io"
TTS_MODEL = "eleven_v4_turbo"   # ~100 ms, made for agents
STT_MODEL = "scribe_v2"
VOICE_ID = "q1OMOTZNtqpS50TIQtu4"  # "Tony Smyles", warm and conversational; add it to My Voices to use it
OUTPUT_FORMAT = "mp3_44100_128"
MAX_KEYTERMS = 100  # above 100, every request is billed as at least 20 s
CACHE = Path(__file__).resolve().parent / ".cache"


class VoiceError(Exception):
    """ElevenLabs couldn't do it (bad key, no credits, network)."""


class ElevenLabs:
    def __init__(
        self,
        api_key: str | None = None,
        voice_id: str | None = None,
        tts_model: str | None = None,
        stt_model: str | None = None,
        cache: Path | None = CACHE,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        api_key = api_key or os.environ.get("ELEVENLABS_API_KEY", "")
        if not api_key:
            raise VoiceError("ELEVENLABS_API_KEY is not set; put it in .env.")
        self.voice_id = voice_id or os.environ.get("ELEVENLABS_VOICE_ID") or VOICE_ID
        self.tts_model = tts_model or os.environ.get("ELEVENLABS_TTS_MODEL") or TTS_MODEL
        self.stt_model = stt_model or os.environ.get("ELEVENLABS_STT_MODEL") or STT_MODEL
        self.cache = cache
        self.http = httpx.Client(base_url=API, headers={"xi-api-key": api_key}, timeout=30.0, transport=transport)

    def speak(self, text: str) -> bytes:
        """MP3 audio of the text."""
        path = self.cache_path(text)
        if path and path.exists():
            return path.read_bytes()
        response = self.post(f"/v1/text-to-speech/{self.voice_id}", params={"output_format": OUTPUT_FORMAT},
                             json={"text": text, "model_id": self.tts_model})
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(response.content)
        return response.content

    def transcribe(self, audio: bytes, content_type: str = "audio/webm", keyterms: list[str] = ()) -> str:
        """What was said in the recording (any language Scribe knows)."""
        data = {"model_id": self.stt_model, "tag_audio_events": "false"}
        terms = usable_keyterms(keyterms)
        if terms:
            data["keyterms"] = terms
        response = self.post("/v1/speech-to-text", data=data, files={"file": ("speech", audio, content_type)})
        return response.json().get("text", "").strip()

    def cache_path(self, text: str) -> Path | None:
        if self.cache is None:
            return None
        settings = f"{self.voice_id}|{self.tts_model}|{OUTPUT_FORMAT}"
        key = hashlib.sha256(f"{settings}|{text}".encode()).hexdigest()
        return self.cache / f"{key[:32]}.mp3"

    def post(self, path: str, **request) -> httpx.Response:
        try:
            response = self.http.post(path, **request)
        except httpx.HTTPError as error:
            raise VoiceError(f"Can't reach ElevenLabs: {error}") from error
        if response.status_code != 200:
            raise VoiceError(f"ElevenLabs {response.status_code}: {response.text[:300]}")
        return response


def usable_keyterms(terms) -> list[str]:
    """Scribe's limits: under 50 characters, at most 5 words, none of < > { } [ ] \\; first 100, no repeats."""
    usable = []
    for term in terms:
        term = " ".join(str(term).split())
        if term and len(term) < 50 and len(term.split()) <= 5 and not set(term) & set("<>{}[]\\") \
                and term not in usable:
            usable.append(term)
    return usable[:MAX_KEYTERMS]
