"""HTTP backend for the app and the voice front end: one stable way to talk to the building agent.

  uv run --env-file .env uvicorn server.app:app --reload        # http://localhost:8000/docs

Endpoints
- GET  /buildings                         buildings this server knows: id, name, source, split
- POST /buildings/reload                  look for buildings again (one dropped into data/<split>/<id>/)
- GET  /buildings/{id}                    everything needed to draw it (floors, spaces, doors, lifts, things)
- GET  /buildings/{id}/outline            per floor: footprint, elevation, height (the 3D outside view)
- POST /buildings/{id}/route              a route without the agent: length + lines per floor
- POST /sessions                          start a conversation with the agent about one building
- POST /sessions/{id}/chat                one turn: {reply, question, map}
- POST /sessions/{id}/position            where the person is: a place, or a tapped point on a floor
- GET/DELETE /sessions/{id}/position      where they are, were and the route they follow / forget it
- DELETE /sessions/{id}                   end it
- POST /imports                           set up a new building from floor plans: a builder conversation
- POST /imports/{session_id}/save         save it (the agent can also save when the person confirms)
- /voice/...                              speech in and out with ElevenLabs (voice/README.md); GET /voice is
                                          the hands-free demo page. Needs ELEVENLABS_API_KEY in .env.
"""

import json
import logging
import threading
import uuid
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path

import os

import anthropic
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field
from shapely.ops import unary_union

from navagent.agent import BUILDER, CHAT, BuildingAgent
from navagent.builder import Draft
from navagent.tools import Session
from navcore.engine import Building, Constraints, EngineError
from navcore.plans import PlanError
from navcore.resolve import AmbiguousSpace, NoSuchSpace
from voice import app as voice_service

DATA = Path(__file__).resolve().parent.parent / "data"
MAX_SESSIONS = 200
CALL_TIMEOUT_S = 90  # one Claude call; a stalled one must not hang the demo for minutes
DEMO_BUILDING = os.environ.get("NAV_DEMO_BUILDING", "proc-factory-dev-003")
log = logging.getLogger(__name__)


def warm_up() -> None:
    """Build the demo building's route graph before anyone asks, so the first route in the demo is fast."""
    try:
        load(DEMO_BUILDING).graph(Constraints())
    except Exception:  # a missing or broken demo building must not stop the server
        log.exception("Couldn't warm up %s", DEMO_BUILDING)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    threading.Thread(target=warm_up, name="warm-up", daemon=True).start()
    yield


