"""Reports for the whole building ("the office lift is broken") and safety mode's quick buttons, through the HTTP
backend with a scripted fake Claude (no API calls, no email)."""

import pytest
from fastapi.testclient import TestClient

from navagent.agent import BENCHMARK, CHAT, BuildingAgent
from navagent.tools import Session
from navcore.engine import EngineError
from server import app as server
from server.reports import Message, Report, Reports
from tests.fake_claude import FakeClient, tool_names

BUILDING = "proc-factory-dev-003"
LIFT = "proc-factory-dev-003-V02"  # Office lift, the only lift (Ground floor <-> Floor 1)


@pytest.fixture
def http(monkeypatch):
    monkeypatch.setattr(server, "_reports", Reports(None))  # in memory: never the real .finni/reports.json
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    monkeypatch.delenv("MAINTENANCE_EMAIL", raising=False)
    holder = {}

    def install(*turns):
        holder["fake"] = FakeClient(list(turns))
        return holder["fake"]

    monkeypatch.setattr(server, "client", lambda: holder.get("fake") or FakeClient([]))
    with TestClient(server.app) as test_client:
        test_client.script = install
        yield test_client


def start(http) -> str:
    return http.post("/sessions", json={"building_id": BUILDING}).json()["session_id"]


def test_the_store_keeps_reports_and_the_inbox_on_disk(tmp_path):
    path = tmp_path / "reports.json"
    store = Reports(path)
    first = store.add(Report(LIFT, BUILDING, "lift", "Office lift", ["F0", "F1"], "broken", reported_at=10.0))
    again = store.add(Report(LIFT, BUILDING, "lift", "Office lift", ["F0", "F1"], "still broken", reported_at=20.0))
    assert again is first and again.reported_at == 10.0  # reported twice: still the first time
    store.post(Message(BUILDING, "Out of service: Office lift", "..."))
    reopened = Reports(path)
    assert reopened.ids(BUILDING) == {LIFT} and reopened.messages()[0].subject.startswith("Out of service")
    assert reopened.clear(BUILDING, LIFT).element_id == LIFT and Reports(path).ids(BUILDING) == set()
    path.write_text("not json")
    assert Reports(path).ids(BUILDING) == set()  # a damaged file starts over


def test_a_reported_lift_changes_everyones_routes():
    session = Session(server.load(BUILDING))
    walk = session.route("Quality lab 0.21", "Office 1.04")
    assert walk["legs"][0]["steps"]  # the way exists
    session.reported = {LIFT: {"element_id": LIFT, "label": "Office lift"}}
    with pytest.raises(EngineError):  # the only lift is out: no step-free way up
        session.route("Quality lab 0.21", "Office 1.04", step_free=True)
    again = session.route("Quality lab 0.21", "Office 1.04")  # on foot: the stairs
    assert any("staircase" in step for step in again["legs"][0]["steps"])
    assert session.changes()["reported"][0]["element_id"] == LIFT


def test_reports_only_in_the_live_app_never_in_the_benchmark():
    session = Session(server.load(BUILDING))
    with pytest.raises(EngineError):
        session.report_problem("Office lift", "broken")  # no server: nothing to report to
    fake = FakeClient([([], "ok")])
    BuildingAgent(Session(server.load(BUILDING)), fake, mode=BENCHMARK).ask("Where is the kitchen?")
    assert "report_problem" not in tool_names(fake.requests[0])
    fake = FakeClient([([], "ok")])
    BuildingAgent(Session(server.load(BUILDING)), fake, mode=CHAT).ask("hi")
    assert "report_problem" in tool_names(fake.requests[0])


