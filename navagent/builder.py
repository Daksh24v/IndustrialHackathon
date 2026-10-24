"""A building being set up from floor plans: what the plans gave, what is still assumed, and the edits the
person makes in conversation before it is saved (Level 4). Every edit keeps a valid building.json."""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from shapely.geometry import Polygon

from navcore.engine import Building, EngineError
from navcore.plans import assemble, describe, level_from_filename, link_floors, parse_svg, scale
from navcore.resolve import find_floor, find_space, normalise

IMPORTED = Path(__file__).resolve().parent.parent / "data" / "imported"
ROOM_TYPE_WORDS = {
    "office", "meeting_room", "seminar_room", "lecture_hall", "lab", "makerspace", "library", "server_room",
    "technical_room", "lobby", "canteen", "shop", "print_room", "locker_room", "production_zone", "additive_zone",
    "assembly_zone", "warehouse_zone", "logistics_zone", "quality_lab", "kitchen", "bathroom", "toilet", "bedroom",
    "living_room", "storage", "corridor", "balcony", "stairwell", "lift", "generic_room",
}


@dataclass
class Draft:
    """The building as understood so far. `building` is a building.json dict; `notes` are open points."""

    building: dict
    notes: list[str] = field(default_factory=list)
    saved_to: Path | None = None

    @classmethod
    def from_svgs(cls, files: list[tuple[str, str]], building_id: str, name: str | None = None) -> "Draft":
        """files: (file name, SVG text); the level comes from names like floor_1.svg, else the order."""
        plans = []
        for index, (filename, text) in enumerate(files):
            level = level_from_filename(filename)
            plans.append((index if level is None else level, parse_svg(text, filename)))
        building, notes = assemble(plans, building_id, name)
        return cls(building, notes)

    def loaded(self) -> Building:
        return Building(self.building)

    def summary(self) -> dict:
        return {**describe(self.building), "open_points": self.notes}

    # ---------- edits ----------

    def set_room_type(self, rooms: list[str], room_type: str) -> dict:
        """Give rooms a type; their name becomes '<Type> <number>' (e.g. 'Office 0.21')."""
        wanted = normalise(room_type).replace(" ", "_")
        if wanted not in ROOM_TYPE_WORDS:
            raise EngineError(f"Unknown room type '{room_type}'. Use one of: {', '.join(sorted(ROOM_TYPE_WORDS))}.")
        changed = []
        building = self.loaded()
        for room in rooms:
            space = self._space(building, room)
            space["room_type"] = wanted
            space["name"] = f"{wanted.replace('_', ' ').capitalize()} {space['ref']}"
            changed.append(space["name"])
        self._resolve("Room types")
        return {"changed": changed}

    def rename(self, room: str, name: str | None = None, number: str | None = None) -> dict:
        space = self._space(self.loaded(), room)
        if number:
            old = space["ref"]
            space["ref"] = number.strip()
            space["name"] = space["name"].replace(old, space["ref"]) if old and old in space["name"] else \
                f"{space['name']} {space['ref']}"
        if name:
            space["name"] = name.strip()
        return {"space": space["id"], "name": space["name"], "number": space["ref"]}

    def set_door(self, first: str, second: str, width_m: float | None = None, step_free: bool | None = None) -> dict:
        """Change the door(s) between two spaces ('outside' for an entrance)."""
        building = self.loaded()
        ids = {"outside" if normalise(side) == "outside" else self._space(building, side)["id"] for side in (first, second)}
        doors = [opening for opening in self.building["openings"] if set(opening["space_ids"]) == ids]
        if not doors:
            raise EngineError("There's no door between those two spaces in the plan; use add_door to add one.")
        for door in doors:
            if width_m is not None:
                if not 0.3 <= width_m <= 10:
                    raise EngineError("A door width should be between 0.3 and 10 m.")
                door["width_m"] = round(width_m, 3)
            if step_free is not None:
                door["step_free"] = step_free
        return {"doors": [door["id"] for door in doors], "width_m": width_m, "step_free": step_free}

    def set_all_doors(self, width_m: float, between_types: list[str] | None = None) -> dict:
        """Set the width of every door, or of every door touching a space of the given room types."""
        spaces = {space["id"]: space for space in self.building["spaces"]}
        types = {normalise(t).replace(" ", "_") for t in between_types or []}
        changed = 0
        for door in self.building["openings"]:
            touching = {spaces[s]["room_type"] for s in door["space_ids"] if s in spaces}
            if not types or touching & types:
                door["width_m"] = round(width_m, 3)
                changed += 1
        self._resolve("Door widths")
        return {"doors_changed": changed, "width_m": width_m}

    def add_door(self, first: str, second: str, width_m: float = 0.9) -> dict:
        building = self.loaded()
        a, b = self._space(building, first)["id"], self._space(building, second)["id"]
        door = building.door_between(a, b)
        door.update(id=f"{door['floor_id']}-O-added{len(self.building['openings']) + 1}", width_m=width_m,
                    synthetic=False)
        self.building["openings"].append(door)
        return {"added": door["id"], "position": door["position"]}

    def mark_stairs(self, spaces: list[str], kind: str = "stairs", name: str | None = None) -> dict:
        """Say which spaces (one per floor) form one staircase or lift, for plans that don't mark them."""
        building = self.loaded()
        chain = sorted((self._space(building, room) for room in spaces),
                       key=lambda space: building.level(space["floor_id"]))
        if len(chain) < 2 or len({space["floor_id"] for space in chain}) != len(chain):
            raise EngineError("Give one space per floor, on at least two floors.")
        if kind not in ("stairs", "lift"):
            raise EngineError("kind must be 'stairs' or 'lift'.")
        for space in chain:
            space["type"] = "lift" if kind == "lift" else "stair"
            space["room_type"] = "lift" if kind == "lift" else "stairwell"
        connector = {
            "id": f"{self.building['building']['id']}-V{len(self.building['vertical_connectors']) + 1:02d}",
            "kind": kind, "name": name or f"{'Lift' if kind == 'lift' else 'Stairs'} "
            f"{sum(1 for c in self.building['vertical_connectors'] if c['kind'] == kind) + 1}",
            "floor_ids": [space["floor_id"] for space in chain], "space_ids": [space["id"] for space in chain],
            "step_free": kind == "lift", "synthetic": False,
        }
        self.building["vertical_connectors"].append(connector)
        return {"added": connector["name"], "floors": [building.floor_name(f) for f in connector["floor_ids"]]}

    def stair_candidates(self, limit: int = 4) -> list[dict]:
        """Spaces that might be stairs in plans that don't mark them: small corridors with few doors that sit
        on top of a similar space on the next floor. Only suggestions, for the person to confirm."""
        building = self.loaded()
        doors: dict[str, int] = {}
        for opening in self.building["openings"]:
            for space_id in opening["space_ids"]:
                doors[space_id] = doors.get(space_id, 0) + 1
        found = []
        for space in self.building["spaces"]:
            if space["type"] != "corridor" or doors.get(space["id"], 0) > 3:
                continue
            area = building.area(space["id"])
            above = building.stacked_room(space["id"], "above")
            if above and area <= 8 and building.spaces[above]["type"] == "corridor":
                found.append({"space": building.label(space["id"]), "above": building.label(above),
                              "area_m2": round(area, 1)})
        return sorted(found, key=lambda item: item["area_m2"])[:limit]

    def set_floor_height(self, floor: str, height_m: float) -> dict:
        building = self.loaded()
        floor_id = find_floor(building, floor)
        if not 1.5 <= height_m <= 30:
            raise EngineError("A floor height should be between 1.5 and 30 m.")
        for item in self.building["floors"]:
            if item["id"] == floor_id:
                item["height_m"] = height_m
        self._restack()
        self._resolve("Floor heights")
        return {"floors": [{"name": f["name"], "elevation_m": f["elevation_m"]}
                           for f in sorted(self.building["floors"], key=lambda f: f["level"])]}

    def set_known_length(self, room: str, length_m: float, side: str = "longest") -> dict:
        """Correct the scale from one length the person knows ('room 0.21 is 6 m long')."""
        building = self.loaded()
        space = self._space(building, room)
        x0, y0, x1, y1 = Polygon(space["polygon"]).bounds
        measured = {"longest": max(x1 - x0, y1 - y0), "shortest": min(x1 - x0, y1 - y0),
                    "width": x1 - x0, "depth": y1 - y0}.get(side)
        if measured is None or measured <= 0:
            raise EngineError("side must be longest, shortest, width or depth.")
        factor = length_m / measured
        scale(self.building, factor)
        return {"scaled_by": round(factor, 4), "summary": describe(self.building)}

    def relink_floors(self) -> dict:
        self.building["vertical_connectors"] = link_floors(self.building["floors"], self.building["spaces"])
        return {"stairs_and_lifts": [c["name"] for c in self.building["vertical_connectors"]]}

    def save(self, name: str | None = None, directory: Path | None = None) -> Path:
        if name:
            self.building["building"]["name"] = name.strip()
        Building(self.building)  # must load: fails loudly rather than saving something broken
        slug = re.sub(r"[^a-z0-9]+", "-", self.building["building"]["id"].lower()).strip("-") or "imported"
        target = (directory or IMPORTED) / slug
        target.mkdir(parents=True, exist_ok=True)
        (target / "building.json").write_text(json.dumps(self.building, ensure_ascii=False, indent=1),
                                              encoding="utf-8")
        self.saved_to = target
        return target

    # ---------- helpers ----------

    def _space(self, building: Building, words: str) -> dict:
        space_id = find_space(building, words)
        return next(space for space in self.building["spaces"] if space["id"] == space_id)

    def _resolve(self, prefix: str) -> None:
        self.notes = [note for note in self.notes if not note.startswith(prefix)]

    def _restack(self) -> None:
        floors = sorted(self.building["floors"], key=lambda f: f["level"])
        ground = min(range(len(floors)), key=lambda i: (abs(floors[i]["level"]), floors[i]["level"]))
        running = 0.0
        for floor in floors[ground:]:
            floor["elevation_m"] = round(running, 3)
            running += floor["height_m"]
        running = 0.0
        for floor in reversed(floors[:ground]):
            running -= floor["height_m"]
            floor["elevation_m"] = round(running, 3)

