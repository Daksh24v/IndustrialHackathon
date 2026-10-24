"""Deterministic answering for benchmark-style questions.

parse() recognises a question's wording and returns its kind plus the resolved inputs (ids), in the same
shape as the `inputs` field of the train/dev questions. solve() computes the answer with the engine and
writes a reply that ends with the 'Answer:' line the scorer reads. Anything parse() doesn't recognise is
left to the Claude agent (navagent), which uses the same engine through tools."""

import itertools
import re
from collections import Counter
from dataclasses import dataclass

from navcore.engine import Building, Constraints, EngineError
from navcore.resolve import AmbiguousSpace, asset_types, find_element, find_floor, find_space, find_type, room_types

NAME = r"(?P<{}>.+?\([^()]+\))"  # "Office 1.14 (Floor 1)"; the name itself may hold parentheses
FLOOR = r"(?:the )?(?P<{}>ground floor|floor -?\d+|basement \d+|[\w .-]+?)"


def pattern(text: str) -> re.Pattern:
    return re.compile(text, flags=re.IGNORECASE | re.DOTALL)


TEMPLATES = {
    "largest_room": pattern(rf"which is the largest (?P<room_type>.+?) on {FLOOR.format('floor')}, and how big"),
    "floor_area_total": pattern(
        rf"total floor area of every (?P<room_type>.+?) on {FLOOR.format('floor')} added together"
    ),
    "errand": pattern(
        rf"i'm in {NAME.format('start')}\. I need to grab an? (?P<asset_type>.+?) from the room that has one "
        rf"closest to me, then carry it to the largest (?P<room_type>.+?) on {FLOOR.format('floor')}\. "
        r"I (?P<stairs>can|can't|cannot|can not) carry it on the stairs"
    ),
    "wide_delivery_count": pattern(
        r"moving an? (?P<width>\d+(?:\.\d+)?) m wide .*?arrives through the entrance into "
        rf"{NAME.format('start')}\. Into how many rooms on {FLOOR.format('floor')} can it be delivered"
    ),
    "step_free_reachable_count": pattern(
        r"^(?P<closed>.+?) is out of service\. A wheelchair user comes in through the entrance into "
        rf"{NAME.format('start')}\. How many rooms on {FLOOR.format('floor')} can they still reach"
    ),
    "room_stacked_above": pattern(rf"dripping from the ceiling in {NAME.format('start')}\. Which room is directly above"),
    "room_stacked_below": pattern(rf"leaking onto the floor of {NAME.format('start')}\. Which room directly below"),
    "shared_walls_count": pattern(rf"soundproofing {NAME.format('start')}\. How many other rooms on that floor share"),
    "straight_line_3d": pattern(
        rf"between {NAME.format('first')} and {NAME.format('second')}\. What is the straight-line distance"
    ),
    "what_if_door": pattern(
        rf"add a door between {NAME.format('first')} and {NAME.format('second')}, in the middle of the wall they "
        rf"share\? How many rooms on {FLOOR.format('floor')} would then have a shorter walk out"
    ),
}


@dataclass
class Parsed:
    kind: str
    inputs: dict


def parse(building: Building, question: str) -> Parsed | None:
    """Recognise the question and resolve every name to an id. None if the wording is unknown.
    When a named room exists more than once this is the first reading; see parse_all."""
    alternatives = parse_all(building, question)
    return alternatives[0] if alternatives else None


def candidates(building: Building, words: str) -> list[str]:
    try:
        return [find_space(building, words)]
    except AmbiguousSpace as error:
        return error.candidates


def parse_all(building: Building, question: str) -> list[Parsed]:
    """Every reading of the question: one, or one per combination of same-named rooms."""
    question = " ".join(question.replace("\u2019", "'").split())
    for key, regex in TEMPLATES.items():
        match = regex.search(question)
        if not match:
            continue
        found = match.groupdict()
        kind = "room_stacked" if key.startswith("room_stacked") else key
        inputs: dict = {}
        named = [key for key in ("start", "first", "second") if key in found]
        if "floor" in found:
            inputs["floor_id"] = find_floor(building, found["floor"])
        if "room_type" in found:
            inputs["room_type"] = find_type(found["room_type"], room_types(building))
        if "asset_type" in found:
            inputs["asset_type"] = find_type(found["asset_type"], asset_types(building))
        if "stairs" in found:
            inputs["step_free"] = found["stairs"].lower() != "can"
        if "width" in found:
            inputs["min_width"] = float(found["width"])
        if "closed" in found:
            inputs["closed"] = find_element(building, found["closed"])
        if kind == "room_stacked":
            inputs["direction"] = key.removeprefix("room_stacked_")
        readings = []
        for choice in itertools.product(*(candidates(building, found[key]) for key in named)):
            reading = {**inputs, **dict(zip(named, choice, strict=True))}
            if kind == "what_if_door":
                reading["door_floor_id"] = building.spaces[reading["first"]]["floor_id"]
            readings.append(Parsed(kind, reading))
        return readings
    return []


