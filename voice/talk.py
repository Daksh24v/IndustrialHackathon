"""Try the voice in a terminal: type what you would say, hear the answer (played with macOS afplay).
Needs the backend (port 8000) and the voice service (port 8001) running.

  uv run python -m voice.talk                         # the factory building
  uv run python -m voice.talk proc-campus-dev-001     # another building

When the agent asks back, type the option's number or say it in your own words. Empty line or Ctrl-D quits.
"""

import base64
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import httpx

VOICE = os.environ.get("VOICE_URL", "http://localhost:8001")
BUILDING = "proc-factory-dev-003"


def play(audio: bytes, rate: float = 1.0) -> None:
    path = Path(tempfile.gettempdir()) / "talk-to-your-building.mp3"
    path.write_bytes(audio)
    if shutil.which("afplay"):
        subprocess.run(["afplay", "-r", str(rate), "-q", "1", str(path)], check=False)
    else:
        print(f"   (audio saved to {path})")


def main(building_id: str = BUILDING) -> None:
    client = httpx.Client(base_url=VOICE, timeout=180)
    try:
        session = client.post("/voice/sessions", json={"building_id": building_id}).raise_for_status().json()
    except httpx.HTTPError as error:
        sys.exit(f"Can't start a conversation at {VOICE}: {error}. Are both servers running?")
    print(f"Talking to {session['building_name']}. Empty line quits.\n")
    question = None
    while True:
        try:
            text = input("you> ").strip()
        except EOFError:
            break
        if not text:
            break
        if question and text.isdigit() and 1 <= int(text) <= len(question["options"]):
            text = question["options"][int(text) - 1]["label"]
        answer = client.post(f"/voice/sessions/{session['session_id']}/say", json={"text": text}).json()
        if "spoken" not in answer:
            print(f"   error: {answer.get('detail', answer)}\n")
            continue
        if answer["sent"] != text:
            print(f"   (understood as: {answer['sent']})")
        print(f"bot> {answer['spoken']}")
        question = answer["question"]
        for number, option in enumerate(question["options"] if question else [], 1):
            print(f"   {number}. {option['label']}")
        if answer["audio_error"]:
            print(f"   (no audio: {answer['audio_error']})")
        else:
            play(base64.b64decode(answer["audio_base64"]), answer.get("playback_rate", 1.0))
        print()
    client.delete(f"/voice/sessions/{session['session_id']}")


if __name__ == "__main__":
    main(*sys.argv[1:2])
