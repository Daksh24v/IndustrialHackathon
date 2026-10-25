"""Level 4 plan import, on hand-written plans in the dataset's drawing style and on real build buildings."""

import pytest
from shapely.geometry import Polygon

from evals.plans import compare, told_heights
from navcore.engine import Building
from navcore.plans import (
    PlanError,
    assemble,
    describe,
    import_plans,
    measured_scale,
    read_svg,
    scale,
)
from tests.conftest import DATA

PPM = 10.0  # points per metre in the hand-written plans
MARGIN = 2.0 * PPM


def svg(rooms, markers=(), labels=(), title="Test Hall — Ground floor", width_m=20.0, height_m=10.0) -> str:
    """A plan like the dataset's renderer draws it: plot area with a 2 m margin, rooms outlined in #333333,
    markers as <use>, labels as a comment + glyph group. Coordinates in metres, y up, origin bottom-left."""

    def pt(x, y):
        return MARGIN + 7.2 + x * PPM, 20.8 + MARGIN + (height_m - y) * PPM

    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
             f'<defs><clipPath id="c1"><rect x="7.2" y="20.8" width="{width_m * PPM + 2 * MARGIN}" '
             f'height="{height_m * PPM + 2 * MARGIN}"/></clipPath></defs>']
    for points, colour in rooms:
        d = " ".join(("M" if i == 0 else "L") + " %.4f %.4f" % pt(x, y) for i, (x, y) in enumerate(points)) + " z"
        parts.append(f'<path d="{d}" style="fill: {colour}; stroke: #333333; stroke-width: 0.6"/>')
    for (x, y), colour in markers:
        px, py = pt(x, y)
        parts.append(f'<use xlink:href="#m1" x="{px:.4f}" y="{py:.4f}" style="fill: {colour}; stroke: {colour}"/>')
    for text, (x, y) in [*labels, (title, (width_m / 2, height_m + 1.5))]:
        px, py = pt(x, y)
        # anchor = start of the text; the importer works back to its centre (one glyph ~ 3.8 pt wide)
        parts.append(f'<!-- {text} -->\n<g transform="translate({px - 1.9:.4f} {py + 2.19:.4f}) scale(0.06 -0.06)">'
                     f'<use xlink:href="#g"/></g>')
    parts.append("</svg>")
    return "\n".join(parts)


ROOM, CORRIDOR, STAIR, LIFT = "#f3efe6", "#dcdcdc", "#f4b183", "#b4a7d6"
DOOR, OPENING, ENTRANCE = "#8b4513", "#9e9e9e", "#d32f2f"


def ground_plan(tmp_path):
    rooms = [
        ([(0, 0), (8, 0), (8, 6), (0, 6)], ROOM),          # office A, 48 m²
        ([(8, 0), (14, 0), (14, 6), (8, 6)], ROOM),        # office B, 36 m²
        ([(0, 6), (16, 6), (16, 10), (0, 10)], CORRIDOR),  # corridor along the top
        ([(14, 0), (16, 0), (16, 3), (14, 3)], STAIR),     # stair shaft
        ([(14, 3), (16, 3), (16, 6), (14, 6)], LIFT),      # lift shaft
    ]
    markers = [((4, 6), DOOR), ((11, 6), DOOR), ((15, 6), OPENING), ((0, 8), ENTRANCE)]
    labels = [("0.01", (4, 3)), ("0.02", (11, 3)), ("0.00", (8, 8))]
    path = tmp_path / "floor_0.svg"
    path.write_text(svg(rooms, markers, labels, width_m=16), encoding="utf-8")
    return path


def test_scale_is_measured_from_the_margin(tmp_path):
    plan = read_svg(ground_plan(tmp_path))
    assert plan.points_per_metre == pytest.approx(PPM)
    assert measured_scale("<svg/>", [(0, 0)]) is None


def test_rooms_kinds_labels_and_title(tmp_path):
    plan = read_svg(ground_plan(tmp_path))
    assert plan.building_name == "Test Hall" and plan.floor_name == "Ground floor"
    kinds = sorted(space["type"] for space in plan.spaces)
    assert kinds == ["corridor", "lift", "room", "room", "stair"]
    areas = sorted(round(Polygon(space["polygon"]).area, 3) for space in plan.spaces)
    assert areas == [6.0, 6.0, 36.0, 48.0, 64.0]
    labelled = {space["label"]: round(Polygon(space["polygon"]).area) for space in plan.spaces if space["label"]}
    assert labelled == {"0.01": 48, "0.02": 36, "0.00": 64}
    assert sorted(marker["kind"] for marker in plan.markers) == ["door", "door", "entrance", "opening"]