def test_hey_finni_the_lift_is_broken_reaches_everyone_and_maintenance(http):
    fake = http.script(
        ([("report_problem", {"element": "the lift", "problem": "the lift is broken"})],
         "Got it: the Office lift is out of service; maintenance has been told."),
        ([("find_route", {"start": "Quality lab 0.21", "destination": "Office 1.04", "step_free": True})],
         "There's no step-free way up right now."),
        ([("report_problem", {"element": "Office lift", "problem": "works again", "fixed": True})], "Great."),
    )
    first, second = start(http), start(http)  # two colleagues, two conversations
    reply = http.post(f"/sessions/{first}/chat", json={"text": "the lift is broken"}).json()
    assert reply["map"]["changes"]["reported"][0]["label"] == "Office lift (Ground floor ↔ Floor 1)"
    reports = http.get(f"/buildings/{BUILDING}/reports").json()["reports"]
    assert [report["element_id"] for report in reports] == [LIFT]
    inbox = http.get("/maintenance").json()["messages"]
    assert inbox[0]["subject"] == "Out of service: Office lift (Ground floor ↔ Floor 1)"
    assert inbox[0]["delivery"] == "inbox"  # no email set up: on screen
    # the colleague in the other conversation: the lift is avoided there too
    http.post(f"/sessions/{second}/chat", json={"text": "step-free to office 1.04 from the quality lab"})
    assert fake.log[-1][0] == "find_route" and fake.log[-1][2]  # an error: no step-free way with the lift out
    # it works again
    http.post(f"/sessions/{second}/chat", json={"text": "the lift works again"})
    assert http.get(f"/buildings/{BUILDING}/reports").json()["reports"] == []
    assert http.get("/maintenance").json()["messages"][0]["subject"].startswith("Working again")


def test_reports_without_a_conversation_and_the_access_code(http, monkeypatch):
    added = http.post(f"/buildings/{BUILDING}/reports", json={"element": "Office lift", "problem": "doors stuck"})
    assert added.status_code == 200 and added.json()["maintenance"] == "in the maintenance inbox"
    again = http.post(f"/buildings/{BUILDING}/reports", json={"element": "the lift", "problem": "still broken"}).json()
    assert again["maintenance"] == "already with maintenance" and len(http.get("/maintenance").json()["messages"]) == 1
    assert http.post(f"/buildings/{BUILDING}/reports", json={"element": "Room 99.99"}).status_code == 422
    assert http.delete(f"/buildings/{BUILDING}/reports/nope").status_code == 404
    monkeypatch.setenv("FINNI_ACCESS_CODE", "pretzel")
    assert http.get(f"/buildings/{BUILDING}/reports").status_code == 200  # reading stays open
    assert http.delete(f"/buildings/{BUILDING}/reports/{LIFT}").status_code == 401
    assert http.delete(f"/buildings/{BUILDING}/reports/{LIFT}?code=pretzel").status_code == 200
    assert http.get(f"/buildings/{BUILDING}/reports").json()["reports"] == []


def test_safety_quick_buttons_route_to_the_nearest(http):
    session_id = start(http)
    assert http.post(f"/sessions/{session_id}/nearest", json={"kind": "exit"}).status_code == 409  # where are you?
    http.post(f"/sessions/{session_id}/position", json={"space": "Quality lab 0.21"})
    exit_ = http.post(f"/sessions/{session_id}/nearest", json={"kind": "exit"}).json()
    assert exit_["map"]["route"]["pieces"] and exit_["map"]["target"]["label"] == "Exit"
    extinguisher = http.post(f"/sessions/{session_id}/nearest", json={"kind": "fire_extinguisher"}).json()
    assert "extinguisher" in extinguisher["found"]["label"].lower()
    assert extinguisher["map"]["target"]["asset_id"] and extinguisher["map"]["route"]["length_m"] >= 0
    assert http.post(f"/sessions/{session_id}/nearest", json={"kind": "unicorn"}).status_code == 422


def test_reports_stay_in_the_server_unless_a_file_is_asked_for(monkeypatch, tmp_path):
    """A broken lift is known to the running server only: no file is written (nothing in the repository changes)
    and a restart starts clean, unless FINNI_REPORTS_FILE names a file."""
    monkeypatch.delenv("FINNI_REPORTS_FILE", raising=False)
    assert server.reports_file() is None
    assert Reports().path is None
    monkeypatch.setenv("FINNI_REPORTS_FILE", str(tmp_path / "reports.json"))
    assert server.reports_file() == tmp_path / "reports.json"
