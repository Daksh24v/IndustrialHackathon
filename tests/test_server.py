"""The HTTP backend, with a scripted fake Claude (no API calls)."""

import math

import pytest
from fastapi.testclient import TestClient

from server import app as server
from tests.fake_claude import FakeClient

BUILDING = "proc-factory-dev-003"


@pytest.fixture
def http(monkeypatch):
    clients = []

    def install(*turns):
        fake = FakeClient(list(turns))
        clients.append(fake)
        monkeypatch.setattr(server, "client", lambda: fake)
        return fake

    monkeypatch.setattr(server, "client", lambda: FakeClient([]))
    with TestClient(server.app) as test_client:
        test_client.script = install
        yield test_client


def test_buildings_list_and_detail(http):
    ids = {row["id"] for row in http.get("/buildings").json()}
    assert BUILDING in ids and len(ids) == 280
    detail = http.get(f"/buildings/{BUILDING}").json()
    assert detail["floors"][0]["level"] == 0
    space = detail["spaces"][0]
    assert {"polygon", "area_m2", "anchor", "type", "name"} <= set(space)
    assert detail["openings"] and detail["assets"]
    assert http.get("/buildings/nope").status_code == 404


def vertical_cost(kind: str, rise_m: float) -> float:
    """Kit 1.1.0: stairs 2 m per metre climbed; a lift ride 15 m + 1 m per metre climbed."""
    return 2.0 * rise_m if kind == "stairs" else 15.0 + 1.0 * rise_m


def route_length(route_map: dict, detail: dict) -> float:
    """Length of the drawn lines plus the stair and lift costs."""
    elevations = {floor["id"]: floor["elevation_m"] for floor in detail["floors"]}
    total = 0.0
    for piece in route_map["route"]["pieces"]:
        total += sum(math.dist(a, b) for a, b in zip(piece["points"], piece["points"][1:]))
        then = piece["then"]
        if then and then["kind"] in ("stairs", "lift"):
            total += vertical_cost(then["kind"], abs(elevations[then["to_floor_id"]] - elevations[piece["floor_id"]]))
    return total


def test_exact_polyline_length_is_the_route_length():
    """The drawn lines follow the walk itself (door, landing, corners): with the stair and lift costs they add up
    to the route length."""
    from navcore.engine import Building, Constraints
    from tests.conftest import DATA

    building = Building.load(DATA / "dev" / BUILDING)
    for step_free in (False, True):
        route = building.route("proc-factory-dev-003-F0-S021", "proc-factory-dev-003-F1-S004", Constraints(step_free))
        drawn = route_length({"route": {"pieces": building.polyline(route)}},
                             {"floors": list(building.floors.values())})
        assert drawn == pytest.approx(route.length_m, abs=0.02)


def test_map_lines_match_the_route_length(http):
    detail = http.get(f"/buildings/{BUILDING}").json()
    response = http.post(f"/buildings/{BUILDING}/route",
                         json={"start": "Quality lab 0.21 (Ground floor)", "destination": "Office 1.04 (Floor 1)"})
    assert response.status_code == 200
    body = response.json()
    assert route_length(body["map"], detail) == pytest.approx(body["summary"]["length_m"], abs=0.02)
    assert body["map"]["you_are_here"]["label"] == "Quality lab 0.21 (Ground floor)"
    assert body["map"]["focus_floor_id"].endswith("-F0")


def test_route_lines_never_cross_a_wall(http):
    """Every drawn segment stays inside one space, except the short steps through a door."""
    from shapely.geometry import LineString, Polygon

    detail = http.get(f"/buildings/{BUILDING}").json()
    doors = {(opening["floor_id"], tuple(opening["position"])) for opening in detail["openings"]}
    outlines = {}
    for space in detail["spaces"]:
        outlines.setdefault(space["floor_id"], []).append(Polygon(space["polygon"]).buffer(0.02))
    body = http.post(f"/buildings/{BUILDING}/route",
                     json={"start": "Quality lab 0.21 (Ground floor)", "destination": "Office 1.04 (Floor 1)",
                           "step_free": True}).json()
    for piece in body["map"]["route"]["pieces"]:
        for a, b in zip(piece["points"], piece["points"][1:]):
            if (piece["floor_id"], tuple(a)) in doors or (piece["floor_id"], tuple(b)) in doors:
                assert math.dist(a, b) <= 0.31  # a door to its landing, 30 cm inside the space
                continue
            segment = LineString([a, b])
            assert any(outline.covers(segment) for outline in outlines[piece["floor_id"]]), (a, b)