def test_assemble_doors_entrances_and_notes(tmp_path):
    building, notes = import_plans([ground_plan(tmp_path)], building_id="t")
    spaces = {space["id"]: space for space in building["spaces"]}
    pairs = sorted(sorted("outside" if s == "outside" else spaces[s]["ref"] for s in o["space_ids"])
                   for o in building["openings"])
    assert ["0.00", "0.01"] in pairs and ["0.00", "0.02"] in pairs and ["0.00", "outside"] in pairs
    assert building["building"]["name"] == "Test Hall"
    assert any("Room types are not in the plans" in note for note in notes)
    assert any("Door widths" in note for note in notes)
    loaded = Building(building)  # a normal building: routing works on it
    office_a = next(s for s in building["spaces"] if s["ref"] == "0.01")["id"]
    assert loaded.distances_to_exit()[office_a] > 0


def upper_plan(tmp_path, shift=(3.0, -2.0), with_shafts=True):
    """Floor 1: the same shafts, drawn from its own corner (the renderer starts every floor at its own
    bounding box), so the importer has to move it back by `shift`."""
    dx, dy = shift
    rooms = [([(0 + dx, 6 + dy), (16 + dx, 6 + dy), (16 + dx, 10 + dy), (0 + dx, 10 + dy)], CORRIDOR),
             ([(0 + dx, 0 + dy), (14 + dx, 0 + dy), (14 + dx, 6 + dy), (0 + dx, 6 + dy)], ROOM)]
    if with_shafts:
        rooms += [([(14 + dx, 0 + dy), (16 + dx, 0 + dy), (16 + dx, 3 + dy), (14 + dx, 3 + dy)], STAIR),
                  ([(14 + dx, 3 + dy), (16 + dx, 3 + dy), (16 + dx, 6 + dy), (14 + dx, 6 + dy)], LIFT)]
    # the renderer draws from the floor's own bounding-box corner: normalise to start at (0, 0)
    min_x = min(x for points, _ in rooms for x, _ in points)
    min_y = min(y for points, _ in rooms for _, y in points)
    rooms = [([(x - min_x, y - min_y) for x, y in points], colour) for points, colour in rooms]
    path = tmp_path / "floor_1.svg"
    markers = [((7 - min_x + dx, 6 - min_y + dy), DOOR)]
    if with_shafts:
        markers.append(((15 - min_x + dx, 6 - min_y + dy), OPENING))  # corridor <-> lift
    path.write_text(svg(rooms, markers, [("1.01", (7 - min_x + dx, 3 - min_y + dy))],
                        title="Test Hall — Floor 1", width_m=16), encoding="utf-8")
    return path


def test_floors_are_lined_up_by_their_shafts_and_linked(tmp_path):
    building, notes = import_plans([ground_plan(tmp_path), upper_plan(tmp_path)], building_id="t")
    by_floor = {}
    for space in building["spaces"]:
        if space["type"] in ("stair", "lift"):
            by_floor.setdefault(space["type"], []).append(Polygon(space["polygon"]))
    for shapes in by_floor.values():
        assert shapes[0].symmetric_difference(shapes[1]).area < 1e-6  # stacked exactly
    kinds = sorted((c["kind"], c["step_free"]) for c in building["vertical_connectors"])
    assert kinds == [("lift", True), ("stairs", False)]
    assert not any("line up" in note for note in notes)
    floors = sorted(building["floors"], key=lambda f: f["level"])
    assert [f["elevation_m"] for f in floors] == [0.0, 3.5]
    loaded = Building(building)
    office = next(s["id"] for s in building["spaces"] if s["ref"] == "1.01")
    assert office in loaded.distances_from(next(s["id"] for s in building["spaces"] if s["ref"] == "0.01"))


def test_floor_without_shafts_is_centred_and_noted(tmp_path):
    building, notes = import_plans([ground_plan(tmp_path), upper_plan(tmp_path, with_shafts=False)], building_id="t")
    assert building["vertical_connectors"] == []


