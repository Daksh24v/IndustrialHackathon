"""Turn the words people use ("Garderobe A (Floor 1)", "the floor 2", "fire extinguisher", "Lift 2")
into ids in one building.

Exact first: an id, "Name (Floor name)", the full name or the room number. The scored questions always use
these, so their answers never depend on anything below. Only when nothing matches exactly do the forgiving
steps run, in this order:
- accents, case and little words: "Buero", "the quality lab", "room 0.21";
- the name without its number or apartment: "Quality lab", "Kitchen 1.01" for "Kitchen 1.01 (apartment 3)";
- a typo is never taken: it comes back as "did you mean" suggestions, so the agent checks with the person.
Floors also accept "first floor", "2nd floor", "EG", "OG 1", "UG", "basement", "top floor" and a bare
number; types accept a few everyday words (WC, elevator, AED, copier) and part of the name ("extinguisher").
"""

import difflib
import re
import unicodedata

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
        self.words = words
        self.candidates = candidates


class NoSuchSpace(EngineError):
    """Nothing is called that; `suggestions` are close names (typos), never taken without asking."""

    def __init__(self, message: str, suggestions: list[str]) -> None:
        super().__init__(message)
        self.suggestions = suggestions


FLOOR_SUFFIX = re.compile(r"^(?P<name>.+)\s+\((?P<floor>[^()]+)\)\s*$")
TRAILING_BRACKETS = re.compile(r"\s*\([^()]*\)\s*$")  # "(apartment 3)"
LITTLE_WORDS = re.compile(r"^(?:the|a|an|my|our|der|die|das|den|dem)\s+")
ROOM_WORDS = re.compile(r"^(?:room|raum|zimmer|rm|no|nr|number)\b\.?\s*")
TYPO_CUTOFF = 0.8
MAX_SUGGESTIONS = 4

ORDINALS = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6, "seventh": 7,
            "eighth": 8, "ninth": 9, "tenth": 10}
GROUND_WORDS = {"ground", "ground floor", "groundfloor", "ground level", "street level", "eg", "erdgeschoss",
                "parterre", "level 0", "floor 0"}
BASEMENT_WORDS = {"basement", "the basement", "cellar", "ug", "kg", "untergeschoss", "kellergeschoss", "keller"}
TOP_WORDS = {"top floor", "top", "highest floor", "top level", "roof floor"}
BOTTOM_WORDS = {"bottom floor", "lowest floor", "bottom level", "lowest level"}

# Everyday words for types, tried only when the type's own name doesn't match; the first one the building
# has wins. Generic words only: nothing here is about one building.
TYPE_WORDS = {
    "wc": ["toilet", "bathroom"], "loo": ["toilet", "bathroom"], "restroom": ["toilet", "bathroom"],
    "lavatory": ["toilet", "bathroom"], "washroom": ["toilet", "bathroom"], "toilette": ["toilet"],
    "klo": ["toilet"], "elevator": ["lift"], "aufzug": ["lift"], "aed": ["defibrillator"],
    "copier": ["multifunction_printer", "printer"], "photocopier": ["multifunction_printer", "printer"],
    "refrigerator": ["fridge"], "kuhlschrank": ["fridge"], "coffee maker": ["coffee_machine"],
    "espresso machine": ["coffee_machine"], "kaffeemaschine": ["coffee_machine"],
    "water cooler": ["water_dispenser"], "water fountain": ["water_dispenser"],
    "stairs": ["stairwell", "internal_stairs"], "staircase": ["stairwell", "internal_stairs"],
    "treppe": ["stairwell"], "treppenhaus": ["stairwell"], "reception": ["lobby", "reception_desk"],
    "foyer": ["lobby"], "entrance hall": ["lobby"], "kitchenette": ["kitchen"], "kuche": ["kitchen"],
    "buro": ["office"], "labor": ["lab"], "laboratory": ["lab"], "besprechungsraum": ["meeting_room"],
    "conference room": ["meeting_room"], "lager": ["storage"], "storeroom": ["storage"],
    "horsaal": ["lecture_hall"], "auditorium": ["lecture_hall"], "bin": ["waste_basket"],
    "trash can": ["waste_basket"], "tv": ["display_screen", "tv_stand"],
}
LIFT_WORDS = {"lift", "elevator", "aufzug", "fahrstuhl"}
STAIR_WORDS = {"stairs", "staircase", "stairway", "stairwell", "treppe", "treppenhaus"}


def normalise(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("_", " ")).strip().lower()


