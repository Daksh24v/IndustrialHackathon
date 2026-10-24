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
DEFAULT_FLOOR_HEIGHT_M = 3.5
WALL_SNAP_M = 0.6  # a door marker sits on the wall between the two spaces it joins
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
    """Read one floor drawing. Coordinates: metres, y up, origin at the drawing's top-left corner.
    The scale is measured from the drawing (measured_scale) unless points_per_metre is given."""
    text = Path(path).read_text(encoding="utf-8")
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
            return refine(wall_score, start, REFINE_RADIUS_M)[1]
    lx0, ly0, lx1, ly1 = lower_walls.bounds
    ux0, uy0, ux1, uy1 = upper_walls.bounds
    starts = [(lx0 - ux0, ly0 - uy0), (lx1 - ux1, ly1 - uy1), (lx0 - ux0, ly1 - uy1), (lx1 - ux1, ly0 - uy0),
              ((lx0 + lx1 - ux0 - ux1) / 2, (ly0 + ly1 - uy0 - uy1) / 2)]
    best_score, best = max(refine(wall_score, start, None) for start in starts)
    return best if best_score >= MIN_STACKED_SHARE else None


def door_spaces(position: list[float], spaces: list[dict], floor_id: str) -> list[str]:
    """The (up to) two spaces a marker on a wall joins: the nearest outlines within WALL_SNAP_M."""
    point = Point(position)
    near = sorted((Polygon(space["polygon"]).exterior.distance(point), space["id"]) for space in spaces
                  if space["floor_id"] == floor_id)
    return [space_id for distance, space_id in near if distance <= WALL_SNAP_M][:2]


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
    # Line the floors up: the lowest floor stays put; each next floor is moved onto the one below it.
    shifts: dict[int, tuple[float, float]] = dict(offsets or {})
    for index, (level, plan) in enumerate(plans):
        if level in shifts:
            continue
        if index == 0:
            shifts[level] = (0.0, 0.0)
            continue
        found = alignment(plans[index - 1][1], plan, shifts[levels[index - 1]])
        if found is None:
            shifts[level] = shifts[levels[index - 1]]
            notes.append(f"Floor {level}'s walls don't line up with the floor below; it is placed at the same "
                         f"origin. Ask how the two floors line up.")
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
    connectors = link_floors(floors, spaces)
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


def link_floors(floors: list[dict], spaces: list[dict]) -> list[dict]:
    """Stair and lift spaces stacked on consecutive floors become one connector each (stairs not step-free)."""
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
    connectors = []
    counters = {"stair": 0, "lift": 0}
    for chain in chains:
        if len(chain) < 2:
            continue
        kind = chain[0]["type"]
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