def room_answer(building: Building, space_id: str) -> str:
    """How to name a room in an answer line: its full name, which normally contains the ref."""
    space = building.spaces[space_id]
    ref = space.get("ref")
    name = space["name"]
    return name if not ref or ref in name else f"{name} ({ref})"


def solve(building: Building, parsed: Parsed) -> str:
    """Compute the answer and write a short reply ending with the 'Answer:' line."""
    inputs = parsed.inputs
    kind = parsed.kind
    if kind == "largest_room":
        space_id, area = building.largest_room(inputs["floor_id"], inputs["room_type"])
        return (
            f"The largest {inputs['room_type'].replace('_', ' ')} on {building.floor_name(inputs['floor_id'])} is "
            f"{building.label(space_id)}.\nAnswer: {room_answer(building, space_id)}, {area:.2f} m²"
        )
    if kind == "floor_area_total":
        rooms = building.rooms_of_type(inputs["floor_id"], inputs["room_type"])
        total = building.floor_area_total(inputs["floor_id"], inputs["room_type"])
        return f"I added up {len(rooms)} rooms.\nAnswer: {total:.2f}"
    if kind == "errand":
        target, _ = building.largest_room(inputs["floor_id"], inputs["room_type"])
        constraints = Constraints(step_free=inputs["step_free"])
        via, total = building.errand(inputs["start"], inputs["asset_type"], target, constraints)
        return (
            f"Nearest room with a {inputs['asset_type'].replace('_', ' ')}: {building.label(via)}; then to "
            f"{building.label(target)}.\nAnswer: {total:.2f}"
        )
    if kind == "wide_delivery_count":
        constraints = Constraints(step_free=True, min_width_m=inputs["min_width"])
        rooms = building.reachable_rooms(inputs["start"], inputs["floor_id"], constraints)
        return f"Reachable rooms: {len(rooms)}.\nAnswer: {len(rooms)}"
    if kind == "step_free_reachable_count":
        constraints = Constraints(step_free=True, closed=frozenset([inputs["closed"]]))
        rooms = building.reachable_rooms(inputs["start"], inputs["floor_id"], constraints)
        return f"Step-free reachable rooms: {len(rooms)}.\nAnswer: {len(rooms)}"
    if kind == "room_stacked":
        other = building.stacked_room(inputs["start"], inputs["direction"])
        if other is None:
            raise EngineError(f"Nothing {inputs['direction']} {building.label(inputs['start'])}.")
        return f"Directly {inputs['direction']}: {building.label(other)}.\nAnswer: {room_answer(building, other)}"
    if kind == "shared_walls_count":
        neighbours = building.wall_neighbours(inputs["start"])
        return f"Rooms sharing a wall: {len(neighbours)}.\nAnswer: {len(neighbours)}"
    if kind == "straight_line_3d":
        distance = building.straight_line_3d(inputs["first"], inputs["second"])
        return f"Centroid to centroid in 3D.\nAnswer: {distance:.2f}"
    if kind == "what_if_door":
        improved = building.what_if_door(inputs["first"], inputs["second"], inputs["floor_id"])
        return f"Rooms with a shorter way out: {len(improved)}.\nAnswer: {len(improved)}"
    raise EngineError(f"Unknown question kind {kind}.")


def answer_line(reply: str) -> str:
    return reply.rsplit("Answer:", 1)[-1].strip()


def answer_deterministic(building: Building, question: str) -> str | None:
    """The reply for a recognised question, or None. With same-named rooms, every reading is solved and
    the most common answer wins (ties: the reading with the lowest space ids)."""
    replies = []
    for parsed in parse_all(building, question):
        try:
            replies.append(solve(building, parsed))
        except EngineError:
            continue
    if not replies:
        return None
    if len(replies) == 1:
        return replies[0]
    votes = Counter(answer_line(reply) for reply in replies)
    best = votes.most_common(1)[0][0]  # ties keep insertion order, i.e. the lowest ids
    reply = next(reply for reply in replies if answer_line(reply) == best)
    return f"(The room name matches {len(replies)} rooms on that floor; {votes[best]} of them give this answer.)\n{reply}"
