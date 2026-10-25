"""Level 4: build a building.json from floor plan drawings.

Input: one plan per floor, as SVG in the dataset's plan style (rooms as outlined filled shapes, doors and
entrances as markers, labels as text). What a plan tells us, and what it can't:
- exact room outlines, the kind of space (room, corridor, hall, stairs, lift, outdoor) from the fill colour,
  room numbers from the labels, door and entrance positions, the floor's title;
- NOT the room type (office, kitchen ... share one colour), door widths, floor heights, or how the floors
  line up. Those come from defaults the person confirms or corrects in conversation (navagent tools).

Floors are drawn each from its own corner, so they are lined up by matching their stair and lift shafts.
"""

import itertools
import math
import re
import xml.etree.ElementTree as ElementTree
from dataclasses import dataclass, field
from pathlib import Path

from shapely.affinity import translate
from shapely.geometry import MultiLineString, Point, Polygon

SVG_POINTS_PER_METRE = 9.9792  # the plan renderer's usual scale; used only when the margin can't be measured
PLAN_MARGIN_M = 2.0  # the renderer draws the building with a 2 m margin inside the plot area
GLYPH_SCALE = 0.06  # label glyphs are drawn at scale(0.06 -0.06)
GLYPH_ADVANCE = 63.6  # typical glyph width in glyph units (DejaVu digits), for the last character
GLYPH_HALF_HEIGHT = 36.5  # half the digit height in glyph units
OUTLINE_COLOUR = "#333333"
SPACE_COLOURS = {  # fill colour -> (space type, room type default)
    "#f3efe6": ("room", "generic_room"),
    "#dcdcdc": ("corridor", "corridor"),
    "#fff2b3": ("hall", "lobby"),
    "#f4b183": ("stair", "stairwell"),
    "#b4a7d6": ("lift", "lift"),
    "#cfe8c4": ("outdoor", "balcony"),
}
MARKERS = {"#8b4513": "door", "#9e9e9e": "opening", "#d32f2f": "entrance"}
DEFAULT_DOOR_WIDTH_M = 0.9
# Door widths in the dataset's generated buildings, by the room a door leads into (kit README, "Door widths";
# its "halls" are also lecture halls, canteens, makerspaces and quality labs). On the build buildings this gives
# every procedural door its width; OSM, Swiss and ResPlan doors don't follow it, so it's used only when the
# room types are ones only generated buildings have.
PROCEDURAL_DOOR_WIDTHS_M = {
    "office": 0.9, "lift": 1.1,
    "lab": 1.2, "seminar_room": 1.2, "meeting_room": 1.2, "library": 1.2, "toilet": 1.2, "stairwell": 1.2,
    "lobby": 1.6, "storage": 1.6, "server_room": 1.6, "technical_room": 1.6,
    "lecture_hall": 1.6, "canteen": 1.6, "makerspace": 1.6, "quality_lab": 1.6,
}
PROCEDURAL_ROOM_TYPES = frozenset({
    "lab", "seminar_room", "server_room", "makerspace", "quality_lab", "locker_room", "production_zone",
    "additive_zone", "assembly_zone", "warehouse_zone", "logistics_zone",
})
DEFAULT_FLOOR_HEIGHT_M = 3.5
DOOR_REACH_M = 3.0  # a door marker joins the two nearest spaces within this distance
TYPE_WORDS = {"generic_room": "Room", "corridor": "Corridor", "lobby": "Hall", "stairwell": "Stairwell",
              "lift": "Lift", "balcony": "Balcony"}

PATH_POINT = re.compile(r"(-?[\d.]+)[ ,](-?[\d.]+)")
TRANSLATE = re.compile(r"translate\((-?[\d.]+)[ ,](-?[\d.]+)\)")
FILL = re.compile(r"fill:\s*(#[0-9a-fA-F]{6})")
STROKE = re.compile(r"stroke:\s*(#[0-9a-fA-F]{6})")
LEVEL_FROM_NAME = re.compile(r"floor_(-?\d+)")
CLIP_RECT = re.compile(r'<clipPath id="[^"]+">\s*<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"')
LABEL_GROUP = re.compile(r'<!-- (.*?) -->\s*<g [^>]*?transform="translate\((-?[\d.]+) (-?[\d.]+)\) '
                         r'scale\(([\d.]+) -?[\d.]+\)">(.*?)</g>', re.S)