def fold(text: str) -> str:
    """For forgiving comparisons: no accents, ß -> ss, 'ue' = 'ü' (Buero = Büro), no little words."""
    text = unicodedata.normalize("NFKD", normalise(text).replace("ß", "ss"))
    text = "".join(char for char in text if not unicodedata.combining(char))
    text = text.replace("ae", "a").replace("oe", "o").replace("ue", "u")
    return LITTLE_WORDS.sub("", text).strip()


def find_floor(building: Building, words: str) -> str:
    """'the floor 2', 'ground floor', 'Basement 1', 'level 3', 'first floor', 'EG', 'OG 2', a floor id ..."""
    if words in building.floors:
        return words
    text = normalise(words)
    text = re.sub(r"^(on |in |at )?(the )?", "", text)
    for floor_id, floor in building.floors.items():
        if normalise(floor["name"]) == text:
            return floor_id
    levels = sorted({floor["level"] for floor in building.floors.values()})
    match = re.fullmatch(r"(?:floor|level|etage|stock|og|obergeschoss)\s*(-?\d+)", text) or re.fullmatch(
        r"(-?\d+)(?:st|nd|rd|th|\.)?\s*(?:floor|level|etage|stock|og|obergeschoss)?", text)
    if match:
        return building.floor_by_level(int(match.group(1)))
    match = re.fullmatch(r"(\w+) (?:floor|level)", text)
    if match and match.group(1) in ORDINALS:
        return building.floor_by_level(ORDINALS[match.group(1)])
    match = re.fullmatch(r"(?:basement|ug|kg|untergeschoss)\s*(?:level\s*)?(\d+)", text)
    if match:
        return building.floor_by_level(-int(match.group(1)))
    if text in GROUND_WORDS:
        return building.floor_by_level(0)
    below = [level for level in levels if level < 0]
    if text in BASEMENT_WORDS:
        if len(below) == 1:
            return building.floor_by_level(below[0])
        if below:
            names = ", ".join(building.floor_name(building.floor_by_level(level)) for level in reversed(below))
            raise EngineError(f"'{words}': this building has several basements ({names}); which one?")
    if text in TOP_WORDS:
        return building.floor_by_level(levels[-1])
    if text in BOTTOM_WORDS:
        return building.floor_by_level(levels[0])
    raise EngineError(f"No floor called '{words}'. Floors: "
                      + ", ".join(building.floor_name(building.floor_by_level(level)) for level in levels) + ".")


def space_forms(space: dict) -> tuple[set[str], str]:
    """Forgiving forms of a space's name: (full forms, the bare name without number and brackets)."""
    name, ref = space["name"], space.get("ref") or ""
    without_brackets = TRAILING_BRACKETS.sub("", name)
    full = {fold(name), fold(without_brackets)}
    if ref:  # "Büro 1.01" and "Büro (1.01)" for a room named "Büro" with number 1.01
        full |= {fold(ref), fold(f"{without_brackets} {ref}"), fold(f"{without_brackets} ({ref})")}
    bare = without_brackets
    if ref:
        bare = re.sub(rf"(?<!\S){re.escape(ref)}(?!\S)", " ", bare)
    return full, fold(bare)


def find_space(building: Building, words: str, floor_id: str | None = None) -> str:
    """A space by id, 'Name (Floor name)', name, or room ref; forgiving steps only when nothing is exact."""
    words = words.strip()
    if words in building.spaces:
        return words
    match = FLOOR_SUFFIX.match(words)
    missed_on_floor = None
    if match and floor_id is None:
        try:
            return find_space(building, match.group("name"), find_floor(building, match.group("floor")))
        except AmbiguousSpace as error:
            raise AmbiguousSpace(words, error.candidates, building) from None  # report the name as given
        except NoSuchSpace as error:
            missed_on_floor = error  # unless the whole text is a name, e.g. "Hall (Ground floor)"
        except EngineError:
            pass  # the parentheses were part of the name, e.g. "Bedroom 3.10 (apartment 14)"
    on_floor = [space for space in building.spaces.values() if floor_id is None or space["floor_id"] == floor_id]
    text = normalise(words)
    candidates = [space for space in on_floor if text in (normalise(space["name"]), normalise(space.get("ref") or ""))]
    if len(candidates) == 1:
        return candidates[0]["id"]
    if len(candidates) > 1:
        # Prefer an exact name over a ref match.
        by_name = [space for space in candidates if normalise(space["name"]) == text]
        if len(by_name) == 1:
            return by_name[0]["id"]
        raise AmbiguousSpace(words, sorted(space["id"] for space in candidates), building)
    found = forgiving(on_floor, words)
    if len(found) == 1:
        return found[0]
    if len(found) > 1:
        raise AmbiguousSpace(words, sorted(found), building)
    if missed_on_floor is not None:
        raise NoSuchSpace(f"No space called '{words}'." + did_you_mean(building, missed_on_floor.suggestions),
                          missed_on_floor.suggestions)
    where = f" on {building.floor_name(floor_id)}" if floor_id else ""
    suggestions = typo_suggestions(on_floor, words)
    raise NoSuchSpace(f"No space called '{words}'{where}." + did_you_mean(building, suggestions), suggestions)


