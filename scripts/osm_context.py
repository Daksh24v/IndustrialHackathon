"""Bake a building's OpenStreetMap surroundings (neighbouring buildings, roads, rail, green, water) into
data/context/<building_id>.json, in the building's own frame (x right, y up, metres), so the map can draw
the neighbourhood without fetching anything at run time.

  uv run python scripts/osm_context.py proc-factory-dev-003 osm-way360544293
  uv run python scripts/osm_context.py --all

Where a building stands comes from data/context/placements.json: building_id -> {lat, lon, rotation_deg},
the geographic position of the building's local point (0, 0) and the counterclockwise turn from the local
frame to east/north. Buildings from OSM (`source: osm_indoor`) are placed automatically: our ground
footprint is fitted onto the OSM way it came from (centroid offset with principal-axis rotation in both
180-degree flips, or the frame as the dataset converter projected it, then a small local search) and the
best intersection over union is reported and saved. Everything else needs a hand-picked entry. Without a context file the server returns empty lists, so a building with
no placement keeps working unchanged.

Overpass is asked one request at a time with a User-Agent and retried with backoff. The output is derived
from OpenStreetMap and stays under the ODbL (see ATTRIBUTION.md)."""

import argparse
import hashlib
import json
import math
import sys
import time
from pathlib import Path

import httpx
from scipy.optimize import minimize
from shapely import affinity
from shapely.geometry import LineString, Point, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.geometry.polygon import orient
from shapely.ops import linemerge, polygonize, unary_union

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from navcore.engine import Building  # noqa: E402

DATA = ROOT / "data"
CONTEXT = DATA / "context"
PLACEMENTS = CONTEXT / "placements.json"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "finni-hackathon-osm-context/1.0 (one-off bake of map surroundings; static output)"
EARTH_RADIUS_M = 6_371_008.8
RADIUS_M = 500.0
SIMPLIFY_M = 0.3
OWN_BUFFER_M = 2.0
LEVEL_HEIGHT_M = 3.2
DEFAULT_HEIGHT_M = 10.0
ATTRIBUTION = "© OpenStreetMap contributors"
LICENSE = "ODbL-1.0"

ROAD_WIDTH_M = {
    "motorway": 14.0, "trunk": 12.0, "primary": 10.0, "secondary": 8.0, "tertiary": 7.0,
    "motorway_link": 6.0, "trunk_link": 6.0, "primary_link": 6.0, "secondary_link": 5.5, "tertiary_link": 5.5,
    "unclassified": 6.0, "residential": 6.0, "living_street": 5.0, "road": 5.0, "busway": 4.0,
    "service": 4.0, "track": 3.0, "pedestrian": 4.0, "cycleway": 2.0, "footway": 2.0, "path": 1.5,
    "bridleway": 1.5, "steps": 2.0,
}
RAIL_WIDTH_M = {"rail": 3.0, "light_rail": 3.0, "subway": 3.0, "narrow_gauge": 2.5, "tram": 2.5}
WATERWAY_WIDTH_M = {"river": 12.0, "canal": 8.0, "stream": 2.5, "ditch": 1.5, "drain": 1.5}
GREEN_LANDUSE = "grass|meadow|forest|recreation_ground|village_green|allotments|orchard|cemetery|greenfield"
GREEN_LEISURE = "park|garden|pitch|playground|golf_course|nature_reserve"
GREEN_NATURAL = "wood|scrub|grassland|heath|wetland"


# ---------- Overpass ----------

def overpass(query: str, cache: Path | None = None, attempts: int = 5) -> list[dict]:
    """One query, retried with backoff on rate limits, gateway timeouts and network errors."""
    if cache is not None:
        cached = cache / f"{hashlib.sha1(query.encode()).hexdigest()[:16]}.json"
        if cached.exists():
            return json.loads(cached.read_text(encoding="utf-8"))["elements"]
    delay = 10.0
    for attempt in range(1, attempts + 1):
        try:
            response = httpx.post(OVERPASS_URL, data={"data": query}, headers={"User-Agent": USER_AGENT},
                                  timeout=180)
            if response.status_code == 200:
                payload = response.json()
                if cache is not None:
                    cache.mkdir(parents=True, exist_ok=True)
                    cached.write_text(json.dumps(payload), encoding="utf-8")
                return payload["elements"]
            if response.status_code not in (429, 502, 503, 504):
                response.raise_for_status()
            problem = f"HTTP {response.status_code}"
        except (httpx.TransportError, ValueError) as error:
            problem = type(error).__name__
        if attempt == attempts:
            raise RuntimeError(f"Overpass failed {attempts} times (last: {problem})")
        print(f"  Overpass: {problem}, retrying in {delay:.0f} s", file=sys.stderr)
        time.sleep(delay)
        delay *= 2
    raise AssertionError("unreachable")


