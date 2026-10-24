"""HTTP backend for the app and the voice front end: one stable way to talk to the building agent.

  uv run --env-file .env uvicorn server.app:app --reload        # http://localhost:8000/docs

Endpoints
- GET  /buildings                         buildings this server knows
- GET  /buildings/{id}                    everything needed to draw it (floors, spaces, doors, lifts, things)
- POST /buildings/{id}/route              a route without the agent: length + lines per floor
- POST /sessions                          start a conversation with the agent about one building
- POST /sessions/{id}/chat                one turn: {reply, question, map}
- DELETE /sessions/{id}                   end it
"""

import threading
import uuid
from functools import lru_cache
from pathlib import Path

import anthropic
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from navagent.agent import CHAT, BuildingAgent
from navagent.tools import Session
from navcore.engine import Building, EngineError

DATA = Path(__file__).resolve().parent.parent / "data"
MAX_SESSIONS = 200

app = FastAPI(title="Talk to your building", version="1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_sessions: dict[str, BuildingAgent] = {}
_lock = threading.Lock()
_client: anthropic.Anthropic | None = None


def client() -> anthropic.Anthropic:
    """The Claude client; tests replace this function with a fake."""
    global _client
    if _client is None:
        _client = anthropic.Anthropic(max_retries=3)
    return _client


@lru_cache(maxsize=1)
def building_paths() -> dict[str, Path]:
    return {path.parent.name: path.parent for path in sorted(DATA.glob("*/*/building.json"))}


def building_path(building_id: str) -> Path:
    path = building_paths().get(building_id)
    if path is None:
        raise HTTPException(404, f"Unknown building '{building_id}'.")
    return path


@lru_cache(maxsize=32)
def load(building_id: str) -> Building:
    """Read-only copy for drawing and routing; conversations get their own copy (they can edit it)."""
    return Building.load(building_path(building_id))


# ---------- buildings ----------

@app.get("/buildings")
def list_buildings() -> list[dict]:
    rows = []
    for building_id, path in building_paths().items():
        rows.append({"id": building_id, "split": path.parent.name})
    return rows


@app.get("/buildings/{building_id}")
def get_building(building_id: str) -> dict:
    building = load(building_id)
    return {
        "building": building.info,
        "floors": sorted(building.data["floors"], key=lambda floor: floor["level"]),
        "spaces": [
            {key: space[key] for key in ("id", "floor_id", "type", "room_type", "name", "ref", "polygon")}
            | {"area_m2": round(building.area(space["id"]), 2), "anchor": list(building.anchor(space["id"]))}
            for space in building.data["spaces"]
        ],
        "openings": building.data["openings"],
        "vertical_connectors": building.data["vertical_connectors"],
        "assets": [
            {key: asset[key] for key in ("id", "name", "type", "category", "space_id", "floor_id", "position",
                                        "footprint")}
            for asset in building.data["assets"]
        ],
    }


class RouteRequest(BaseModel):
    start: str = Field(description="space id, 'Name (Floor name)' or room number")
    destination: str
    step_free: bool = False
    min_width_m: float = 0.0
    via: list[str] = []
    avoid: list[str] = []


@app.post("/buildings/{building_id}/route")
def route(building_id: str, request: RouteRequest) -> dict:
    session = Session(load(building_id))
    try:
        summary = session.route(
            request.start, request.destination, request.step_free, request.min_width_m, request.via, request.avoid
        )
        session.show_on_map(you_are_here=request.start, target=request.destination, show_last_route=True)
    except EngineError as error:
        raise HTTPException(422, str(error)) from error
    return {"summary": summary, "map": session.map_view}


# ---------- conversations ----------

class SessionRequest(BaseModel):
    building_id: str


class ChatRequest(BaseModel):
    text: str = Field(min_length=1, description="what the person said or typed, or the option they picked")


@app.post("/sessions")
def start_session(request: SessionRequest) -> dict:
    agent = BuildingAgent(Session(Building.load(building_path(request.building_id))), client(), mode=CHAT)
    session_id = uuid.uuid4().hex
    with _lock:
        if len(_sessions) >= MAX_SESSIONS:
            _sessions.pop(next(iter(_sessions)))  # forget the oldest conversation
        _sessions[session_id] = agent
    return {"session_id": session_id, "building_id": request.building_id,
            "building_name": agent.session.building.info["name"]}


def agent_for(session_id: str) -> BuildingAgent:
    agent = _sessions.get(session_id)
    if agent is None:
        raise HTTPException(404, "Unknown or expired session; start a new one.")
    return agent


@app.post("/sessions/{session_id}/chat")
def chat(session_id: str, request: ChatRequest) -> dict:
    """One turn. `question` (if any) is something the agent asks back, with 2-4 options the app shows as
    buttons and a voice front end can read out; the person's pick is sent back as the next `text`.
    `map` (if any) is what to draw: their position, the target and the route lines per floor."""
    agent = agent_for(session_id)
    try:
        reply = agent.ask(request.text)
    except anthropic.APIStatusError as error:
        raise HTTPException(502, f"Claude API error {error.status_code}") from error
    except anthropic.APIConnectionError as error:
        raise HTTPException(503, "Can't reach the Claude API") from error
    return {"reply": reply, "question": agent.session.pending_question, "map": agent.session.map_view}


@app.delete("/sessions/{session_id}")
def end_session(session_id: str) -> dict:
    with _lock:
        _sessions.pop(session_id, None)
    return {"ended": True}