def forgiving(spaces: list[dict], words: str) -> list[str]:
    """Spaces matching after folding accents and little words, then by the bare name ('Quality lab')."""
    text = fold(words)
    texts = {text, ROOM_WORDS.sub("", text).strip()} - {""}
    forms = [(space["id"], *space_forms(space)) for space in spaces]
    full = [space_id for space_id, full_forms, _ in forms if texts & full_forms]
    if full:
        return full
    return [space_id for space_id, _, bare in forms if bare and bare in texts]


def typo_suggestions(spaces: list[dict], words: str) -> list[str]:
    by_form: dict[str, list[str]] = {}
    for space in spaces:
        full, bare = space_forms(space)
        for form in full | {bare}:
            by_form.setdefault(form, []).append(space["id"])
    close = difflib.get_close_matches(fold(words), list(by_form), n=MAX_SUGGESTIONS, cutoff=TYPO_CUTOFF)
    suggestions: list[str] = []
    for form in close:
        for space_id in by_form[form]:
            if space_id not in suggestions:
                suggestions.append(space_id)
    return suggestions[:MAX_SUGGESTIONS]


def did_you_mean(building: Building, suggestions: list[str]) -> str:
    if not suggestions:
        return " Search with fewer words, or ask the person."
    names = "; ".join(f"{space_id} = {building.label(space_id)}" for space_id in suggestions)
    return f" Did you mean: {names}? Check with the person before using one."


def room_types(building: Building) -> set[str]:
    return {space["room_type"] for space in building.spaces.values()}


def asset_types(building: Building) -> set[str]:
    return {asset["type"] for asset in building.assets.values()}


def asset_names(building: Building) -> dict[str, str]:
    """Display names of things without their number ('Air compressor H-C1' -> 'air compressor') -> type."""
    names = {}
    for asset in building.assets.values():
        words = [word for word in normalise(asset["name"]).split() if not re.search(r"\d", word)]
        if words:
            names.setdefault(fold(" ".join(words)), asset["type"])
    return names


def find_type(words: str, known: set[str], names: dict[str, str] | None = None) -> str:
    """'generic room' -> generic_room, 'fire extinguisher' -> fire_extinguisher (also plural forms); then
    everyday words ('WC'), display names ('air compressor') and part of a type's name ('extinguisher')."""
    text = normalise(words)
    by_words = {normalise(item): item for item in known}
    for candidate in (text, text.rstrip("s"), re.sub(r"es$", "", text)):
        if candidate in by_words:
            return by_words[candidate]
    folded = fold(text)
    singular = [folded, folded.rstrip("s"), re.sub(r"es$", "", folded)]
    for candidate in singular:
        for target in TYPE_WORDS.get(candidate, []):
            if target in known:
                return target
        if names and candidate in names and names[candidate] in known:
            return names[candidate]
    query = [re.sub(r"(es|s)$", "", word) for word in folded.split()]
    partial = sorted(item for item in known if all(any(part.startswith(word) for part in fold(item).split())
                                                    for word in query))
    if len(partial) == 1:
        return partial[0]
    if partial:
        raise EngineError(f"'{words}' could be several types: {', '.join(partial[:10])}. Which one?")
    raise EngineError(f"Unknown type '{words}'. Known: {', '.join(sorted(known)[:40])}.")


def find_element(building: Building, words: str) -> str:
    """A lift, staircase, door or space that can be closed: id or name ('the lift' when there is one)."""
    if words in building.connectors or words in building.openings or words in building.spaces:
        return words
    text = normalise(words)
    named = [connector["id"] for connector in building.connectors.values() if normalise(connector["name"]) == text]
    if len(named) == 1:
        return named[0]
    if len(named) > 1:
        raise EngineError(f"'{words}' is ambiguous: {', '.join(named)}.")
    generic = fold(text)
    kind = "lift" if generic in LIFT_WORDS else "stairs" if generic in STAIR_WORDS else None
    if kind:
        of_kind = [connector for connector in building.connectors.values() if connector["kind"] == kind]
        if len(of_kind) == 1:
            return of_kind[0]["id"]
        if of_kind:
            raise EngineError(f"'{words}': there are {len(of_kind)}: "
                              + ", ".join(f"{c['id']} = {c['name']}" for c in of_kind[:10]) + ". Which one?")
    return find_space(building, words)
