"""Where things are and where the person is: forgiving names (but never a silent guess), the position with
its history and route progress, and landmarks to ask with. Real buildings from the dataset, no API."""

from pathlib import Path

import pytest

from navagent.agent import position_note
from navagent.tools import Session
from navcore.engine import Building, Constraints, EngineError
from navcore.resolve import AmbiguousSpace, NoSuchSpace, find_element, find_floor, find_space, find_type

DATA = Path(__file__).resolve().parent.parent / "data"
FACTORY = DATA / "dev" / "proc-factory-dev-003"
OSM = DATA / "train" / "osm-way37850565"  # Haus der Weiterbildung: twelve rooms called "Büro"
SWISS = DATA / "train" / "swiss-685"
LAB = "proc-factory-dev-003-F0-S021"  # Quality lab 0.21


@pytest.fixture(scope="module")
def factory() -> Building:
    return Building.load(FACTORY)


@pytest.mark.parametrize("words", ["Quality lab 0.21", "Quality lab", "the quality lab", "room 0.21",
                                   "QUALITY LAB", "quality lab (ground floor)", "Quality lab (EG)"])
def test_names_people_use_find_the_room(factory, words):
    assert find_space(factory, words) == LAB


def test_a_typo_is_suggested_never_taken(factory):
    with pytest.raises(NoSuchSpace) as error:
        find_space(factory, "Qualty lab 0.21")
    assert error.value.suggestions[0] == LAB and "Did you mean" in str(error.value)


def test_a_wrong_room_says_so(factory):
    with pytest.raises(NoSuchSpace) as error:
        find_space(factory, "room 9.99")
    assert error.value.suggestions == []


def test_shared_names_stay_ambiguous_even_when_spelled_differently():
    osm = Building.load(OSM)
    for words in ("Büro", "Buero", "the büro"):
        with pytest.raises(AmbiguousSpace):
            find_space(osm, words)
    one = next(space for space in osm.spaces.values() if space["name"] == "Büro" and space.get("ref"))
    assert find_space(osm, f"Büro {one['ref']}") == one["id"]  # the name plus its number
    assert find_space(osm, f"Büro ({one['ref']})") == one["id"]  # as the answer line writes it


def test_swiss_names_without_the_apartment():
    swiss = Building.load(SWISS)
    kitchen = next(space for space in swiss.spaces.values() if space["name"].startswith("Kitchen 0."))
    short = kitchen["name"].split(" (")[0]
    assert find_space(swiss, short) == kitchen["id"]
    assert find_space(swiss, f"{short} (Ground floor)") == kitchen["id"]


@pytest.mark.parametrize("words, level", [("first floor", 1), ("1st floor", 1), ("OG 1", 1), ("EG", 0),
                                          ("1", 1), ("top floor", 1), ("bottom floor", 0), ("Floor 1", 1)])
def test_floor_words(factory, words, level):
    assert factory.floors[find_floor(factory, words)]["level"] == level


def test_type_words(factory):
    known = {asset["type"] for asset in factory.assets.values()}
    assert find_type("extinguisher", known) == "fire_extinguisher"
    assert find_type("WC", known | {"toilet"}) == "toilet"
    assert find_type("cnc mills", known) == "cnc_mill"
    with pytest.raises(EngineError, match="several types"):
        find_type("coffee", known | {"coffee_table"})
    assert find_element(factory, "the lift") == "proc-factory-dev-003-V02"
    assert find_element(factory, "elevator") == "proc-factory-dev-003-V02"


