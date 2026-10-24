"""The benchmark entry point: answer(building_directory, question_text) -> full reply.

Recognised question wordings are answered by navcore directly (exact, free, instant). Anything else goes
to the Claude agent, which reaches the same engine through tools. Set NAVAGENT_OFFLINE=1 to never call
the API (unrecognised questions then get a reply without an Answer line)."""

import os
from functools import lru_cache
from pathlib import Path

from navcore.engine import Building, EngineError
from navcore.questions import answer_deterministic

OFFLINE_ENVIRONMENT_VARIABLE = "NAVAGENT_OFFLINE"


@lru_cache(maxsize=8)
def load_building(building_directory: str) -> Building:
    return Building.load(Path(building_directory))


def answer(building_directory: Path, question_text: str) -> str:
    building = load_building(str(building_directory))
    try:
        reply = answer_deterministic(building, question_text)
    except EngineError:
        reply = None
    if reply is not None:
        return reply
    if os.environ.get(OFFLINE_ENVIRONMENT_VARIABLE):
        return "I could not match this question to a known pattern (offline mode, no agent)."
    from navagent.agent import BuildingAgent
    from navagent.tools import Session

    # A fresh Building: the agent may edit its session, which must not leak into the cached one.
    return BuildingAgent(Session(Building.load(Path(building_directory)))).ask(question_text)
