"""Questions the dataset never asks, on build buildings only, with answers computed by the engine.

They check that the agent isn't fitted to the 15 dataset question kinds: new kinds of question ("smallest",
"how many entrances", "door width", "mean area"), known kinds with changed definitions ("at least 2 m of
wall", "shorter by more than 5 m", "halls count too"), and same-named rooms.

  uv run python -m evals.novel     # writes evals/sets/build_novel.jsonl (free, no API)
"""

import itertools
import random
from collections.abc import Callable

from evals.sets import DATA, write
from holdout.split import BUILD_LIST, read
from navagent.tools import Session
from navcore.engine import OUTSIDE, Building, Constraints, EngineError

SEED = 77
PER_TEMPLATE = 2
NUMBER_LINE = "Finish with a line 'Answer: <number>'."
ROOM_LINE = "Finish with a line 'Answer: <room name or number>'."


def number(value: float, relative: float = 0.01, absolute: float = 0.0) -> dict:
    return {"type": "number", "value": round(value, 4), "relative_tolerance": relative, "absolute_tolerance": absolute}


def count(value: int) -> dict:
    return number(value, 0.0, 0.0)


def room(building: Building, space_id: str, runner_up: str | None = None, area: float | None = None) -> dict:
    def labels(target: str) -> list[str]:
        space = building.spaces[target]
        return [space["name"]] + ([space["ref"]] if space.get("ref") else [])

    answer = {"type": "space", "space_id": space_id, "accept": labels(space_id),
              "reject": labels(runner_up) if runner_up else []}
    if area is not None:
        answer["area"] = number(area, 0.05)
    return answer


def name(building: Building, space_id: str) -> str:
    return building.label(space_id)


def unique_named(building: Building, spaces: list[dict]) -> list[dict]:
    """Spaces whose name is unique on their floor, so the question is unambiguous."""
    seen: dict[tuple, int] = {}
    for space in building.spaces.values():
        key = (space["name"], space["floor_id"])
        seen[key] = seen.get(key, 0) + 1
    return [space for space in spaces if seen[(space["name"], space["floor_id"])] == 1]


def rooms(building: Building) -> list[dict]:
    return unique_named(building, [s for s in building.spaces.values() if s["type"] == "room"])


Template = Callable[[Building, Session, random.Random], tuple[str, dict] | None]


def smallest_of_type(b: Building, s: Session, rng: random.Random):
    floor = rng.choice(sorted(b.floors))
    by_type: dict[str, list[str]] = {}
    for space in rooms(b):
        if space["floor_id"] == floor:
            by_type.setdefault(space["room_type"], []).append(space["id"])
    options = [(t, ids) for t, ids in sorted(by_type.items()) if len(ids) >= 2]
    if not options:
        return None
    room_type, ids = rng.choice(options)
    ids.sort(key=b.area)
    if b.area(ids[1]) < b.area(ids[0]) * 1.1:
        return None  # no clear winner
    words = room_type.replace("_", " ")
    question = (f"We need a quiet corner. Which {words} on {b.floor_name(floor).lower()} has the smallest floor "
                f"area, and how many square metres is it? Finish with a line 'Answer: <room>, <area> m²'.")
    return question, room(b, ids[0], ids[1], b.area(ids[0]))


def count_of_type(b: Building, s: Session, rng: random.Random):
    floor = rng.choice(sorted(b.floors))
    types = sorted({space["room_type"] for space in b.spaces_on(floor, rooms_only=True)})
    if not types:
        return None
    room_type = rng.choice(types)
    total = len([sp for sp in b.spaces_on(floor) if sp["room_type"] == room_type])
    return (f"Quick inventory check: how many {room_type.replace('_', ' ')} spaces are there on "
            f"{b.floor_name(floor).lower()}? {NUMBER_LINE}", count(total))