app = FastAPI(title="Talk to your building", version="1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_sessions: dict[str, BuildingAgent] = {}
_turns: dict[str, threading.Lock] = {}  # one turn at a time per conversation, so histories never interleave
_lock = threading.Lock()
_client: anthropic.Anthropic | None = None


def client() -> anthropic.Anthropic:
    """The Claude client; tests replace this function with a fake."""
    global _client
    if _client is None:
        _client = anthropic.Anthropic(max_retries=3, timeout=CALL_TIMEOUT_S)
    return _client


@lru_cache(maxsize=1)
def building_paths() -> dict[str, Path]:
    return {path.parent.name: path.parent for path in sorted(DATA.glob("*/*/building.json"))}


def building_path(building_id: str) -> Path:
    path = building_paths().get(building_id)
    if path is None:
        building_paths.cache_clear()  # maybe it was dropped in after start (the Sunday building)
        path = building_paths().get(building_id)
    if path is None:
        raise HTTPException(404, f"Unknown building '{building_id}'.")
    return path


@lru_cache(maxsize=1024)
def building_info(path: Path, modified: float) -> dict:
    """The building.json's `building` object (name, source, ...); read once per file version."""
    return json.loads((path / "building.json").read_text(encoding="utf-8"))["building"]


@lru_cache(maxsize=32)
def load(building_id: str) -> Building:
    """Read-only copy for drawing and routing; conversations get their own copy (they can edit it)."""
    return Building.load(building_path(building_id))


# ---------- buildings ----------

@app.get("/buildings")
def list_buildings() -> list[dict]:
    building_paths.cache_clear()  # a glob is cheap; a building dropped in shows up without a restart
    rows = []
    for building_id, path in building_paths().items():
        try:
            info = building_info(path, (path / "building.json").stat().st_mtime)
        except (OSError, ValueError, KeyError):
            info = {}  # half-copied or broken: still listed, the detail call says what's wrong
        rows.append({"id": building_id, "split": path.parent.name, "name": info.get("name") or building_id,
                     "source": info.get("source") or path.parent.name})
    return rows


@app.post("/buildings/reload")
def reload_buildings() -> dict:
    """Forget everything read so far and look for buildings again."""
    forget_buildings()
    building_info.cache_clear()
    return {"buildings": len(building_paths())}


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


@app.get("/buildings/{building_id}/outline")
def outline(building_id: str) -> dict:
    """Per floor: its footprint (outer outlines of all spaces merged), elevation and height, for the 3D
    outside view. Polygons are lists of [x, y] in metres; a floor can have several parts."""
    building = load(building_id)
    floors = []
    for floor in sorted(building.data["floors"], key=lambda item: item["level"]):
        merged = unary_union([building.polygons[space["id"]].buffer(0.05) for space in building.spaces_on(floor["id"])])
        merged = merged.buffer(-0.05).simplify(0.05)
        parts = list(getattr(merged, "geoms", [merged]))
        floors.append({
            "id": floor["id"], "level": floor["level"], "name": floor["name"],
            "elevation_m": floor["elevation_m"], "height_m": floor.get("height_m", 3.5),
            "footprints": [[[round(x, 3), round(y, 3)] for x, y in part.exterior.coords[:-1]]
                           for part in parts if not part.is_empty and part.area > 0.5],
        })
    return {"building": building.info, "floors": floors}


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
    spoken: bool = Field(False, description="said out loud and the answer is read out: one short sentence, faster")


@app.post("/sessions")
def start_session(request: SessionRequest) -> dict:
    agent = BuildingAgent(Session(Building.load(building_path(request.building_id))), client(), mode=CHAT)
    session_id = uuid.uuid4().hex
    with _lock:
        remember(session_id, agent)
    return {"session_id": session_id, "building_id": request.building_id,
            "building_name": agent.session.building.info["name"]}


def remember(session_id: str, agent: BuildingAgent) -> None:
    """Keep a new conversation (call with _lock held)."""
    if len(_sessions) >= MAX_SESSIONS:
        oldest = next(iter(_sessions))  # forget the oldest conversation
        _sessions.pop(oldest)
        _turns.pop(oldest, None)
    _sessions[session_id] = agent
    _turns[session_id] = threading.Lock()


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
    with _lock:
        turn = _turns.setdefault(session_id, threading.Lock())
    with turn:  # a second message waits for the first answer
        try:
            reply = agent.ask(request.text, spoken=request.spoken)
        except anthropic.APIStatusError as error:
            raise HTTPException(502, f"Claude API error {error.status_code}") from error
        except anthropic.APIConnectionError as error:
            raise HTTPException(503, "Can't reach the Claude API") from error
        except HTTPException:
            raise
        except Exception as error:
            log.exception("Chat turn failed in session %s", session_id)
            raise HTTPException(500, f"Finni hit an error answering that ({type(error).__name__}); "
                                     "please try again.") from error
        draft = agent.session.draft
        if draft is not None and draft.saved_to is not None:
            forget_buildings()  # the agent saved it: make it visible to GET /buildings and new sessions
        return {"reply": reply, "question": agent.session.pending_question, "map": agent.session.map_view}


# ---------- new buildings from floor plans (Level 4) ----------

class PlanFile(BaseModel):
    name: str = Field(description="file name; floor_<level>.svg tells the floor level")
    svg: str = Field(min_length=1, description="the SVG text of one floor plan")


class ImportRequest(BaseModel):
    files: list[PlanFile] = Field(min_length=1)
    name: str | None = None


class SaveRequest(BaseModel):
    name: str | None = None


def forget_buildings() -> None:
    building_paths.cache_clear()
    load.cache_clear()


@app.post("/imports")
def start_import(request: ImportRequest) -> dict:
    """Read the plans into a draft and start a builder conversation about it. Chat with
    /sessions/{session_id}/chat as usual; the agent shows what it understood and asks about what the plans
    don't say (room types, door widths, floor heights, unmarked stairs)."""
    building_id = f"imported-{uuid.uuid4().hex[:8]}"
    try:
        draft = Draft.from_svgs([(item.name, item.svg) for item in request.files], building_id, request.name)
    except PlanError as error:
        raise HTTPException(422, str(error)) from error
    session = Session(draft.loaded(), draft=draft)
    agent = BuildingAgent(session, client(), mode=BUILDER)
    session_id = uuid.uuid4().hex
    with _lock:
        remember(session_id, agent)
    return {"session_id": session_id, "building_id": building_id, "summary": draft.summary()}


@app.post("/imports/{session_id}/save")
def save_import(session_id: str, request: SaveRequest) -> dict:
    agent = agent_for(session_id)
    if agent.session.draft is None:
        raise HTTPException(400, "This conversation isn't setting up a building.")
    try:
        path = agent.session.draft.save(request.name)
    except EngineError as error:
        raise HTTPException(422, str(error)) from error
    forget_buildings()
    return {"saved": True, "building_id": path.name}


class PositionRequest(BaseModel):
    space: str | None = Field(None, min_length=1, description="a room ('Name (Floor name)', a name, a number, "
                                                             "an id), a thing next to them, or an entrance id")
    floor: str | None = Field(None, description="with x and y: the floor of a point (a tap on the map, AR later)")
    x: float | None = None
    y: float | None = None


@app.post("/sessions/{session_id}/position")
def set_position(session_id: str, request: PositionRequest) -> dict:
    """Where the person is: a place, or a point on a floor (tap on the map; the AR camera later). From then on
    the agent uses it instead of asking, routes start there, and the map shows it as 'you are here'. If they
    are following a route, the answer says how far along they are. A name shared by several rooms answers 422
    with `candidates` to pick from."""
    agent = agent_for(session_id)
    try:
        return agent.session.set_position(request.space, request.floor, request.x, request.y, source="phone")
    except AmbiguousSpace as error:
        building = agent.session.building
        raise HTTPException(422, {"message": str(error), "candidates": [
            {"space_id": space_id, "label": building.label(space_id)} for space_id in error.candidates]}) from error
    except NoSuchSpace as error:
        building = agent.session.building
        raise HTTPException(422, {"message": str(error), "candidates": [
            {"space_id": space_id, "label": building.label(space_id)} for space_id in error.suggestions]}) from error
    except EngineError as error:
        raise HTTPException(422, {"message": str(error), "candidates": []}) from error


@app.get("/sessions/{session_id}/position")
def get_position(session_id: str) -> dict:
    """Where the person is now, where they were, and the route they are following."""
    return agent_for(session_id).session.position_state()


@app.delete("/sessions/{session_id}/position")
def clear_position(session_id: str) -> dict:
    """Forget the position (e.g. the person put the phone away and walked off)."""
    return agent_for(session_id).session.clear_position()


@app.delete("/sessions/{session_id}")
def end_session(session_id: str) -> dict:
    with _lock:
        _sessions.pop(session_id, None)
        _turns.pop(session_id, None)
    return {"ended": True}


# ---------- voice ----------

# The voice endpoints live here too, so the app needs one server and one URL. Voice talks to the agent through
# this API; unless NAV_BACKEND_URL points elsewhere, it calls this app in-process instead of over the network.
app.include_router(voice_service.router)
if "NAV_BACKEND_URL" not in os.environ:
    _in_process: TestClient | None = None

    def _voice_backend() -> TestClient:
        global _in_process
        if _in_process is None:
            _in_process = TestClient(app, raise_server_exceptions=False)
        return _in_process

    voice_service.backend = _voice_backend


@app.get("/voice", include_in_schema=False)
def voice_page() -> FileResponse:
    """The hands-free demo page (microphone in, speaker out)."""
    return FileResponse(voice_service.PAGE)


# ---------- the website ----------

# Last, so every API path above wins: everything else is the built Finni site (`npm run build` in app/), so site
# and API share one address. Without a build the API works as before.
WEB = Path(__file__).resolve().parent.parent / "app" / "dist"
if (WEB / "index.html").exists():
    app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