def test_the_route_starts_where_the_person_is_and_tracks_progress(factory):
    session = Session(factory)
    with pytest.raises(EngineError, match="Where is the person"):
        session.route(None, "Office 1.04 (Floor 1)")
    session.set_position("Quality lab 0.21 (Ground floor)", source="phone")
    route = session.route(None, "Office 1.04 (Floor 1)")
    assert route["from"] == "Quality lab 0.21 (Ground floor)"
    spaces = session.active_route["spaces"]
    middle = factory.label(spaces[len(spaces) // 2])
    step = session.set_position(spaces[len(spaces) // 2], source="told")
    assert step["on_route"] and step["next"] == factory.label(spaces[len(spaces) // 2 + 1])
    note = position_note(session)
    assert note.startswith(f"[Position: the person is in {middle}") and "Before: Quality lab 0.21" in note
    assert "Following your route to Office 1.04 (Floor 1)" in note
    arrived = session.set_position("Office 1.04 (Floor 1)", source="told")
    assert arrived["arrived"]
    off = session.set_position("Kitchen 0.28 (Ground floor)", source="told")
    assert off["on_route"] is False and "new route" in off["note"]


def test_a_thing_or_an_entrance_is_a_position(factory):
    session = Session(factory)
    machine = next(asset for asset in factory.assets.values() if asset["type"] == "cnc_mill")
    placed = session.set_position(machine["name"])
    assert placed["space_id"] == machine["space_id"] and placed["point"] == tuple(machine["position"])
    entrance = next(opening for opening in factory.openings.values() if "outside" in opening["space_ids"])
    assert session.set_position(entrance["id"])["point"] == tuple(entrance["position"])


def test_landmarks_come_from_the_building_and_nearest_first(factory):
    session = Session(factory)
    both = session.where_am_i_options()["landmarks"]  # two floors: one question finds floor and place
    assert {landmark["floor"] for landmark in both} == {"Ground floor", "Floor 1"}
    tall = Session(Building.load(DATA / "dev" / "osm-way22744230"))  # eight floors: the floor first
    assert tall.where_am_i_options()["ask_first"] == "Which floor are you on?"
    options = session.where_am_i_options("Ground floor")
    kinds = {landmark["kind"] for landmark in options["landmarks"]}
    assert options["landmarks"] and kinds <= {"thing", "stairs", "lift", "entrance", "room"}
    session.set_position("Quality lab 0.21 (Ground floor)")
    near = session.where_am_i_options()["landmarks"]
    walks = [landmark["walk_m"] for landmark in near if landmark["walk_m"] is not None]
    assert walks == sorted(walks) and near[0]["walk_m"] is not None


def test_nearest_thing_respects_closures_and_shows_on_the_map(factory):
    session = Session(factory)
    session.set_position("Quality lab 0.21 (Ground floor)")
    first = session.find_assets("coffee machine")["assets"][0]
    session.show_on_map(target="coffee machine")
    assert session.map_view["target"]["asset_id"] == first["id"]
    assert session.map_view["you_are_here"]["space_id"] == LAB
    session.closed.add(first["space_id"])  # its room is closed: the next one is nearest now
    closed = session.find_assets("coffee machine")["assets"]
    assert closed[0]["id"] != first["id"] or "walk_m" not in closed[0]


def test_benchmark_answers_do_not_change(factory):
    """Exact names resolve exactly as before; the forgiving steps never run for them."""
    for space in factory.spaces.values():
        assert find_space(factory, factory.label(space["id"])) == space["id"]
    assert factory.distances_from(LAB, Constraints())


def test_directions_say_which_way_to_turn(factory):
    """The corridor runs north-south with the lab and the kitchen on its west side: out of the lab (walking
    east) the kitchen is to the left (north), and from the corridor (walking north) its door is on the left."""
    session = Session(factory)
    steps = [step for leg in session.route("Quality lab 0.21 (Ground floor)", "Kitchen 0.28 (Ground floor)")["legs"]
             for step in leg["steps"]]
    assert "turn left through the door into Office corridor 0.16" in steps[0]
    assert "turn left through the door into Kitchen 0.28" in steps[1] and "(by the Coffee machine" in steps[1]
    steps = session.route("Meeting room 0.24 (Ground floor)", "Locker room 0.39 (Ground floor)")["legs"][0]["steps"]
    assert "turn left" in steps[0] and "turn right through the door into Locker room 0.39" in steps[1]


def test_turn_words():
    from navagent.tools import turn_word

    east, north, south, west = (1, 0), (0, 1), (0, -1), (-1, 0)
    assert turn_word(east, north) == "turn left" and turn_word(east, south) == "turn right"
    assert turn_word(east, east) == "go straight" and turn_word(east, west) == "turn around and go"
    assert turn_word(None, east) == "go"


def test_a_facility_manager_moves_a_machine_and_closes_a_lift(factory):
    session = Session(Building.load(FACTORY))  # its own copy: the move must not leak into other tests
    machine = next(asset for asset in session.building.assets.values() if asset["type"] == "coordinate_measuring_machine")
    moved = session.move_thing("coordinate measuring machine", "Office 1.04 (Floor 1)")
    assert moved["to"] == "Office 1.04 (Floor 1)" and machine["space_id"] == "proc-factory-dev-003-F1-S004"
    assert session.map_view["changes"]["moved"][0]["asset_id"] == machine["id"]
    session.set_closed("the lift", True)
    session.set_position("Quality lab 0.21 (Ground floor)")
    nearest = session.nearest_with_asset(None, "coordinate measuring machine")
    assert nearest["nearest_room"] == "Office 1.04 (Floor 1)"  # found at its new place
    changes = session.map_view["changes"]
    assert changes["closed"] == ["proc-factory-dev-003-V02"] and changes["moved"]
    with pytest.raises(EngineError, match="Which one"):
        session.move_thing("coffee machine", "Office 1.04 (Floor 1)")  # several: it asks which


def test_a_failed_route_request_drops_the_old_route():
    session = Session(Building.load(FACTORY))
    session.set_position("Quality lab 0.21 (Ground floor)")
    session.route(None, "Office 1.04 (Floor 1)")
    session.set_closed("the lift", True)
    with pytest.raises(EngineError):
        session.route(None, "Office 1.04 (Floor 1)", step_free=True)
    assert session.active_route is None