# ---------- projection ----------

class Frame:
    """Equirectangular projection around (lat, lon), then turned into the building's local frame."""

    def __init__(self, lat: float, lon: float, rotation_deg: float = 0.0) -> None:
        self.lat, self.lon, self.rotation_deg = lat, lon, rotation_deg
        self.metres_per_degree = math.radians(1) * EARTH_RADIUS_M
        self.cos_lat = math.cos(math.radians(lat))
        turn = math.radians(-rotation_deg)
        self.cos_turn, self.sin_turn = math.cos(turn), math.sin(turn)

    def local(self, lat: float, lon: float) -> tuple[float, float]:
        east = (lon - self.lon) * self.cos_lat * self.metres_per_degree
        north = (lat - self.lat) * self.metres_per_degree
        return east * self.cos_turn - north * self.sin_turn, east * self.sin_turn + north * self.cos_turn

    def geographic(self, x: float, y: float) -> tuple[float, float]:
        east = x * self.cos_turn + y * self.sin_turn
        north = -x * self.sin_turn + y * self.cos_turn
        return self.lat + north / self.metres_per_degree, self.lon + east / (self.cos_lat * self.metres_per_degree)

    def line(self, nodes: list[dict]) -> list[tuple[float, float]]:
        return [self.local(node["lat"], node["lon"]) for node in nodes if node]


# ---------- our building ----------

def building_directories() -> dict[str, Path]:
    return {path.parent.name: path.parent for path in sorted(DATA.glob("*/*/building.json"))}


def ground_footprint(directory: Path) -> tuple[BaseGeometry, dict]:
    """The ground floor's spaces merged, exactly as the server's /outline endpoint does it."""
    building = Building.load(directory)
    ground = min(building.data["floors"], key=lambda floor: floor["level"])
    merged = unary_union([building.polygons[space["id"]].buffer(0.05) for space in building.spaces_on(ground["id"])])
    merged = merged.buffer(-0.05).simplify(0.05)
    parts = [part for part in getattr(merged, "geoms", [merged]) if not part.is_empty and part.area > 0.5]
    return unary_union(parts), building.info


# ---------- fitting an OSM building's footprint onto its way ----------