def test_heights_and_scale_corrections(tmp_path):
    building, notes = import_plans([ground_plan(tmp_path), upper_plan(tmp_path)], building_id="t",
                                   floor_heights_m={0: 8.0, 1: 4.0})
    assert sorted(f["elevation_m"] for f in building["floors"]) == [0.0, 8.0]
    assert not any("Floor heights" in note for note in notes)
    before = Polygon(building["spaces"][0]["polygon"]).area
    scale(building, 2.0)
    assert Polygon(building["spaces"][0]["polygon"]).area == pytest.approx(4 * before)
    with pytest.raises(PlanError):
        scale(building, 0)
    summary = describe(building)
    assert summary["name"] == "Test Hall" and summary["floors"][0]["entrances"] == 1


def test_not_a_plan(tmp_path):
    path = tmp_path / "floor_0.svg"
    path.write_text("<svg xmlns='http://www.w3.org/2000/svg'></svg>", encoding="utf-8")
    with pytest.raises(PlanError):
        read_svg(path)
    path.write_text("not xml", encoding="utf-8")
    with pytest.raises(PlanError):
        read_svg(path)


def test_two_plans_for_one_level_is_an_error(tmp_path):
    plan = read_svg(ground_plan(tmp_path))
    with pytest.raises(PlanError):
        assemble([(0, plan), (0, plan)])


@pytest.mark.parametrize("building_id", ["proc-factory-dev-003", "proc-campus-dev-000"])
def test_real_procedural_buildings_rebuild_exactly(building_id):
    path = DATA / "dev" / building_id
    truth = Building.load(path)
    imported, _ = import_plans(sorted(path.glob("floor_*.svg"), key=lambda p: int(p.stem.split("_")[1])),
                               building_id="imp", floor_heights_m=told_heights(truth))
    scores = compare(truth, imported)
    assert scores["spaces_matched"] == scores["spaces"]
    assert scores["doors_found"] == scores["doors"]
    assert scores["connectors_found"] == scores["connectors"]
    assert scores["floors_aligned"] == scores["floors_to_align"]
    assert scores["routes_right"] == scores["routes"] and scores["walls_right"] == scores["walls"]


def test_stair_halls_join_floors_when_no_shafts_are_drawn(tmp_path):
    # Swiss Dwellings style: no stair shafts, the stair hall is a corridor that repeats on every floor and opens
    # onto the flats; a flat's hallway (many doors into its rooms) repeats too but isn't stairs.
    def floor(level, entrance):
        rooms = [([(0, 0), (4, 0), (4, 4), (0, 4)], CORRIDOR),    # stair hall
                 ([(4, 0), (12, 0), (12, 2), (4, 2)], CORRIDOR),   # the flat's hallway
                 *[([(x, 2), (x + 2, 2), (x + 2, 6), (x, 6)], ROOM) for x in (4, 6, 8, 10)]]
        markers = [((4, 1), DOOR), *[((x + 1, 2), DOOR) for x in (4, 6, 8, 10)]]
        if entrance:
            markers.append(((0, 2), ENTRANCE))
        labels = [(f"{level}.01", (2, 2)), (f"{level}.02", (8, 1))]
        path = tmp_path / f"floor_{level}.svg"
        path.write_text(svg(rooms, markers, labels, width_m=12, height_m=6), encoding="utf-8")
        return path

    building, notes = import_plans([floor(0, True), floor(1, False), floor(2, False)], building_id="hall")
    (stairs,) = building["vertical_connectors"]
    names = {space["id"]: space["name"] for space in building["spaces"]}
    assert stairs["kind"] == "stairs" and not stairs["step_free"]
    assert [names[space_id] for space_id in stairs["space_ids"]] == ["Stair hall 0.01", "Stair hall 1.01",
                                                                    "Stair hall 2.01"]
    assert any("stair landings were recognised" in note for note in notes)
    by_ref = {space["ref"]: space["id"] for space in building["spaces"]}
    assert Building(building).route(by_ref["0.02"], by_ref["2.02"]).length_m > 0  # hallway to hallway, upstairs


@pytest.mark.parametrize("building_id", ["swiss-1883", "swiss-5462"])
def test_real_swiss_buildings_rebuild_with_their_stair_halls(building_id):
    (path,) = [DATA / split / building_id for split in ("train", "dev") if (DATA / split / building_id).is_dir()]
    truth = Building.load(path)
    imported, _ = import_plans(sorted(path.glob("floor_*.svg"), key=lambda p: int(p.stem.split("_")[1])),
                               building_id="imp", floor_heights_m=told_heights(truth))
    scores = compare(truth, imported)
    assert scores["connectors_found"] == scores["connectors"] > 0
    assert scores["routes_right"] == scores["routes"]