GLYPH_OFFSET = re.compile(r'<use xlink:href="#[^"]+"(?: transform="translate\((-?[\d.]+) (-?[\d.]+)\)")?')


class PlanError(ValueError):
    """A plan that can't be read; the message says why."""


class AmbiguousAlignment(Exception):
    """Several places fit a floor onto the one next to it equally well (e.g. one stair, many shafts below)."""

    def __init__(self, best: tuple[float, float], choices: int) -> None:
        super().__init__(f"{choices} equally good ways to line the floor up")
        self.best = best
        self.choices = choices


@dataclass
class FloorPlan:
    """One floor as read from its drawing, in metres in the drawing's own frame (x right, y up)."""

    title: str | None
    points_per_metre: float = 9.9792
    spaces: list[dict] = field(default_factory=list)  # {polygon, type, room_type, label}
    markers: list[dict] = field(default_factory=list)  # {kind, position}

    @property
    def building_name(self) -> str | None:
        return self.title.split(" — ")[0].strip() if self.title and " — " in self.title else self.title

    @property
    def floor_name(self) -> str | None:
        return self.title.split(" — ")[-1].strip() if self.title and " — " in self.title else None


def measured_scale(text: str, outline_points: list[tuple[float, float]]) -> float | None:
    """Points per metre from the drawing itself: the rooms sit PLAN_MARGIN_M inside the plot area on every
    side. None if there's no plot area or the four sides disagree (not this renderer's style)."""
    clip = CLIP_RECT.search(text)
    if not clip or not outline_points:
        return None
    x, y, width, height = (float(v) for v in clip.groups())
    xs = [p[0] for p in outline_points]
    ys = [p[1] for p in outline_points]
    estimates = [side / PLAN_MARGIN_M for side in
                 (min(xs) - x, x + width - max(xs), min(ys) - y, y + height - max(ys))]
    if min(estimates) <= 0 or max(estimates) - min(estimates) > 0.01 * max(estimates):
        return None
    return sum(estimates) / len(estimates)


def read_svg(path: Path | str, points_per_metre: float | None = None) -> FloorPlan:
    """Read one floor drawing from a file; see parse_svg."""
    return parse_svg(Path(path).read_text(encoding="utf-8"), str(path), points_per_metre)


def parse_svg(text: str, path: str = "plan", points_per_metre: float | None = None) -> FloorPlan:
    """Read one floor drawing. Coordinates: metres, y up, origin at the drawing's top-left corner.
    The scale is measured from the drawing (measured_scale) unless points_per_metre is given."""
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError as error:
        raise PlanError(f"{path} is not a readable SVG: {error}") from error
    if points_per_metre is None:
        outline = [(float(x), float(y)) for element in root.iter()
                   if element.tag.endswith("path") and OUTLINE_COLOUR in element.get("style", "")
                   for x, y in PATH_POINT.findall(element.get("d", ""))]
        points_per_metre = measured_scale(text, outline) or SVG_POINTS_PER_METRE

    def metres(x: float, y: float) -> tuple[float, float]:
        return (x / points_per_metre, -y / points_per_metre)

    plan = FloorPlan(title=None, points_per_metre=points_per_metre)
    for element in root.iter():
        tag = element.tag.rsplit("}", 1)[-1]
        style = element.get("style", "")
        if tag == "path" and STROKE.search(style) and STROKE.search(style).group(1).lower() == OUTLINE_COLOUR:
            fill = FILL.search(style)
            colour = fill.group(1).lower() if fill else ""
            if colour not in SPACE_COLOURS or "opacity" in style:
                continue
            points = [metres(float(x), float(y)) for x, y in PATH_POINT.findall(element.get("d", ""))]
            polygon = Polygon(points)
            if not polygon.is_valid:
                polygon = polygon.buffer(0)
            if polygon.area <= 0:
                continue
            kind, room_type = SPACE_COLOURS[colour]
            outline = [[round(x, 4), round(y, 4)] for x, y in (points[:-1] if points[0] == points[-1] else points)]
            plan.spaces.append({"polygon": outline, "type": kind, "room_type": room_type, "label": None})
        elif tag == "use" and element.get("x") is not None:
            fill = FILL.search(style)
            kind = MARKERS.get(fill.group(1).lower()) if fill else None
            if kind:
                plan.markers.append({"kind": kind, "position": list(metres(float(element.get("x")),
                                                                            float(element.get("y"))))})
    # Labels are text drawn as glyphs; the renderer keeps the text in a comment before each label group.
    # The group's anchor is where the text starts (on its baseline), so find the text's centre first.
    shapes = [Polygon(space["polygon"]).buffer(0) for space in plan.spaces]
    for label, x, y, glyph_scale, body in LABEL_GROUP.findall(text):
        label = label.strip()
        offsets = [float(dx) for dx, _ in GLYPH_OFFSET.findall(body) if dx] or [0.0]
        size = float(glyph_scale) or GLYPH_SCALE
        centre = Point(metres(float(x) + size * (max(offsets) + GLYPH_ADVANCE) / 2,
                              float(y) - size * GLYPH_HALF_HEIGHT))
        inside = [index for index, shape in enumerate(shapes) if shape.contains(centre)]
        if not inside:
            inside = [index for index, shape in enumerate(shapes) if shape.distance(centre) < 0.5]
            if not inside:
                if plan.title is None:
                    plan.title = label  # the label outside every room is the title
                continue
        index = min(inside, key=lambda i: (shapes[i].area, shapes[i].centroid.distance(centre)))
        if plan.spaces[index]["label"] is None:
            plan.spaces[index]["label"] = label
    if not plan.spaces:
        raise PlanError(f"No rooms found in {path}: is it a floor plan in the expected style?")
    return plan