def principal_angle(geometry: BaseGeometry) -> float:
    """Angle (radians) of the major principal axis, from the area's second moments (Green's theorem)."""
    area = cx = cy = xx = yy = xy = 0.0
    for polygon in getattr(geometry, "geoms", [geometry]):
        polygon = orient(polygon, 1.0)  # exterior counterclockwise, holes clockwise
        for boundary in [polygon.exterior, *polygon.interiors]:
            points = list(boundary.coords)
            for (x0, y0), (x1, y1) in zip(points, points[1:]):
                cross = x0 * y1 - x1 * y0
                area += cross / 2
                cx += (x0 + x1) * cross / 6
                cy += (y0 + y1) * cross / 6
                xx += (x0 * x0 + x0 * x1 + x1 * x1) * cross / 12
                yy += (y0 * y0 + y0 * y1 + y1 * y1) * cross / 12
                xy += (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * cross / 24
    cx, cy = cx / area, cy / area
    xx, yy, xy = xx - area * cx * cx, yy - area * cy * cy, xy - area * cx * cy
    return 0.5 * math.atan2(2 * xy, xx - yy)


def iou(first: BaseGeometry, second: BaseGeometry) -> float:
    union = first.union(second).area
    return first.intersection(second).area / union if union else 0.0


def place(footprint: BaseGeometry, rotation_deg: float, dx: float, dy: float) -> BaseGeometry:
    return affinity.translate(affinity.rotate(footprint, rotation_deg, origin=(0, 0)), dx, dy)


def fit_to_way(footprint: BaseGeometry, way: BaseGeometry) -> dict:
    """Turn and shift our footprint (local frame) onto the OSM way (east/north metres around the way's
    centroid). Candidates: the principal axes lined up with the centroids on top of each other, in all four
    quarter turns (both 180-degree flips, plus the cross axis for squarish shapes), and the frame as the
    dataset converter made it (north up, origin on the way's centroid). The best one is then nudged to the
    highest overlap, which matters when only part of a big building was mapped indoors."""
    base_turn = math.degrees(principal_angle(way) - principal_angle(footprint))
    target = way.centroid
    candidates = []
    for flip in (0.0, 180.0, 90.0, 270.0):
        turned = affinity.rotate(footprint, base_turn + flip, origin=(0, 0))
        dx, dy = target.x - turned.centroid.x, target.y - turned.centroid.y
        candidates.append(("principal_axes", base_turn + flip, dx, dy))
    candidates.append(("as_projected", 0.0, 0.0, 0.0))
    scored = [(iou(place(footprint, rotation, dx, dy), way), method, rotation, dx, dy)
              for method, rotation, dx, dy in candidates]
    principal_iou = max(score for score, method, *_ in scored if method == "principal_axes")
    start_iou, method, rotation, dx, dy = max(scored)
    result = minimize(lambda v: -iou(place(footprint, rotation + v[0], dx + v[1], dy + v[2]), way),
                      [0.0, 0.0, 0.0], method="Nelder-Mead",
                      options={"initial_simplex": [[0, 0, 0], [3, 0, 0], [0, 15, 0], [0, 0, 15]],
                               "xatol": 0.05, "fatol": 1e-5, "maxiter": 400})
    if -result.fun > start_iou:
        rotation, dx, dy = rotation + result.x[0], dx + result.x[1], dy + result.x[2]
    return {"rotation_deg": rotation % 360, "dx": dx, "dy": dy, "method": method,
            "iou_principal_axes": principal_iou, "iou": max(start_iou, -result.fun),
            "iou_ceiling": min(footprint.area, way.area) / max(footprint.area, way.area)}


def osm_placement(footprint: BaseGeometry, osm_ref: str, cache: Path | None) -> dict:
    kind, number = osm_ref[:3], osm_ref[3:]
    if kind != "way":
        raise ValueError(f"only OSM ways can be fitted, not '{osm_ref}'")
    elements = overpass(f"[out:json][timeout:60];way({number});out geom;", cache)
    nodes = elements[0]["geometry"]
    center = Polygon([(node["lon"], node["lat"]) for node in nodes]).centroid
    north_up = Frame(center.y, center.x)
    way = Polygon(north_up.line(nodes)).buffer(0)
    fit = fit_to_way(footprint, way)
    lat, lon = north_up.geographic(fit["dx"], fit["dy"])  # where our (0, 0) lands
    return {"lat": round(lat, 7), "lon": round(lon, 7), "rotation_deg": round(fit["rotation_deg"], 2),
            "fit": {"osm": osm_ref, "method": fit["method"]}
            | {key: round(fit[key], 3) for key in ("iou", "iou_principal_axes", "iou_ceiling")}}


# ---------- the neighbourhood ----------

def neighbourhood_query(lat: float, lon: float, radius_m: float) -> str:
    around = f"(around:{radius_m:.0f},{lat:.7f},{lon:.7f})"
    return f"""[out:json][timeout:120];
(
  way["building"]{around};
  relation["building"]["type"="multipolygon"]{around};
  way["highway"]{around};
  way["railway"~"^({'|'.join(RAIL_WIDTH_M)})$"]{around};
  way["landuse"~"^({GREEN_LANDUSE})$"]{around};
  relation["landuse"~"^({GREEN_LANDUSE})$"]{around};
  way["leisure"~"^({GREEN_LEISURE})$"]{around};
  relation["leisure"~"^({GREEN_LEISURE})$"]{around};
  way["natural"~"^({GREEN_NATURAL}|water)$"]{around};
  relation["natural"~"^({GREEN_NATURAL}|water)$"]{around};
  way["waterway"~"^({'|'.join(WATERWAY_WIDTH_M)}|riverbank)$"]{around};
  way["landuse"~"^(basin|reservoir)$"]{around};
);
out tags geom;"""


def area_of(element: dict, frame: Frame) -> BaseGeometry | None:
    """A closed way or a multipolygon relation as a shapely area, or None."""
    if element["type"] == "way":
        points = frame.line(element.get("geometry", []))
        if len(points) < 4 or points[0] != points[-1]:
            return None
        polygon = Polygon(points).buffer(0)
        return polygon if polygon.area > 0 else None
    outers, inners = [], []
    for member in element.get("members", []):
        if member.get("type") == "way" and member.get("geometry"):
            line = frame.line(member["geometry"])
            if len(line) >= 2:
                (inners if member.get("role") == "inner" else outers).append(LineString(line))
    if not outers:
        return None
    outer = unary_union(list(polygonize(linemerge(outers))))
    inner = unary_union(list(polygonize(linemerge(inners)))) if inners else None
    shape_ = outer.difference(inner) if inner is not None else outer
    return shape_ if shape_.area > 0 else None


def height_of(tags: dict) -> float:
    for key, scale in (("height", 1.0), ("building:height", 1.0), ("building:levels", LEVEL_HEIGHT_M)):
        value = tags.get(key, "").split(";")[0].strip().lower().removesuffix("m").strip().replace(",", ".")
        try:
            number = float(value) * scale
        except ValueError:
            continue
        if 0 < number < 400:
            return round(number, 1)
    return DEFAULT_HEIGHT_M


def underground(tags: dict) -> bool:
    return (tags.get("tunnel", "no") not in ("no", "building_passage") or tags.get("location") == "underground"
            or tags.get("indoor") not in (None, "no") or tags.get("level", "0").startswith("-")
            or tags.get("layer", "0").startswith("-"))


def ring(polygon: Polygon) -> list[list[float]]:
    return [[round(x, 1), round(y, 1)] for x, y in polygon.exterior.coords[:-1]]


def polygons_of(geometry: BaseGeometry, minimum_m2: float = 2.0) -> list[list[list[float]]]:
    geometry = geometry.simplify(SIMPLIFY_M)
    parts = [part for part in getattr(geometry, "geoms", [geometry]) if isinstance(part, Polygon)]
    return [ring(part) for part in parts if part.area >= minimum_m2 and len(part.exterior.coords) >= 4]


def lines_of(geometry: BaseGeometry, minimum_m: float = 1.0) -> list[list[list[float]]]:
    geometry = geometry.simplify(SIMPLIFY_M)
    parts = [part for part in getattr(geometry, "geoms", [geometry]) if isinstance(part, LineString)]
    return [[[round(x, 1), round(y, 1)] for x, y in part.coords] for part in parts if part.length >= minimum_m]


def neighbourhood(footprint: BaseGeometry, placement: dict, radius_m: float, cache: Path | None) -> dict:
    frame = Frame(placement["lat"], placement["lon"], placement["rotation_deg"])
    center = footprint.centroid
    center_lat, center_lon = frame.geographic(center.x, center.y)
    elements = overpass(neighbourhood_query(center_lat, center_lon, radius_m), cache)
    circle = Point(center.x, center.y).buffer(radius_m, quad_segs=32)
    ours = footprint.buffer(OWN_BUFFER_M)
    buildings, roads, green, water = [], [], [], []
    seen = set()
    for element in elements:
        key = (element["type"], element["id"])
        if key in seen:
            continue
        seen.add(key)
        tags = element.get("tags", {})
        if "building" in tags and tags["building"] != "no":
            if underground(tags):
                continue
            area = area_of(element, frame)
            if area is None or area.intersects(ours) or not area.intersects(circle):
                continue
            height = height_of(tags)
            buildings += [{"polygon": polygon, "height_m": height} for polygon in polygons_of(area.intersection(circle))]
        elif "highway" in tags or "railway" in tags:
            kind = tags.get("highway") or tags.get("railway")
            width = ROAD_WIDTH_M.get(kind) if "highway" in tags else RAIL_WIDTH_M.get(kind)
            if width is None or underground(tags) or tags.get("area") == "yes":
                continue
            points = frame.line(element.get("geometry", []))
            if len(points) < 2:
                continue
            line = LineString(points).intersection(circle).difference(footprint)
            roads += [{"line": part, "width_m": width, "kind": kind} for part in lines_of(line)]
        elif tags.get("waterway") in WATERWAY_WIDTH_M and element["type"] == "way":
            if underground(tags):
                continue
            points = frame.line(element.get("geometry", []))
            if len(points) >= 2:
                band = LineString(points).buffer(WATERWAY_WIDTH_M[tags["waterway"]] / 2, cap_style="flat")
                water += polygons_of(band.intersection(circle).difference(footprint))
        else:
            area = area_of(element, frame)
            if area is None:
                continue
            area = area.intersection(circle).difference(footprint)
            is_water = (tags.get("natural") == "water" or tags.get("waterway") == "riverbank"
                        or tags.get("landuse") in ("basin", "reservoir"))
            (water if is_water else green).extend(polygons_of(area, minimum_m2=10.0))
    buildings.sort(key=lambda item: (item["polygon"][0][0], item["polygon"][0][1]))
    return {
        "attribution": ATTRIBUTION, "license": LICENSE,
        "placement": {key: placement[key] for key in ("lat", "lon", "rotation_deg")}, "radius_m": radius_m,
        "buildings": buildings, "roads": roads, "green": green, "water": water,
    }


# ---------- command line ----------

def load_placements() -> dict:
    return json.loads(PLACEMENTS.read_text(encoding="utf-8")) if PLACEMENTS.exists() else {}


def save_placements(placements: dict) -> None:
    CONTEXT.mkdir(parents=True, exist_ok=True)
    PLACEMENTS.write_text(json.dumps(dict(sorted(placements.items())), indent=2, ensure_ascii=False) + "\n",
                          encoding="utf-8")


def bake(building_id: str, directory: Path, placements: dict, radius_m: float, cache: Path | None) -> None:
    footprint, info = ground_footprint(directory)
    osm_ref = (info.get("source_ref") or {}).get("osm") if info.get("source") == "osm_indoor" else None
    if osm_ref:
        placements[building_id] = osm_placement(footprint, osm_ref, cache)
        save_placements(placements)
        fit = placements[building_id]["fit"]
        print(f"{building_id}: fitted onto {osm_ref} ({fit['method']}), IoU {fit['iou']:.3f} "
              f"(principal axes alone {fit['iou_principal_axes']:.3f}; at most {fit['iou_ceiling']:.3f} "
              f"from the areas)")
    elif building_id not in placements:
        print(f"{building_id}: no placement in {PLACEMENTS.relative_to(ROOT)}, skipped")
        return
    context = neighbourhood(footprint, placements[building_id], radius_m, cache)
    path = CONTEXT / f"{building_id}.json"
    path.write_text(json.dumps(context, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{building_id}: {len(context['buildings'])} buildings, {len(context['roads'])} roads, "
          f"{len(context['green'])} green, {len(context['water'])} water -> {path.relative_to(ROOT)} "
          f"({path.stat().st_size // 1024} KB)")


def main() -> None:
    parser = argparse.ArgumentParser(prog="osm_context", description=__doc__.split("\n\n")[0])
    parser.add_argument("buildings", nargs="*", help="building ids (default with --all: every placed or OSM one)")
    parser.add_argument("--all", action="store_true", help="every building with a placement or an OSM source")
    parser.add_argument("--radius", type=float, default=RADIUS_M, help="metres around the building")
    parser.add_argument("--cache", type=Path, default=None, help="keep Overpass responses here for reruns")
    args = parser.parse_args()
    directories = building_directories()
    placements = load_placements()
    if args.all:
        ids = sorted(set(placements) | {building_id for building_id in directories if building_id.startswith("osm-")})
    else:
        ids = args.buildings
    if not ids:
        parser.error("name some building ids or pass --all")
    for number, building_id in enumerate(ids):
        if building_id not in directories:
            print(f"{building_id}: unknown building, skipped")
            continue
        if number:
            time.sleep(2)  # one request at a time, with a pause between buildings
        bake(building_id, directories[building_id], placements, args.radius, args.cache)


if __name__ == "__main__":
    main()