def mean_area(b: Building, s: Session, rng: random.Random):
    floor = rng.choice(sorted(b.floors))
    types = sorted({sp["room_type"] for sp in b.spaces_on(floor, rooms_only=True)})
    candidates = [t for t in types if len([sp for sp in b.spaces_on(floor) if sp["room_type"] == t]) >= 3]
    if not candidates:
        return None
    room_type = rng.choice(candidates)
    areas = [b.area(sp["id"]) for sp in b.spaces_on(floor) if sp["room_type"] == room_type]
    return (f"For the space-planning report: what is the average size, in m², of a "
            f"{room_type.replace('_', ' ')} on {b.floor_name(floor).lower()}? {NUMBER_LINE}",
            number(sum(areas) / len(areas), 0.02))


def door_width(b: Building, s: Session, rng: random.Random):
    named = {sp["id"] for sp in unique_named(b, list(b.spaces.values()))}
    doors = [o for o in b.openings.values() if OUTSIDE not in o["space_ids"] and o.get("width_m")
             and all(x in named for x in o["space_ids"])]
    pairs: dict[frozenset, list] = {}
    for opening in doors:
        pairs.setdefault(frozenset(opening["space_ids"]), []).append(opening)
    single = [items[0] for items in pairs.values() if len(items) == 1]
    if not single:
        return None
    opening = rng.choice(sorted(single, key=lambda o: o["id"]))
    first, second = opening["space_ids"]
    return (f"Will a {opening['width_m'] + 0.15:.2f} m cabinet fit? How wide, in metres, is the doorway between "
            f"{name(b, first)} and {name(b, second)}? {NUMBER_LINE}", number(opening["width_m"], 0.0, 0.005))


def entrances(b: Building, s: Session, rng: random.Random):
    step_free = rng.random() < 0.5
    found = [o for o in b.openings.values() if OUTSIDE in o["space_ids"]
             and (not step_free or o.get("step_free", True))]
    words = "step-free entrances (no steps)" if step_free else "entrances from outside"
    return f"Fire safety audit: how many {words} does this building have in total? {NUMBER_LINE}", count(len(found))


def nearest_exit(b: Building, s: Session, rng: random.Random):
    distances = b.distances_to_exit()
    candidates = [sp for sp in rooms(b) if sp["id"] in distances and distances[sp["id"]] > 3]
    if not candidates:
        return None
    start = rng.choice(candidates)
    return (f"The alarm just went off and I'm in {name(b, start['id'])}. How many metres do I have to walk to get "
            f"out of the building by the nearest entrance? {NUMBER_LINE}", number(distances[start["id"]], 0.01, 1.0))


def floors_count(b: Building, s: Session, rng: random.Random):
    return f"How many floors (levels, including any basements) does this building have? {NUMBER_LINE}", count(len(b.floors))


def walls_longer(b: Building, s: Session, rng: random.Random):
    candidates = []
    for space in rooms(b):
        default = b.wall_neighbours(space["id"])
        strict = b.wall_neighbours(space["id"], min_length_m=2.0)
        if len(strict) != len(default) and strict:
            candidates.append((space, len(strict)))
    if not candidates:
        return None
    space, value = rng.choice(candidates)
    return (f"For an acoustic study of {name(b, space['id'])}: how many other rooms on that floor share a wall with "
            f"it over a length of at least 2 m (within 0.35 m, door or not)? Corridors, stairwells and lifts don't "
            f"count. {NUMBER_LINE}", count(value))


def what_if_threshold(b: Building, s: Session, rng: random.Random):
    levels = sorted(b.floors, key=b.level)
    ground = levels[0] if b.level(levels[0]) == 0 else next((f for f in levels if b.level(f) == 0), None)
    if ground is None:
        return None
    named = unique_named(b, [sp for sp in b.spaces_on(ground) if sp["type"] in ("room", "corridor", "hall")])
    pairs = []
    for first, second in itertools.combinations(named[:40], 2):
        if b.polygons[first["id"]].distance(b.polygons[second["id"]]) > 0.35:
            continue
        if b.shared_wall_length(first["id"], second["id"]) < 2.0:
            continue
        pairs.append((first["id"], second["id"]))
    rng.shuffle(pairs)
    for first, second in pairs[:15]:
        target = rng.choice(levels)  # unlike the dataset, the floor may be the door's own floor
        try:
            default = b.what_if_door(first, second, target)
        except EngineError:
            continue
        for threshold in (5.0, 3.0, 0.5, 0.0):
            changed = b.what_if_door(first, second, target, threshold_m=threshold)
            if changed and len(changed) != len(default):
                return (f"If we put a door in the middle of the wall between {name(b, first)} and "
                        f"{name(b, second)}, how many rooms on {b.floor_name(target).lower()} would get a walk out "
                        f"of the building (to their nearest entrance) that is more than {threshold:g} m shorter? "
                        f"{NUMBER_LINE}", count(len(changed)))
    return None