def test_route_errors_are_422(http):
    response = http.post(f"/buildings/{BUILDING}/route", json={"start": "Nowhere 9.99", "destination": "0.21"})
    assert response.status_code == 422 and "No space" in response.json()["detail"]


def test_chat_turn_with_question_then_map(http):
    http.script(
        ([("ask_user", {"question": "Which floor are you on?",
                        "options": [{"label": "Ground floor"}, {"label": "Floor 1"}]})], ""),
        ([("find_route", {"start": "Quality lab 0.21 (Ground floor)", "destination": "Office 1.04 (Floor 1)"}),
          ("show_on_map", {"you_are_here": "Quality lab 0.21 (Ground floor)", "target": "Office 1.04 (Floor 1)",
                           "show_last_route": True})],
         "Office 1.04 is upstairs, about 140 m."),
    )
    session = http.post("/sessions", json={"building_id": BUILDING}).json()
    first = http.post(f"/sessions/{session['session_id']}/chat", json={"text": "Where is office 1.04?"}).json()
    assert first["question"]["options"][1]["label"] == "Floor 1" and first["map"] is None
    second = http.post(f"/sessions/{session['session_id']}/chat", json={"text": "Ground floor"}).json()
    assert second["question"] is None
    assert second["reply"].startswith("Office 1.04")
    assert second["map"]["route"]["pieces"][0]["then"]["kind"] in ("stairs", "lift")
    assert second["map"]["target"]["label"] == "Office 1.04 (Floor 1)"


def test_sessions_are_separate_and_can_end(http):
    http.script(([("set_closed", {"element": "Office lift", "closed": True})], "Closed."), ([], "Hi."))
    first = http.post("/sessions", json={"building_id": BUILDING}).json()["session_id"]
    second = http.post("/sessions", json={"building_id": BUILDING}).json()["session_id"]
    http.post(f"/sessions/{first}/chat", json={"text": "close the office lift"})
    http.post(f"/sessions/{second}/chat", json={"text": "hi"})
    assert server._sessions[first].session.closed and not server._sessions[second].session.closed
    assert http.delete(f"/sessions/{first}").json() == {"ended": True}
    assert http.post(f"/sessions/{first}/chat", json={"text": "hi"}).status_code == 404
    assert http.post("/sessions", json={"building_id": "nope"}).status_code == 404
    assert http.post(f"/sessions/{second}/chat", json={"text": ""}).status_code == 422


def test_outline_has_one_footprint_set_per_floor(http):
    from shapely.geometry import Polygon
    from shapely.ops import unary_union

    from navcore.engine import Building
    from tests.conftest import DATA

    body = http.get(f"/buildings/{BUILDING}/outline").json()
    truth = Building.load(DATA / "dev" / BUILDING)
    assert [floor["level"] for floor in body["floors"]] == sorted(f["level"] for f in truth.floors.values())
    for floor in body["floors"]:
        area = sum(Polygon(points).area for points in floor["footprints"])
        union = unary_union([truth.polygons[s["id"]] for s in truth.spaces_on(floor["id"])]).area
        assert area == pytest.approx(union, rel=0.02)
        assert floor["height_m"] > 0
    assert http.get("/buildings/nope/outline").status_code == 404


def test_position_from_the_phone_is_used_without_asking(http):
    fake = http.script(([("show_on_map", {"target": "Office 1.04 (Floor 1)"})], "It's upstairs."))
    session = http.post("/sessions", json={"building_id": BUILDING}).json()["session_id"]
    placed = http.post(f"/sessions/{session}/position", json={"space": "Quality lab 0.21 (Ground floor)"}).json()
    assert placed["label"] == "Quality lab 0.21 (Ground floor)"
    body = http.post(f"/sessions/{session}/chat", json={"text": "Where is office 1.04?"}).json()
    sent = fake.requests[0]["messages"][-1]["content"]
    assert sent.startswith("[Position from the phone: the person is in Quality lab 0.21 (Ground floor)]")
    assert sent.endswith("Where is office 1.04?")
    assert body["map"]["you_are_here"]["label"] == "Quality lab 0.21 (Ground floor)"  # the map shows it too
    assert http.post(f"/sessions/{session}/position", json={"space": "Nowhere 9.99"}).status_code == 422
    assert http.post("/sessions/nope/position", json={"space": "0.21"}).status_code == 404


def test_voice_is_served_by_the_backend(http):
    """One server for the app: /voice lives here, and voice reaches the agent in-process."""
    from voice import app as voice_service

    assert http.get("/voice").status_code == 200
    assert "/voice/transcribe" in http.get("/openapi.json").json()["paths"]
    buildings = voice_service.call_backend("GET", "/buildings")
    assert any(row["id"] == BUILDING for row in buildings)