def level_from_filename(path: Path | str) -> int | None:
    match = LEVEL_FROM_NAME.search(Path(path).stem)
    return int(match.group(1)) if match else None


def shafts(plan: FloorPlan, offset: tuple[float, float] = (0.0, 0.0)) -> list[tuple[str, Polygon]]:
    dx, dy = offset
    return [(space["type"], Polygon([(x + dx, y + dy) for x, y in space["polygon"]]))
            for space in plan.spaces if space["type"] in ("stair", "lift")]


WALL_MATCH_M = 0.08  # walls of two floors count as stacked when they run this close
MIN_STACKED_SHARE = 0.25  # below this share of stacked wall length, the floors are said not to line up


def walls(plan: FloorPlan) -> MultiLineString:
    return MultiLineString([Polygon(space["polygon"]).exterior.coords for space in plan.spaces])


def stacked_share(lower_band, upper_walls: MultiLineString, shift: tuple[float, float]) -> float:
    """How much of the upper floor's wall length lies on the lower floor's walls after the shift."""
    moved = translate(upper_walls, *shift)
    return moved.intersection(lower_band).length / max(moved.length, 1e-9)


REFINE_RADIUS_M = 1.0  # walls may only fine-tune a shaft-based alignment this far
WALLS_STACK_SHARE = 0.5  # ... and only when at least this share of the wall length then stacks


def shaft_overlap(lower_shafts: list, upper_shafts: list, shift: tuple[float, float]) -> float:
    """Area of the upper floor's stair and lift shafts that lands on a shaft of the same kind below."""
    return sum(max((translate(shape, *shift).intersection(other).area for kind_b, other in lower_shafts
                    if kind_b == kind), default=0.0) for kind, shape in upper_shafts)


def refine(score, start: tuple[float, float], radius: float | None) -> tuple[float, tuple[float, float]]:
    """Coarse-to-fine hill climb on score(shift), staying within radius of start (None: anywhere)."""
    best, best_score = start, score(start)
    for step in (0.5, 0.1, 0.02):
        improved = True
        while improved:
            improved = False
            for dx, dy in ((step, 0), (-step, 0), (0, step), (0, -step)):
                shift = (best[0] + dx, best[1] + dy)
                if radius is not None and math.dist(shift, start) > radius:
                    continue
                value = score(shift)
                if value > best_score + 1e-9:
                    best_score, best, improved = value, shift, True
    return best_score, best


