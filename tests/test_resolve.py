"""Names people use -> ids."""

import pytest

from navcore.engine import Building, EngineError
from navcore.resolve import AmbiguousSpace, find_element, find_floor, find_space, find_type


def test_floors(tiny: Building):
    assert find_floor(tiny, "the ground floor") == "T-F0"
    assert find_floor(tiny, "Floor 1") == "T-F1"
    assert find_floor(tiny, "level 1") == "T-F1"
    with pytest.raises(EngineError):
        find_floor(tiny, "basement 2")


def test_spaces(tiny: Building):
    assert find_space(tiny, "Office 0.01 (Ground floor)") == "T-F0-S1"
    assert find_space(tiny, "office 1.01") == "T-F1-S1"
    assert find_space(tiny, "0.02") == "T-F0-S2"
    assert find_space(tiny, "T-F0-S0") == "T-F0-S0"
    with pytest.raises(EngineError):
        find_space(tiny, "Office 9.99")


def test_name_with_parentheses_is_not_mistaken_for_a_floor(tiny: Building):
    tiny.spaces["T-F0-S1"]["name"] = "Bedroom 0.01 (apartment 1)"
    assert find_space(tiny, "Bedroom 0.01 (apartment 1) (Ground floor)") == "T-F0-S1"


def test_same_name_twice_is_ambiguous(tiny: Building):
    tiny.spaces["T-F0-S2"]["name"] = "Office 0.01"
    tiny.spaces["T-F0-S2"]["ref"] = None
    with pytest.raises(AmbiguousSpace) as error:
        find_space(tiny, "Office 0.01 (Ground floor)")
    assert error.value.candidates == ["T-F0-S1", "T-F0-S2"]


def test_types_and_elements(tiny: Building):
    assert find_type("generic room", {"generic_room", "office"}) == "generic_room"
    assert find_type("offices", {"generic_room", "office"}) == "office"
    assert find_element(tiny, "Lift 1") == "T-V-lift"
    assert find_element(tiny, "stairs 1") == "T-V-stairs"
