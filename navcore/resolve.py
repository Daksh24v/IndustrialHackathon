"""Turn the words people use ("Garderobe A (Floor 1)", "the floor 2", "fire extinguisher", "Lift 2")
into ids in one building."""

import re

from navcore.engine import Building, EngineError


class AmbiguousSpace(EngineError):
    """Several spaces carry the same name on one floor (OSM has e.g. three rooms called 'Büro')."""

    def __init__(self, words: str, candidates: list[str], building: Building | None = None) -> None:
        if building is None:
            listed = ", ".join(candidates[:10])
        else:
            listed = "; ".join(
                f"{space_id} = {building.label(space_id)}, {building.area(space_id):.1f} m²"
                for space_id in candidates[:10]
            )
        super().__init__(f"'{words}' matches {len(candidates)} spaces: {listed}. Pass one of these ids.")
        self.candidates = candidates


FLOOR_SUFFIX = re.compile(r"^(?P<name>.+)\s+\((?P<floor>[^()]+)\)\s*$")


def normalise(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("_", " ")).strip().lower()


def find_floor(building: Building, words: str) -> str:
    """'the floor 2', 'ground floor', 'Basement 1', 'level 3', a floor id ..."""
    if words in building.floors:
        return words
    text = normalise(words)
    text = re.sub(r"^(on |in )?(the )?", "", text)
    for floor_id, floor in building.floors.items():
        if normalise(floor["name"]) == text:
            return floor_id
    match = re.fullmatch(r"(?:floor|level)\s*(-?\d+)", text)
    if match:
        return building.floor_by_level(int(match.group(1)))
    match = re.fullmatch(r"basement\s*(\d+)", text)
    if match:
        return building.floor_by_level(-int(match.group(1)))
    if text in {"ground floor", "ground", "floor 0", "level 0"}:
        return building.floor_by_level(0)
    raise EngineError(f"No floor called '{words}'.")


def find_space(building: Building, words: str, floor_id: str | None = None) -> str:
    """A space by id, 'Name (Floor name)', name, or room ref."""
    words = words.strip()
    if words in building.spaces:
        return words
    match = FLOOR_SUFFIX.match(words)
    if match and floor_id is None:
        try:
            return find_space(building, match.group("name"), find_floor(building, match.group("floor")))
        except AmbiguousSpace:
            raise
        except EngineError:
            pass  # the parentheses were part of the name, e.g. "Bedroom 3.10 (apartment 14)"
    text = normalise(words)
    candidates = [
        space
        for space in building.spaces.values()
        if (floor_id is None or space["floor_id"] == floor_id)
        and text in (normalise(space["name"]), normalise(space.get("ref") or ""))
    ]
    if len(candidates) == 1:
        return candidates[0]["id"]
    if len(candidates) > 1:
        # Prefer an exact name over a ref match.
        by_name = [space for space in candidates if normalise(space["name"]) == text]
        if len(by_name) == 1:
            return by_name[0]["id"]
        raise AmbiguousSpace(words, sorted(space["id"] for space in candidates), building)
    raise EngineError(f"No space called '{words}'" + (f" on {building.floor_name(floor_id)}." if floor_id else "."))


def room_types(building: Building) -> set[str]:
    return {space["room_type"] for space in building.spaces.values()}


def asset_types(building: Building) -> set[str]:
    return {asset["type"] for asset in building.assets.values()}


def find_type(words: str, known: set[str]) -> str:
    """'generic room' -> generic_room, 'fire extinguisher' -> fire_extinguisher (also plural forms)."""
    text = normalise(words)
    by_words = {normalise(item): item for item in known}
    for candidate in (text, text.rstrip("s"), re.sub(r"es$", "", text)):
        if candidate in by_words:
            return by_words[candidate]
    raise EngineError(f"Unknown type '{words}'. Known: {', '.join(sorted(known)[:40])}.")


def find_element(building: Building, words: str) -> str:
    """A lift, staircase, door or space that can be closed: id or name."""
    if words in building.connectors or words in building.openings or words in building.spaces:
        return words
    text = normalise(words)
    named = [connector["id"] for connector in building.connectors.values() if normalise(connector["name"]) == text]
    if len(named) == 1:
        return named[0]
    if len(named) > 1:
        raise EngineError(f"'{words}' is ambiguous: {', '.join(named)}.")
    return find_space(building, words)
