"""The voice front end (voice/): spoken-text rules, option matching, the ElevenLabs client against a fake
HTTP server, and whole turns through the real backend with a scripted fake Claude. No API calls."""

import base64
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from server import app as server
from tests.fake_claude import FakeClient
from voice import app as voice_app
from voice.elevenlabs import ElevenLabs, VoiceError, usable_keyterms
from voice.speech import DIDNT_GET_IT, keyterms, match_option, say_numbers, short, spoken_text

BUILDING = "proc-factory-dev-003"
FLOORS = [{"label": "Ground floor", "description": ""}, {"label": "Floor 1", "description": ""}]
ROUTE_MAP = {"you_are_here": {"label": "Quality lab 0.21 (Ground floor)"}, "target": {"label": "x"},
             "route": {"pieces": []}, "focus_floor_id": "F0"}


# ---------- spoken text ----------

def test_question_is_read_with_its_options():
    answer = {"reply": "", "question": {"question": "Which floor are you on?", "options": FLOORS}, "map": None}
    assert spoken_text(answer) == "Which floor are you on? Ground floor, or Floor 1?"


def test_three_options_and_reply_before_question():
    options = [{"label": "Ground floor"}, {"label": "Floor 1"}, {"label": "Floor 2"}]
    answer = {"reply": "There are two printers.", "question": {"question": "Which one?", "options": options}}
    assert spoken_text(answer) == "There are two printers. Which one? Ground floor, Floor 1, or Floor 2?"


def test_route_answer_points_to_the_map_once():
    answer = {"reply": "Office 1.04 is upstairs, about 143.27 m.", "question": None, "map": ROUTE_MAP}
    assert spoken_text(answer) == "Office one zero four is upstairs, about 143 metres. It's on your map."
    already = {"reply": "I put it on your map.", "question": None, "map": ROUTE_MAP}
    assert spoken_text(already) == "I put it on your map."
    assert spoken_text({"reply": "Closed.", "question": None, "map": None}) == "Closed."


def test_nothing_to_say():
    assert spoken_text({"reply": "", "question": None, "map": None}) == DIDNT_GET_IT


def test_markdown_and_step_lists_become_two_sentences():
    reply = "**Coffee machine** in Kitchen 2.04.\n\n1. Leave the lab\n2. Turn left\n3. Take the stairs"
    assert short(reply) == "Coffee machine in Kitchen 2.04. Leave the lab."


@pytest.mark.parametrize("text, said", [
    ("Quality lab 0.21 (Ground floor)", "Quality lab zero two one, Ground floor"),
    ("Desk 2.03-B", "Desk two zero three B"),
    ("Storage -1.05", "Storage minus one zero five"),
    ("Seminar room 0.32, 61.4 m²", "Seminar room zero three two, 61 square metres"),
    ("a 1.1 m wide trolley", "a 1.1-metre wide trolley"),
    ("doors under 1.1 m", "doors under 1.1 metres"),
    ("just 1 m away", "just 1 metre away"),
    ("It's a 145 m walk", "It's a 145-metre walk"),
    ("an 8.5 m detour", "an 8.5-metre detour"),
    ("Lift 1 to Floor 2", "Lift 1 to Floor 2"),
    ("Fertigung Ost 27", "Fertigung Ost 27"),
])
def test_numbers_are_said_naturally(text, said):
    assert say_numbers(text) == said


# ---------- what the person says back ----------

@pytest.mark.parametrize("heard, sent", [
    ("Ground floor", "Ground floor"),
    ("I'm on the ground floor.", "Ground floor"),
    ("first floor", "Floor 1"),
    ("Floor one", "Floor 1"),
    ("the second one", "Floor 1"),
    ("the last option", "Floor 1"),
    ("I'm next to the coffee machine", "I'm next to the coffee machine"),
])
def test_match_option(heard, sent):
    assert match_option(heard, FLOORS) == sent


def test_match_option_prefers_the_longer_label_and_gives_up_on_ties():
    options = [{"label": "Lift 1"}, {"label": "Lift 1 east"}, {"label": "Stairs"}]
    assert match_option("lift one east please", options) == "Lift 1 east"
    tie = [{"label": "Press A"}, {"label": "Press B"}]
    assert match_option("press a or b", tie) == "press a or b"


# ---------- ElevenLabs client ----------