def alignment(lower: FloorPlan, upper: FloorPlan, lower_offset: tuple[float, float]) -> tuple[float, float] | None:
    # "lower" is the floor already in place and "upper" the one being moved; it works in either direction.
    """The shift that puts upper on top of lower. Stair and lift shafts continue through the floors, so they
    decide (the shift that stacks the most shaft area on matching shafts); the walls then fine-tune it within
    REFINE_RADIUS_M (shafts can be drawn slightly differently per floor). Without shafts in common, the walls
    alone decide, starting from the outlines' corners and centres. None when nothing stacks."""
    lower_walls = translate(walls(lower), *lower_offset)
    band = lower_walls.buffer(WALL_MATCH_M)
    upper_walls = walls(upper)

    def wall_score(shift):
        return stacked_share(band, upper_walls, shift)

    below, above = shafts(lower, lower_offset), shafts(upper)
    candidates = [(a.centroid.x - b.centroid.x, a.centroid.y - b.centroid.y)
                  for (kind_a, a), (kind_b, b) in itertools.product(below, above)
                  if kind_a == kind_b and abs(a.area - b.area) <= 0.5 * max(a.area, b.area)]
    if candidates:
        overlaps = [(shaft_overlap(below, above, shift), shift) for shift in candidates]
        top = max(value for value, _ in overlaps)
        if top > 0:
            # among shifts that stack (almost) as much shaft area as the best, take the one with most walls
            good = [shift for value, shift in overlaps if value >= 0.9 * top]
            start = max(good, key=wall_score)
            refined_score, refined = refine(wall_score, start, REFINE_RADIUS_M)
            # walls only fine-tune when they really stack; some buildings' floors have different layouts
            chosen = refined if refined_score >= WALLS_STACK_SHARE else start
            others = [shift for shift in good if math.dist(shift, start) > REFINE_RADIUS_M]
            if others and refined_score < WALLS_STACK_SHARE:
                raise AmbiguousAlignment(chosen, len(others) + 1)
            return chosen
    # No stairs or lifts drawn in common: centre the floors on each other (how plans without them, such as
    # the Swiss Dwellings ones, are laid out), unless that stacks clearly fewer walls than another fit.
    lx0, ly0, lx1, ly1 = lower_walls.bounds
    ux0, uy0, ux1, uy1 = upper_walls.bounds
    centred = ((lx0 + lx1 - ux0 - ux1) / 2, (ly0 + ly1 - uy0 - uy1) / 2)
    corners = [(lx0 - ux0, ly0 - uy0), (lx1 - ux1, ly1 - uy1), (lx0 - ux0, ly1 - uy1), (lx1 - ux1, ly0 - uy0)]
    best_score, best = max(refine(wall_score, start, None) for start in [centred, *corners])
    if wall_score(centred) >= best_score - 0.1:
        return centred
    return best if best_score >= MIN_STACKED_SHARE else None


def door_spaces(position: list[float], spaces: list[dict], floor_id: str) -> list[str]:
    """The (up to) two spaces a door marker joins: the two nearest outlines. Markers normally sit on the wall
    between them, but mapped doors (OSM) can be a few metres off, so anything within DOOR_REACH_M counts."""
    point = Point(position)
    near = sorted((Polygon(space["polygon"]).exterior.distance(point), space["id"]) for space in spaces
                  if space["floor_id"] == floor_id)
    return [space_id for distance, space_id in near if distance <= DOOR_REACH_M][:2]


