"""Shared fixtures: a tiny hand-made building with known answers, and helpers to read the dataset."""

import json
from pathlib import Path

import pytest

from navcore.engine import Building

DATA = Path(__file__).resolve().parent.parent / "data"


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def questions(split: str, filename: str = "questions.jsonl") -> list[tuple[Path, dict]]:
    return [(path.parent, question) for path in sorted((DATA / split).glob(f"*/{filename}")) for question in read_jsonl(path)]


def square(x: float, y: float, width: float, height: float) -> list[list[float]]:
    return [[x, y], [x + width, y], [x + width, y + height], [x, y + height]]


@pytest.fixture
def tiny() -> Building:
    """Two floors (elevation 0 and 4 m).

    Ground floor:  [Office 0.01 | Corridor 0.00 | Lab 0.02]   each 4 x 4 m, side by side in x
                   entrance (with a step) into the corridor; door corridor-office 0.9 m; corridor-lab 1.2 m;
                   a stair and a lift from the corridor up to Corridor 1.00.
    Floor 1:       [Office 1.01 | Corridor 1.00]  directly above office 0.01 and corridor 0.00.
    """
    floors = [
        {"id": "T-F0", "level": 0, "name": "Ground floor", "elevation_m": 0.0, "height_m": 4.0},
        {"id": "T-F1", "level": 1, "name": "Floor 1", "elevation_m": 4.0, "height_m": 4.0},
    ]

    def space(space_id, floor_id, kind, room_type, name, ref, polygon):
        return {"id": space_id, "floor_id": floor_id, "type": kind, "room_type": room_type, "name": name,
                "ref": ref, "polygon": polygon, "synthetic": False}

    spaces = [
        space("T-F0-S1", "T-F0", "room", "office", "Office 0.01", "0.01", square(0, 0, 4, 4)),
        space("T-F0-S0", "T-F0", "corridor", "corridor", "Corridor 0.00", "0.00", square(4, 0, 4, 4)),
        space("T-F0-S2", "T-F0", "room", "lab", "Lab 0.02", "0.02", square(8, 0, 4, 4)),
        space("T-F1-S1", "T-F1", "room", "office", "Office 1.01", "1.01", square(0, 0, 4, 4)),
        space("T-F1-S0", "T-F1", "corridor", "corridor", "Corridor 1.00", "1.00", square(4, 0, 4, 4)),
    ]

    def opening(opening_id, floor_id, space_ids, position, width, step_free=True, kind="door"):
        return {"id": opening_id, "floor_id": floor_id, "space_ids": space_ids, "kind": kind,
                "position": position, "width_m": width, "step_free": step_free, "synthetic": False}

    openings = [
        opening("T-O-entrance", "T-F0", ["outside", "T-F0-S0"], [6, 0], 1.6, step_free=False, kind="entrance"),
        opening("T-O-office", "T-F0", ["T-F0-S0", "T-F0-S1"], [4, 2], 0.9),
        opening("T-O-lab", "T-F0", ["T-F0-S0", "T-F0-S2"], [8, 2], 1.2),
        opening("T-O-office1", "T-F1", ["T-F1-S0", "T-F1-S1"], [4, 2], 0.9),
    ]
    connectors = [
        {"id": "T-V-stairs", "kind": "stairs", "name": "Stairs 1", "floor_ids": ["T-F0", "T-F1"],
         "space_ids": ["T-F0-S0", "T-F1-S0"], "step_free": False, "synthetic": False},
        {"id": "T-V-lift", "kind": "lift", "name": "Lift 1", "floor_ids": ["T-F0", "T-F1"],
         "space_ids": ["T-F0-S0", "T-F1-S0"], "step_free": True, "synthetic": False},
    ]
    assets = [
        {"id": "T-A1", "name": "Fire extinguisher 0.02", "category": "equipment", "type": "fire_extinguisher",
         "space_id": "T-F0-S2", "floor_id": "T-F0", "position": [10, 2],
         "footprint": {"width_m": 0.3, "depth_m": 0.3, "rotation_deg": 0}, "source": "generated"},
    ]
    return Building({
        "building": {"id": "T", "name": "Tiny", "source": "test", "units": "m"},
        "floors": floors, "spaces": spaces, "openings": openings,
        "vertical_connectors": connectors, "assets": assets,
    })


def pytest_addoption(parser):
    parser.addoption("--train", action="store_true", help="also check against the 200 train buildings (slower)")
