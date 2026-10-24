"""How well does a building rebuilt from its floor plans match the real one? (Level 4)

  uv run python -m evals.plans              # build buildings (default)
  uv run python -m evals.plans --holdout    # the locked hold-out, checkpoints only

For each building, its floor_<level>.svg plans are imported and compared with its building.json after one
shift for the whole building (plans don't say where the origin is):
- spaces: every true space matched to an imported one (IoU >= 0.9), kind and room number right;
- doors: true openings found at the same place joining the same two spaces;
- stairs and lifts: the same floors connected;
- answers: routes between random spaces (same length within 1%), shared walls, rooms above/below.
Room types, door widths and floor heights are not in the plans (asked in conversation), so they're not scored.
"""

import argparse
import math
import random
import statistics
from collections import Counter
from pathlib import Path

from shapely.geometry import Polygon

from holdout.split import BUILD_LIST, HOLDOUT_LIST, read
from navcore.engine import Building, Constraints, EngineError
from navcore.plans import PlanError, import_plans

DATA = Path(__file__).resolve().parent.parent / "data"
IOU_MATCH = 0.9
DOOR_SNAP_M = 0.3


def polygon(points) -> Polygon:
    shape = Polygon(points)
    return shape if shape.is_valid else shape.buffer(0)


def bounds_min(building: dict, floor_id: str) -> tuple[float, float]:
    points = [p for s in building["spaces"] if s["floor_id"] == floor_id for p in s["polygon"]]
    return min(x for x, _ in points), min(y for _, y in points)


def shifted(building: dict, dx: float, dy: float) -> dict:
    for space in building["spaces"]:
        space["polygon"] = [[x + dx, y + dy] for x, y in space["polygon"]]
    for opening in building["openings"]:
        opening["position"] = [opening["position"][0] + dx, opening["position"][1] + dy]
    return building