def assemble(
    plans: list[tuple[int, FloorPlan]],
    building_id: str = "imported",
    name: str | None = None,
    floor_heights_m: dict[int, float] | None = None,
    offsets: dict[int, tuple[float, float]] | None = None,
) -> tuple[dict, list[str]]:
    """Turn floor plans (level, plan) into a building.json dict. Returns it with a list of notes: what was
    assumed or couldn't be worked out, for the agent to confirm with the person."""
    notes: list[str] = []
    plans = sorted(plans, key=lambda item: item[0])
    levels = [level for level, _ in plans]
    if len(set(levels)) != len(levels):
        raise PlanError("Two plans have the same floor level.")
    heights = floor_heights_m or {}
    # Line the floors up: the ground floor (or the floor nearest to it) stays put; going up and down from it,
    # each floor is moved onto its already placed neighbour. A badly drawn basement then can't drag every
    # floor above it out of place.
    shifts: dict[int, tuple[float, float]] = dict(offsets or {})
    reference = min(range(len(levels)), key=lambda i: (abs(levels[i]), levels[i]))
    shifts.setdefault(levels[reference], (0.0, 0.0))
    order = [(i, i - 1) for i in range(reference + 1, len(levels))] + [(i, i + 1) for i in range(reference - 1, -1, -1)]
    for index, neighbour in order:
        level = levels[index]
        if level in shifts:
            continue
        try:
            found = alignment(plans[neighbour][1], plans[index][1], shifts[levels[neighbour]])
        except AmbiguousAlignment as unsure:
            found = unsure.best
            notes.append(f"Floor {level} fits onto floor {levels[neighbour]} in {unsure.choices} places (its stairs "
                         f"or lifts match several below). Show the person the floors stacked and ask if it's right.")
        if found is None:
            shifts[level] = shifts[levels[neighbour]]
            notes.append(f"Floor {level}'s walls and shafts don't line up with floor {levels[neighbour]}; it is "
                         f"placed at the same origin. Ask how the two floors line up.")
        else:
            shifts[level] = found

    floors, spaces, openings = [], [], []
    ground_index = min(range(len(levels)), key=lambda i: abs(levels[i]))
    elevations = {}
    running = 0.0
    for level in levels[ground_index:]:
        elevations[level] = running
        running += heights.get(level, DEFAULT_FLOOR_HEIGHT_M)
    running = 0.0
    for level in reversed(levels[:ground_index]):
        running -= heights.get(level, DEFAULT_FLOOR_HEIGHT_M)
        elevations[level] = running
    if not floor_heights_m:
        notes.append(f"Floor heights are not in the plans; assumed {DEFAULT_FLOOR_HEIGHT_M} m each. Ask if they differ.")

    for level, plan in plans:
        floor_id = f"{building_id}-F{level}"
        default_name = "Ground floor" if level == 0 else (f"Basement {-level}" if level < 0 else f"Floor {level}")
        floors.append({"id": floor_id, "level": level, "name": plan.floor_name or default_name,
                       "elevation_m": round(elevations[level], 3), "height_m": heights.get(level, DEFAULT_FLOOR_HEIGHT_M)})
        dx, dy = shifts[level]
        floor_spaces = []
        for index, space in enumerate(plan.spaces, start=1):
            label = space["label"] or f"{level}.x{index:02d}"
            word = TYPE_WORDS.get(space["room_type"], space["room_type"].replace("_", " ").capitalize())
            floor_spaces.append({
                "id": f"{floor_id}-S{index:03d}",
                "floor_id": floor_id,
                "type": space["type"],
                "room_type": space["room_type"],
                "name": f"{word} {label}",
                "ref": label,
                "polygon": [[round(x + dx, 4), round(y + dy, 4)] for x, y in space["polygon"]],
                "synthetic": space["label"] is None,
            })
        unlabelled = sum(1 for space in plan.spaces if space["label"] is None)
        if unlabelled:
            notes.append(f"{unlabelled} spaces on floor {level} have no label; they got numbers like {level}.x01.")
        spaces += floor_spaces
        for index, marker in enumerate(plan.markers, start=1):
            position = [round(marker["position"][0] + dx, 4), round(marker["position"][1] + dy, 4)]
            joined = door_spaces(position, floor_spaces, floor_id)
            if marker["kind"] == "entrance":
                if not joined:
                    notes.append(f"An entrance marker on floor {level} touches no room; skipped.")
                    continue
                pair = ["outside", joined[0]]
            elif len(joined) == 2:
                pair = joined
            else:
                notes.append(f"A door marker on floor {level} at {position} isn't between two spaces; skipped.")
                continue
            kind = "entrance" if marker["kind"] == "entrance" else marker["kind"]
            openings.append({
                "id": f"{floor_id}-O{index:04d}",
                "floor_id": floor_id,
                "space_ids": pair,
                "kind": kind,
                "position": position,
                "width_m": DEFAULT_DOOR_WIDTH_M,
                "step_free": True,
                "synthetic": False,
            })
    if openings:
        notes.append(f"Door widths are not in the plans; all {len(openings)} doors and openings were set to "
                     f"{DEFAULT_DOOR_WIDTH_M} m and step-free. Ask about wide doors and steps.")
    notes.append("Room types are not in the plans (one colour for every kind of room); rooms are 'generic room' "
                 "until the person says what they are.")
    halls = stair_halls(floors, spaces, openings)
    if halls:
        landings = sorted({space["name"] for chain in halls for space in chain})
        notes.append(f"No stair or lift shafts are drawn; {len(landings)} stair landings were recognised (corridors "
                     f"that open onto other corridors and lie over each other floor to floor), joined by "
                     f"{len(halls)} flight(s) of stairs: {', '.join(landings[:12])}{' …' if len(landings) > 12 else ''}"
                     f". Show them and ask if those are the stairs, and whether there is a lift.")
    connectors = link_floors(floors, spaces, halls)
    return {
        "building": {"id": building_id, "name": name or next((p.building_name for _, p in plans if p.building_name),
                                                             building_id),
                     "source": "imported_plan", "license": "user", "split": "imported", "units": "m"},
        "floors": floors,
        "spaces": spaces,
        "openings": openings,
        "vertical_connectors": connectors,
        "assets": [],
    }, notes