def reach_with_halls(b: Building, s: Session, rng: random.Random):
    halls = [sp for sp in b.spaces.values() if sp["type"] == "hall"]
    if not halls:
        return None
    entries = unique_named(b, [b.spaces[x] for o in b.openings.values() if OUTSIDE in o["space_ids"]
                               for x in o["space_ids"] if x != OUTSIDE])
    if not entries:
        return None
    start = rng.choice(entries)["id"]
    floor = b.spaces[start]["floor_id"]
    constraints = Constraints(step_free=True, min_width_m=1.2)
    value = len(b.reachable_rooms(start, floor, constraints, frozenset({"room", "hall"})))
    return (f"A 1.2 m wide pallet comes in through the entrance into {name(b, start)}. No stairs or steps, and "
            f"every door must be at least 1.2 m wide. Counting halls as well as rooms, how many of them on "
            f"{b.floor_name(floor).lower()} can it reach? {NUMBER_LINE}", count(value))


def narrow_doors(b: Building, s: Session, rng: random.Random):
    floor = rng.choice(sorted(b.floors))
    widths = sorted({o["width_m"] for o in b.openings.values() if o["floor_id"] == floor and o.get("width_m")})
    if len(widths) < 2:
        return None
    limit = widths[len(widths) // 2]
    value = len([o for o in b.openings.values() if o["floor_id"] == floor and o.get("width_m")
                 and o["width_m"] < limit - 1e-9])
    return (f"Accessibility review: how many doors, openings or entrances on {b.floor_name(floor).lower()} are "
            f"narrower than {limit:g} m? {NUMBER_LINE}", count(value))


def assets_in_room(b: Building, s: Session, rng: random.Random):
    holders: dict[tuple, int] = {}
    named = {sp["id"] for sp in rooms(b)}
    for asset in b.assets.values():
        if asset["space_id"] in named:
            key = (asset["space_id"], asset["type"])
            holders[key] = holders.get(key, 0) + 1
    options = sorted(key for key, value in holders.items() if value >= 2)
    if not options:
        return None
    space_id, asset_type = rng.choice(options)
    return (f"How many {asset_type.replace('_', ' ')} items are in {name(b, space_id)}? {NUMBER_LINE}",
            count(holders[(space_id, asset_type)]))


def bigger_than(b: Building, s: Session, rng: random.Random):
    floor = rng.choice(sorted(b.floors))
    areas = sorted(b.area(sp["id"]) for sp in b.spaces_on(floor, rooms_only=True))
    if len(areas) < 4:
        return None
    limit = round(areas[len(areas) // 2] + 0.5)
    if any(abs(area - limit) < 0.2 for area in areas):
        return None  # too close to the cut
    value = len([area for area in areas if area > limit])
    return (f"How many rooms on {b.floor_name(floor).lower()} are larger than {limit} m²? Corridors, stairwells, "
            f"lifts and halls don't count. {NUMBER_LINE}", count(value))


def farthest_of_type(b: Building, s: Session, rng: random.Random):
    candidates = rooms(b)
    if len(candidates) < 4:
        return None
    start = rng.choice(candidates)
    distances = b.distances_from(start["id"])
    same_type: dict[str, list[str]] = {}
    for sp in candidates:
        if sp["id"] != start["id"] and sp["id"] in distances:
            same_type.setdefault(sp["room_type"], []).append(sp["id"])
    options = [(t, ids) for t, ids in sorted(same_type.items()) if len(ids) >= 2]
    if not options:
        return None
    room_type, ids = rng.choice(options)
    ids.sort(key=lambda x: -distances[x])
    if distances[ids[0]] - distances[ids[1]] < 3:
        return None
    return (f"I'm in {name(b, start['id'])}. Which {room_type.replace('_', ' ')} is the longest walk away from me? "
            f"{ROOM_LINE}", room(b, ids[0], ids[1]))


def step_free_avoiding(b: Building, s: Session, rng: random.Random):
    lifts = [c for c in b.connectors.values() if c["kind"] == "lift"]
    if len(lifts) < 2:
        return None
    closed = rng.choice(sorted(lifts, key=lambda c: c["id"]))
    names = [c["name"] for c in b.connectors.values()]
    if names.count(closed["name"]) > 1:
        return None
    candidates = rooms(b)
    for _ in range(20):
        first, second = rng.sample(candidates, 2)
        if b.level(first["floor_id"]) == b.level(second["floor_id"]):
            continue
        try:
            route = b.route(first["id"], second["id"], Constraints(step_free=True, closed=frozenset({closed["id"]})))
        except EngineError:
            continue
        return (f"{closed['name']} is being repaired today. I use a wheelchair: how far is it in metres from "
                f"{name(b, first['id'])} to {name(b, second['id'])}? {NUMBER_LINE}", number(route.length_m, 0.01, 1.0))
    return None


def duplicate_name_agreeing(b: Building, s: Session, rng: random.Random):
    """A room whose name exists several times on its floor, where every reading gives the same answer."""
    groups: dict[tuple, list[str]] = {}
    for space in b.spaces.values():
        if space["type"] == "room":
            groups.setdefault((space["name"], space["floor_id"]), []).append(space["id"])
    options = []
    for (room_name, floor_id), ids in sorted(groups.items()):
        if len(ids) < 2:
            continue
        counts = {len(b.wall_neighbours(x)) for x in ids}
        if len(counts) == 1:
            options.append((room_name, floor_id, counts.pop()))
    if not options:
        return None
    room_name, floor_id, value = rng.choice(options)
    return (f"We're soundproofing {room_name} ({b.floor_name(floor_id)}). How many other rooms on that floor share "
            f"a wall with it (at least 1 m, within 0.35 m, door or not; corridors, stairwells and lifts don't "
            f"count)? {NUMBER_LINE}", count(value))


TEMPLATES: dict[str, Template] = {
    "smallest_of_type": smallest_of_type,
    "count_of_type": count_of_type,
    "mean_area": mean_area,
    "door_width": door_width,
    "entrances": entrances,
    "nearest_exit": nearest_exit,
    "floors_count": floors_count,
    "walls_2m": walls_longer,
    "what_if_threshold": what_if_threshold,
    "reach_with_halls": reach_with_halls,
    "narrow_doors": narrow_doors,
    "assets_in_room": assets_in_room,
    "bigger_than": bigger_than,
    "farthest_of_type": farthest_of_type,
    "step_free_avoiding_lift": step_free_avoiding,
    "duplicate_name_agreeing": duplicate_name_agreeing,
}


def build_novel() -> list[dict]:
    rng = random.Random(SEED)
    build = sorted(read(BUILD_LIST))
    paths = {path.name: path for split in ("train", "dev") for path in (DATA / split).iterdir() if path.name in build}
    items = []
    for kind, template in TEMPLATES.items():
        order = build[:]
        rng.shuffle(order)
        made = 0
        for building_id in order:
            if made == PER_TEMPLATE:
                break
            building = Building.load(paths[building_id])
            try:
                result = template(building, Session(building), rng)
            except EngineError:
                result = None
            if result is None:
                continue
            question, answer = result
            items.append({"id": f"{building_id}-N-{kind}", "building_id": building_id, "kind": f"novel_{kind}",
                          "question": question, "answer": answer,
                          "building_path": str(paths[building_id].relative_to(DATA))})
            made += 1
        if made < PER_TEMPLATE:
            print(f"only {made} questions for {kind}")
    return items


def main() -> None:
    items = build_novel()
    print(f"{write('build_novel', items)}: {len(items)} questions")


if __name__ == "__main__":
    main()
