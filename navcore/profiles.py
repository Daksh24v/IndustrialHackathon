"""How someone moves through the building: on foot, in a wheelchair, pushing a trolley or driving a forklift.
A profile sets which doors fit (door width), whether steps are allowed, which spaces it may drive through
(a forklift only uses halls, corridors and storage; an office can be its destination, never its shortcut)
and how fast it goes, for the time a route takes.

Live app only: the benchmark asks with its own constraints and never sets a profile."""

from dataclasses import dataclass

from navcore.engine import Constraints

CLEARANCE_M = 0.1  # a vehicle needs this much more than its own width to get through a door


@dataclass(frozen=True)
class Profile:
    name: str
    label: str
    door_width_m: float  # the narrowest door it gets through
    step_free: bool
    speed_mps: float
    through_types: frozenset[str] | None = None  # space types or room types it may pass through; None: any
    vehicle: bool = False  # a width given for it is the vehicle's own width (plus CLEARANCE_M)


PROFILES = {
    profile.name: profile
    for profile in (
        Profile("walk", "Walking", 0.0, False, 1.3),
        Profile("wheelchair", "Wheelchair", 0.90, True, 1.0),
        Profile("trolley", "Trolley", 0.70 + CLEARANCE_M, True, 1.0, vehicle=True),
        Profile("forklift", "Forklift", 1.6, True, 2.0, frozenset({"hall", "corridor", "storage"}), vehicle=True),
    )
}
WORDS = {"foot": "walk", "walking": "walk", "on foot": "walk", "wheel chair": "wheelchair", "cart": "trolley",
         "pallet truck": "trolley", "trolly": "trolley", "fork lift": "forklift", "forklift truck": "forklift"}


def find_profile(words: str) -> Profile:
    key = " ".join(words.lower().replace("-", " ").split())
    key = WORDS.get(key, key)
    if key not in PROFILES:
        raise ValueError(f"Unknown way of moving {words!r}: walk, wheelchair, trolley or forklift.")
    return PROFILES[key]


def door_width(profile: Profile, width_m: float | None = None) -> float:
    """The narrowest door this profile fits through: the profile's own, or a width the person gave (a
    vehicle's width plus clearance; for a wheelchair or on foot, the door width itself)."""
    if width_m is None:
        return profile.door_width_m
    return round(width_m + (CLEARANCE_M if profile.vehicle else 0.0), 3)


def apply(profile: Profile, constraints: Constraints, width_m: float | None = None) -> Constraints:
    """The constraints with this profile on top: steps, door width and the spaces it may pass through."""
    return Constraints(
        step_free=constraints.step_free or profile.step_free,
        min_width_m=max(constraints.min_width_m, door_width(profile, width_m)),
        closed=constraints.closed,
        extra_openings=constraints.extra_openings,
        through_types=profile.through_types if constraints.through_types is None else constraints.through_types,
    )