def compare(truth: Building, imported: dict) -> dict:
    """Scores for one building: counts and matches, plus answer checks."""
    result: Counter = Counter()
    floor_map = {f["id"]: next(t["id"] for t in truth.floors.values() if t["level"] == f["level"])
                 for f in imported["floors"]}
    # Floor alignment, where the dataset's floors share one frame (not Swiss Dwellings, whose floors are
    # partly centred per floor): each floor's offset from where the ground floor's placement puts it.
    ground = min(truth.floors.values(), key=lambda f: (abs(f["level"]), f["level"]))
    imported_floor = {t: i for i, t in floor_map.items()}
    gx, gy = (a - b for a, b in zip(bounds_min(truth.data, ground["id"]),
                                     bounds_min(imported, imported_floor[ground["id"]])))
    if truth.info["source"] != "swiss_dwellings":
        for floor in truth.floors.values():
            if floor["id"] == ground["id"]:
                continue
            fx, fy = (a - b for a, b in zip(bounds_min(truth.data, floor["id"]),
                                             bounds_min(imported, imported_floor[floor["id"]])))
            result["floors_to_align"] += 1
            result["floors_aligned"] += math.dist((fx, fy), (gx, gy)) <= 0.1
    # Geometry is compared floor by floor, each floor placed on its true position.
    for floor in truth.floors.values():
        tx, ty = bounds_min(truth.data, floor["id"])
        ix, iy = bounds_min(imported, imported_floor[floor["id"]])
        for space in imported["spaces"]:
            if space["floor_id"] == imported_floor[floor["id"]]:
                space["polygon"] = [[x + tx - ix, y + ty - iy] for x, y in space["polygon"]]
        for opening in imported["openings"]:
            if opening["floor_id"] == imported_floor[floor["id"]]:
                opening["position"] = [opening["position"][0] + tx - ix, opening["position"][1] + ty - iy]

    mapping: dict[str, str] = {}  # true space id -> imported space id
    for floor in truth.floors.values():
        candidates = [s for s in imported["spaces"] if floor_map[s["floor_id"]] == floor["id"]]
        for space in truth.spaces_on(floor["id"]):
            result["spaces"] += 1
            true_shape = truth.polygons[space["id"]]
            best, best_iou = None, 0.0
            for other in candidates:
                shape = polygon(other["polygon"])
                if not shape.intersects(true_shape):
                    continue
                iou = shape.intersection(true_shape).area / shape.union(true_shape).area
                if iou > best_iou:
                    best, best_iou = other, iou
            if best is None or best_iou < IOU_MATCH:
                continue
            result["spaces_matched"] += 1
            mapping[space["id"]] = best["id"]
            result["kind_right"] += best["type"] == space["type"]
            result["label_right"] += bool(space.get("ref")) and best["ref"] == space.get("ref")
            result["labelled"] += bool(space.get("ref"))
    result["imported_spaces"] = len(imported["spaces"])

    for opening in truth.openings.values():
        result["doors"] += 1
        want = {mapping.get(s, s) for s in opening["space_ids"]}
        if any(math.dist(o["position"], opening["position"]) <= DOOR_SNAP_M and set(o["space_ids"]) == want
               for o in imported["openings"]):
            result["doors_found"] += 1
    result["imported_doors"] = len(imported["openings"])

    true_links = {(c["kind"], frozenset(zip(c["floor_ids"], [mapping.get(s) for s in c["space_ids"]])))
                  for c in truth.connectors.values()}
    imported_links = {(c["kind"], frozenset(zip([floor_map[f] for f in c["floor_ids"]], c["space_ids"])))
                      for c in imported["vertical_connectors"]}
    result["connectors"] = len(true_links)
    result["connectors_found"] = len(true_links & imported_links)
    result["imported_connectors"] = len(imported_links)

    rebuilt = Building(imported)
    rng = random.Random(truth.id)
    matched = sorted(mapping)
    for first, second in (rng.sample(matched, 2) for _ in range(min(10, len(matched) // 2))):
        result["routes"] += 1
        try:
            want = truth.route(first, second, Constraints()).length_m
        except EngineError:
            want = None
        try:
            got = rebuilt.route(mapping[first], mapping[second], Constraints()).length_m
        except EngineError:
            got = None
        result["routes_right"] += (want is None and got is None) or (
            want is not None and got is not None and abs(want - got) <= max(0.01 * want, 0.05))
    rooms = [s for s in matched if truth.spaces[s]["type"] == "room"]
    for space_id in rng.sample(rooms, min(5, len(rooms))):
        result["walls"] += 1
        want = {mapping.get(n) for n in truth.wall_neighbours(space_id)}
        result["walls_right"] += want == set(rebuilt.wall_neighbours(mapping[space_id]))
        for direction in ("above", "below") if truth.info["source"] != "swiss_dwellings" else ():
            truth_other = truth.stacked_room(space_id, direction)
            if truth_other is None:
                continue
            result["stacked"] += 1
            result["stacked_right"] += mapping.get(truth_other) == rebuilt.stacked_room(mapping[space_id], direction)
    return result


def run(buildings: list[str], verbose: bool, quiet: bool = False) -> Counter:
    total: Counter = Counter()
    by_source: dict[str, Counter] = {}
    paths = {p.name: p for split in ("train", "dev") for p in (DATA / split).iterdir()}
    perfect = 0
    for building_id in buildings:
        path = paths[building_id]
        truth = Building.load(path)
        try:
            imported, _ = import_plans(sorted(path.glob("floor_*.svg"),
                                              key=lambda p: int(p.stem.split("_")[1])), building_id="imp")
            scores = compare(truth, imported)
        except (PlanError, StopIteration, ValueError) as error:
            total["failed"] += 1
            if not quiet:
                print(f"FAILED {building_id}: {error}")
            continue
        total.update(scores)
        by_source.setdefault(truth.info["source"], Counter()).update(scores)
        ok = all(scores[f"{key}_right" if key in ("routes", "walls", "stacked") else f"{key}_found"
                        if key in ("doors", "connectors") else "spaces_matched"] == scores[key]
                 for key in ("spaces", "doors", "connectors", "routes", "walls", "stacked")) and \
            scores["floors_aligned"] == scores["floors_to_align"]
        perfect += ok
        if (verbose or not ok) and not quiet:
            print(f"{'OK ' if ok else '-- '} {building_id:24s} " + " ".join(
                f"{k}={scores[k]}" for k in sorted(scores)))
    total["buildings"] = len(buildings)
    total["perfect"] = perfect
    print(f"\n{'source':16s} {'spaces':>10s} {'doors':>10s} {'stairs/lifts':>13s} {'floors':>8s} {'routes':>8s} "
          f"{'walls':>8s} {'labels':>10s}")
    for source, scores in sorted(by_source.items()):
        def cell(part, whole):
            return f"{scores[part] / scores[whole]:.0%}" if scores[whole] else "-"
        print(f"{source:16s} {cell('spaces_matched', 'spaces'):>10s} {cell('doors_found', 'doors'):>10s} "
              f"{cell('connectors_found', 'connectors'):>13s} {cell('floors_aligned', 'floors_to_align'):>8s} "
              f"{cell('routes_right', 'routes'):>8s} {cell('walls_right', 'walls'):>8s} "
              f"{cell('label_right', 'labelled'):>10s}")
    return total


def report(total: Counter) -> None:
    def share(part, whole):
        return f"{total[part]}/{total[whole]} ({total[part] / max(total[whole], 1):.1%})"

    print(f"\nbuildings rebuilt perfectly: {share('perfect', 'buildings')}, failed: {total['failed']}")
    print(f"spaces matched (IoU >= {IOU_MATCH}): {share('spaces_matched', 'spaces')}  "
          f"(imported {total['imported_spaces']})")
    print(f"space kind right: {share('kind_right', 'spaces_matched')}")
    print(f"room number right: {share('label_right', 'labelled')}")
    print(f"doors found: {share('doors_found', 'doors')}  (imported {total['imported_doors']})")
    print(f"stairs/lifts linked right: {share('connectors_found', 'connectors')}  "
          f"(imported {total['imported_connectors']})")
    print(f"floors lined up (within 0.1 m; not Swiss): {share('floors_aligned', 'floors_to_align')}")
    print(f"route lengths right: {share('routes_right', 'routes')}")
    print(f"shared walls right: {share('walls_right', 'walls')}")
    print(f"room above/below right: {share('stacked_right', 'stacked')}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="evals.plans")
    parser.add_argument("--holdout", action="store_true")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--verbose", action="store_true")
    arguments = parser.parse_args()
    buildings = sorted(read(HOLDOUT_LIST if arguments.holdout else BUILD_LIST))
    if arguments.limit:
        buildings = buildings[: arguments.limit]
    report(run(buildings, arguments.verbose and not arguments.holdout, quiet=arguments.holdout))


if __name__ == "__main__":
    main()