HALL_MAX_DOORS = 4  # a stair landing has few doors (to the flats and the next landing), a flat's hallway many
HALL_FEW_DOORS = 2  # ... and a landing at the end of the stairs opens only to a flat or two
HALL_OVERLAP = 0.4  # a landing lies over the one below: their overlap covers this share of the smaller one


def stair_halls(floors: list[dict], spaces: list[dict], openings: list[dict]) -> list[list[dict]]:
    """Plans that draw no stair or lift shafts (Swiss Dwellings: the stairs are corridor-coloured landings,
    "Landing 0.11", often without a label): the landings are the corridors that open into two or more other
    corridors (the next landing, the flats' hallways) through at most HALL_MAX_DOORS doors, that have only one
    or two doors, or that have the building's entrance. A flat's own hallway opens into its rooms instead. Landings on consecutive floors that lie over each other are joined by stairs (floors where none do,
    by their two nearest landings: the stairs must reach every floor): one stack when the
    stair core repeats one to one, otherwise a flight per pair (a ground-floor hall can lead up to several
    cores). Their spaces are marked as stairwells (they stay corridors). Nothing when the plans draw any stair
    or lift."""
    if any(space["type"] in ("stair", "lift") for space in spaces):
        return []
    by_id = {space["id"]: space for space in spaces}
    neighbours: dict[str, list[dict | None]] = {}
    entrances = set()
    for opening in openings:
        if opening["kind"] == "entrance":
            entrances.update(opening["space_ids"])
        for space_id in opening["space_ids"]:
            neighbours.setdefault(space_id, []).extend(by_id.get(other) for other in opening["space_ids"]
                                                       if other != space_id)

    def corridor_neighbours(space: dict) -> list[dict]:
        return [other for other in neighbours.get(space["id"], []) if other and other["type"] == "corridor"]

    corridors = [space for space in spaces if space["type"] == "corridor"]
    landings = {space["id"] for space in corridors if space["id"] in entrances
                or len(neighbours.get(space["id"], [])) <= HALL_FEW_DOORS
                or (len(corridor_neighbours(space)) >= 2 and len(neighbours.get(space["id"], [])) <= HALL_MAX_DOORS)}
    order = sorted(floors, key=lambda floor: floor["level"])
    on_floor = {floor["id"]: [s for s in corridors if s["floor_id"] == floor["id"] and s["id"] in landings]
                for floor in order}
    shapes = {space_id: Polygon(by_id[space_id]["polygon"]).buffer(0) for space_id in landings}

    def over(a: dict, b: dict) -> float:
        one, two = shapes[a["id"]], shapes[b["id"]]
        if not one.intersects(two):
            return 0.0
        return one.intersection(two).area / min(one.area, two.area)

    up: dict[str, list[dict]] = {}
    down: dict[str, list[dict]] = {}
    for lower_floor, upper_floor in zip(order, order[1:]):
        if upper_floor["level"] != lower_floor["level"] + 1:
            continue
        lower, upper = on_floor[lower_floor["id"]], on_floor[upper_floor["id"]]
        pairs = set()
        for space, others, flip in [(a, upper, False) for a in lower] + [(b, lower, True) for b in upper]:
            score, best = max(((over(space, other), index) for index, other in enumerate(others)), default=(0, -1))
            if score >= HALL_OVERLAP:
                pairs.add((others[best]["id"], space["id"]) if flip else (space["id"], others[best]["id"]))
        if not pairs and lower and upper:  # every floor is reached somehow: the two nearest landings
            a, b = min(itertools.product(lower, upper),
                       key=lambda pair: shapes[pair[0]["id"]].distance(shapes[pair[1]["id"]]))
            pairs.add((a["id"], b["id"]))
        for a, b in sorted(pairs):
            up.setdefault(a, []).append(by_id[b])
            down.setdefault(b, []).append(by_id[a])
    halls, done = [], set()
    for floor in order:
        for space in on_floor[floor["id"]]:
            for above in up.get(space["id"], []):
                if (space["id"], above["id"]) in done:
                    continue
                chain = [space, above]
                done.add((space["id"], above["id"]))
                # one to one: the same core goes on up
                while len(up.get(chain[-1]["id"], [])) == 1 and len(down.get(chain[-1]["id"], [])) == 1 \
                        and len(down.get(up[chain[-1]["id"]][0]["id"], [])) == 1:
                    nxt = up[chain[-1]["id"]][0]
                    done.add((chain[-1]["id"], nxt["id"]))
                    chain.append(nxt)
                halls.append(chain)
    for space_id in {space["id"] for chain in halls for space in chain}:
        by_id[space_id]["room_type"] = "stairwell"
        by_id[space_id]["name"] = f"Stair hall {by_id[space_id]['ref']}"
    return halls