def fake_elevenlabs(tmp_path, status=200):
    calls = []

    def handle(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if status != 200:
            return httpx.Response(status, json={"detail": {"status": "quota_exceeded"}})
        if request.url.path.startswith("/v1/text-to-speech/"):
            return httpx.Response(200, content=b"MP3:" + json.loads(request.content)["text"].encode())
        return httpx.Response(200, json={"text": " Where is the CNC mill? ", "language_code": "en"})

    client = ElevenLabs(api_key="test-key", voice_id="v1", cache=tmp_path, transport=httpx.MockTransport(handle))
    return client, calls


def test_speak_sends_key_model_and_caches(tmp_path):
    client, calls = fake_elevenlabs(tmp_path)
    assert client.speak("Hello.") == b"MP3:Hello."
    assert client.speak("Hello.") == b"MP3:Hello."
    assert len(calls) == 1  # the second one came from the cache
    request = calls[0]
    assert request.url.path == "/v1/text-to-speech/v1" and request.headers["xi-api-key"] == "test-key"
    assert json.loads(request.content)["model_id"] == "eleven_v4_turbo"


def test_transcribe_sends_audio_and_keyterms(tmp_path):
    client, calls = fake_elevenlabs(tmp_path)
    assert client.transcribe(b"RIFF....", "audio/wav", ["CNC mill", "Quality lab 0.21"]) == \
        "Where is the CNC mill?"
    body = calls[0].content
    assert b"scribe_v2" in body and b"RIFF...." in body and b"Quality lab 0.21" in body


def test_errors_and_missing_key(tmp_path, monkeypatch):
    client, _ = fake_elevenlabs(tmp_path, status=401)
    with pytest.raises(VoiceError, match="401"):
        client.speak("Hi.")
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    with pytest.raises(VoiceError, match="not set"):
        ElevenLabs()


def test_usable_keyterms():
    terms = ["CNC mill", "CNC mill", "x" * 60, "one two three four five six", "Desk [A]", ""] + \
        [f"Office {n}" for n in range(200)]
    usable = usable_keyterms(terms)
    assert usable[0] == "CNC mill" and len(usable) == 100 and "Desk [A]" not in usable


# ---------- whole turns, through the real backend ----------

class FakeVoice:
    def __init__(self, fail=False, heard=()):
        self.spoken, self.fail, self.heard, self.recordings = [], fail, list(heard), []

    def speak(self, text: str) -> bytes:
        if self.fail:
            raise VoiceError("ElevenLabs 401: invalid key")
        self.spoken.append(text)
        return b"MP3"

    def transcribe(self, audio: bytes, content_type: str, keyterms: list[str]) -> str:
        if self.fail:
            raise VoiceError("ElevenLabs 401: invalid key")
        self.recordings.append((audio, content_type, keyterms))
        return self.heard.pop(0)


@pytest.fixture
def talk(monkeypatch):
    """Voice app wired to the in-process backend; talk.script(*turns) sets what fake Claude does."""
    fake_voice = FakeVoice()
    monkeypatch.setattr(voice_app, "voice", lambda: fake_voice)
    monkeypatch.setattr(server, "client", lambda: FakeClient([]))
    with TestClient(server.app) as backend, TestClient(voice_app.app) as test_client:
        monkeypatch.setattr(voice_app, "backend", lambda: backend)

        def script(*turns):
            fake = FakeClient(list(turns))
            monkeypatch.setattr(server, "client", lambda: fake)
            return fake

        test_client.script = script
        test_client.fake_voice = fake_voice
        yield test_client


def test_question_then_spoken_pick_then_route(talk):
    talk.script(
        ([("ask_user", {"question": "Which floor are you on?",
                        "options": [{"label": "Ground floor"}, {"label": "Floor 1"}]})], ""),
        ([("find_route", {"start": "Quality lab 0.21 (Ground floor)", "destination": "Office 1.04 (Floor 1)"}),
          ("show_on_map", {"you_are_here": "Quality lab 0.21 (Ground floor)", "target": "Office 1.04 (Floor 1)",
                           "show_last_route": True})],
         "Office 1.04 is upstairs, about 140 m."),
    )
    session = talk.post("/voice/sessions", json={"building_id": BUILDING}).json()["session_id"]
    first = talk.post(f"/voice/sessions/{session}/say", json={"text": "Where is office 1.04?"}).json()
    assert first["spoken"] == "Which floor are you on? Ground floor, or Floor 1?"
    assert base64.b64decode(first["audio_base64"]) == b"MP3" and first["audio_error"] is None
    second = talk.post(f"/voice/sessions/{session}/say", json={"text": "uh the ground floor"}).json()
    assert second["heard"] == "uh the ground floor" and second["sent"] == "Ground floor"
    assert second["spoken"] == "Office one zero four is upstairs, about 140 metres. It's on your map."
    assert second["map"]["route"]["pieces"] and second["question"] is None
    assert talk.fake_voice.spoken == [first["spoken"], second["spoken"]]


def test_text_only_turn_and_failing_voice_still_answer(talk, monkeypatch):
    talk.script(([], "Hi, ask me where anything is."), ([], "Sure."))
    session = talk.post("/voice/sessions", json={"building_id": BUILDING}).json()["session_id"]
    quiet = talk.post(f"/voice/sessions/{session}/say", json={"text": "hi", "audio": False}).json()
    assert quiet["audio_base64"] is None and talk.fake_voice.spoken == []
    monkeypatch.setattr(voice_app, "voice", lambda: FakeVoice(fail=True))
    broken = talk.post(f"/voice/sessions/{session}/say", json={"text": "thanks"}).json()
    assert broken["spoken"] == "Sure." and "401" in broken["audio_error"]


def test_backend_errors_pass_through(talk):
    assert talk.post("/voice/sessions", json={"building_id": "nope"}).status_code == 404
    assert talk.post("/voice/sessions/unknown/say", json={"text": "hi"}).status_code == 404
    session = talk.post("/voice/sessions", json={"building_id": BUILDING}).json()["session_id"]
    assert talk.delete(f"/voice/sessions/{session}").json() == {"ended": True}


def test_keyterms_from_the_building():
    building = server.get_building(BUILDING)
    terms = keyterms(building)
    assert terms[:2] == ["Ground floor", "Floor 1"]
    assert "coordinate measuring machine" in terms and "Quality lab 0.21" in terms
    assert len(terms) == len(set(terms))


def test_spoken_turn_uses_transcript_keyterms_and_options(talk):
    talk.fake_voice.heard = ["Where is office 1.04?", "first floor"]
    talk.script(
        ([("ask_user", {"question": "Which floor are you on?",
                        "options": [{"label": "Ground floor"}, {"label": "Floor 1"}]})], ""),
        ([], "Office 1.04 is right next to you."),
    )
    session = talk.post("/voice/sessions", json={"building_id": BUILDING}).json()["session_id"]
    first = talk.post(f"/voice/sessions/{session}/turn", content=b"WEBM-AUDIO",
                      headers={"content-type": "audio/webm;codecs=opus"}).json()
    audio, content_type, terms = talk.fake_voice.recordings[0]
    assert audio == b"WEBM-AUDIO" and content_type == "audio/webm" and "Quality lab 0.21" in terms
    assert first["heard"] == "Where is office 1.04?" and first["playback_rate"] == voice_app.PLAYBACK_RATE
    second = talk.post(f"/voice/sessions/{session}/turn", content=b"M4A",
                       headers={"content-type": "audio/m4a"}).json()
    assert second["heard"] == "first floor" and second["sent"] == "Floor 1"
    assert second["spoken"] == "Office one zero four is right next to you."


def test_silence_asks_again_without_the_agent(talk):
    talk.fake_voice.heard = [""]
    talk.script()  # the agent must not be called
    session = talk.post("/voice/sessions", json={"building_id": BUILDING}).json()["session_id"]
    answer = talk.post(f"/voice/sessions/{session}/turn", content=b"noise").json()
    assert answer["spoken"] == DIDNT_GET_IT and answer["sent"] is None and answer["audio_base64"]
    assert talk.post(f"/voice/sessions/{session}/turn", content=b"").status_code == 422


def test_failed_transcription_is_502(talk, monkeypatch):
    session = talk.post("/voice/sessions", json={"building_id": BUILDING}).json()["session_id"]
    monkeypatch.setattr(voice_app, "voice", lambda: FakeVoice(fail=True))
    response = talk.post(f"/voice/sessions/{session}/turn", content=b"audio")
    assert response.status_code == 502 and "401" in response.json()["detail"]


def test_demo_page_is_served(talk):
    page = talk.get("/")
    assert page.status_code == 200 and "/voice/sessions" in page.text and "playbackRate" in page.text


def test_router_mounts_in_another_app():
    from fastapi import FastAPI
    host = FastAPI()
    host.include_router(voice_app.router)
    paths = set(host.openapi()["paths"])
    assert {"/voice/sessions", "/voice/sessions/{session_id}/turn", "/voice/sessions/{session_id}/say"} <= paths