def link_floors(floors: list[dict], spaces: list[dict], halls: list[list[dict]] | None = None) -> list[dict]:
    """Stair and lift spaces stacked on consecutive floors become one connector each (stairs not step-free);
    so do stair halls found by stair_halls (already stacked, lowest floor first)."""
    order = sorted(floors, key=lambda floor: floor["level"])
    shafts_by_floor = {floor["id"]: [s for s in spaces if s["floor_id"] == floor["id"] and s["type"] in ("stair", "lift")]
                       for floor in order}
    chains: list[list[dict]] = []
    open_chains: list[list[dict]] = []
    for floor in order:
        next_open = []
        for shaft in shafts_by_floor[floor["id"]]:
            polygon = Polygon(shaft["polygon"]).buffer(0)
            match = None
            for chain in open_chains:
                top = chain[-1]
                if top["type"] != shaft["type"]:
                    continue
                other = Polygon(top["polygon"]).buffer(0)
                overlap = other.intersection(polygon).area / max(min(other.area, polygon.area), 1e-9)
                if overlap > 0.5:
                    match = chain
                    break
            if match is not None:
                match.append(shaft)
                open_chains.remove(match)
                next_open.append(match)
            else:
                chain = [shaft]
                chains.append(chain)
                next_open.append(chain)
        open_chains = next_open
    chains += halls or []
    connectors = []
    counters = {"stair": 0, "lift": 0}
    for chain in chains:
        if len(chain) < 2:
            continue
        kind = "lift" if chain[0]["type"] == "lift" else "stair"
        counters[kind] += 1
        connectors.append({
            "id": f"{chain[0]['floor_id'].rsplit('-F', 1)[0]}-V{len(connectors) + 1:02d}",
            "kind": "lift" if kind == "lift" else "stairs",
            "name": f"{'Lift' if kind == 'lift' else 'Stairs'} {counters[kind]}",
            "floor_ids": [space["floor_id"] for space in chain],
            "space_ids": [space["id"] for space in chain],
            "step_free": kind == "lift",
            "synthetic": True,
        })
    return connectors


def import_plans(paths: list[Path | str], building_id: str = "imported", **options) -> tuple[dict, list[str]]:
    """Read floor_<level>.svg files and assemble a building."""
    plans = []
    for index, path in enumerate(paths):
        level = level_from_filename(path)
        plans.append((index if level is None else level, read_svg(path)))
    return assemble(plans, building_id, **options)


def describe(building: dict) -> dict:
    """A short summary of a draft, to show what was understood before saving."""
    by_floor = []
    for floor in sorted(building["floors"], key=lambda f: f["level"]):
        floor_spaces = [s for s in building["spaces"] if s["floor_id"] == floor["id"]]
        kinds: dict[str, int] = {}
        for space in floor_spaces:
            kinds[space["type"]] = kinds.get(space["type"], 0) + 1
        xs = [x for s in floor_spaces for x, _ in s["polygon"]]
        ys = [y for s in floor_spaces for _, y in s["polygon"]]
        by_floor.append({
            "level": floor["level"], "name": floor["name"], "spaces": len(floor_spaces), "kinds": kinds,
            "size_m": [round(max(xs) - min(xs), 1), round(max(ys) - min(ys), 1)] if xs else None,
            "doors": sum(1 for o in building["openings"] if o["floor_id"] == floor["id"] and o["kind"] != "entrance"),
            "entrances": sum(1 for o in building["openings"] if o["floor_id"] == floor["id"] and o["kind"] == "entrance"),
            "total_area_m2": round(sum(Polygon(s["polygon"]).buffer(0).area for s in floor_spaces), 1),
        })
    return {"name": building["building"]["name"], "floors": by_floor,
            "stairs_and_lifts": [c["name"] for c in building["vertical_connectors"]]}


def scale(building: dict, factor: float) -> dict:
    """Multiply every coordinate by factor (when the person corrects the size)."""
    if not math.isfinite(factor) or factor <= 0:
        raise PlanError("The scale factor must be a positive number.")
    for space in building["spaces"]:
        space["polygon"] = [[round(x * factor, 4), round(y * factor, 4)] for x, y in space["polygon"]]
    for opening in building["openings"]:
        opening["position"] = [round(v * factor, 4) for v in opening["position"]]
    for asset in building["assets"]:
        asset["position"] = [round(v * factor, 4) for v in asset["position"]]
    return building


def enrich_from_equipment(building: dict, rows: list[dict]) -> list[str]:
    """Fill in what plans can't say from an equipment list (equipment.csv): every row names its room (number,
    name, type, floor level) and the thing in it. Rooms are matched by floor level and room number, else by
    name; a thing keeps its x/y when that lands inside its room, else it stands at the room's centre (the
    plan's frame can be shifted). Returns notes on what was filled in."""
    levels = {floor["id"]: floor["level"] for floor in building["floors"]}
    by_ref = {(levels[space["floor_id"]], str(space.get("ref") or "").strip()): space for space in building["spaces"]}
    by_name = {(levels[space["floor_id"]], space["name"].strip().lower()): space for space in building["spaces"]}
    named, assets = set(), []
    for row in rows:
        try:
            level = int(float(row.get("floor_level") or ""))
        except ValueError:
            continue
        space = by_ref.get((level, str(row.get("room_ref") or "").strip())) or by_name.get(
            (level, str(row.get("space_name") or "").strip().lower()))
        if space is None:
            continue
        if space["id"] not in named:
            named.add(space["id"])
            space["name"] = row.get("space_name") or space["name"]
            space["room_type"] = row.get("room_type") or space["room_type"]
        polygon = Polygon(space["polygon"]).buffer(0)
        try:
            point = Point(float(row["x_m"]), float(row["y_m"]))
        except (KeyError, ValueError):
            point = None
        if point is None or not polygon.contains(point):
            point = polygon.representative_point()
        assets.append({
            "id": row.get("asset_id") or f"{space['id']}-A{len(assets) + 1:05d}",
            "name": row.get("name") or row.get("type", "thing"),
            "category": row.get("category") or "equipment",
            "type": row.get("type") or "thing",
            "space_id": space["id"],
            "floor_id": space["floor_id"],
            "position": [round(point.x, 3), round(point.y, 3)],
            "footprint": {"width_m": float(row.get("width_m") or 0.5), "depth_m": float(row.get("depth_m") or 0.5),
                          "rotation_deg": float(row.get("rotation_deg") or 0.0)},
            "source": "equipment.csv",
        })
    building["assets"] = assets
    notes = [f"From the equipment list: names and room types for {len(named)} rooms, {len(assets)} things placed."]
    return notes + door_widths_from_room_types(building)


def door_widths_from_room_types(building: dict) -> list[str]:
    """Doors of a generated-style building (it has rooms like labs, server rooms or production zones) get the
    width its room types imply: the widest of the two rooms a door joins. Other doors, entrances and openings
    keep theirs. Returns a note on what was changed, to confirm in conversation."""
    types = {space["id"]: space.get("room_type") for space in building["spaces"]}
    if not PROCEDURAL_ROOM_TYPES & set(types.values()):
        return []
    changed = 0
    for opening in building["openings"]:
        widths = [PROCEDURAL_DOOR_WIDTHS_M[t] for t in map(types.get, opening["space_ids"])
                  if t in PROCEDURAL_DOOR_WIDTHS_M]
        if opening["kind"] == "door" and widths and opening["width_m"] != max(widths):
            opening["width_m"] = max(widths)
            changed += 1
    if not changed:
        return []
    return [f"Door widths from room types for {changed} doors (0.9 m offices, 1.1 m lifts, 1.2 m labs, meeting "
            "rooms and toilets, 1.6 m halls, storage and server rooms). Confirm any door that differs."]
