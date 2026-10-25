"""The benchmark entry point: answer(building_directory, question_text) -> full reply.

Claude reads every question (benchmark mode) and answers with the engine's tools; the final 'Answer:'
line is written by code from its submit_answer call. With double_check, each question runs twice and a
third run breaks a disagreement."""

import os
from collections import Counter
from pathlib import Path

import anthropic

from navagent.agent import BENCHMARK, BuildingAgent
from navagent.tools import Session
from navcore.engine import Building

LOG_DIRECTORY = Path("agent_output") / "logs"
DOUBLE_CHECK_ENVIRONMENT_VARIABLE = "NAVAGENT_DOUBLE_CHECK"
CALL_TIMEOUT_S = 180  # one Claude call; a stalled one is retried instead of blocking the run

_client: anthropic.Anthropic | None = None
USAGE: Counter = Counter()  # tokens of every agent run in this process, for cost reports


def client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(max_retries=5, timeout=CALL_TIMEOUT_S)
    return _client


def answer_line(reply: str) -> str | None:
    lines = [line for line in reply.splitlines() if line.startswith("Answer:")]
    return lines[-1] if lines else None


def run_once(building_directory: Path, question_text: str, log_name: str | None) -> str:
    # A fresh Building per run: nothing one question does can leak into the next.
    session = Session(Building.load(building_directory))
    log_path = LOG_DIRECTORY / f"{log_name}.json" if log_name else None
    agent = BuildingAgent(session, client(), mode=BENCHMARK, log_path=log_path)
    try:
        return agent.answer_benchmark(question_text)
    finally:
        USAGE.update(agent.usage)


def answer(
    building_directory: Path, question_text: str, question_id: str | None = None, double_check: bool | None = None
) -> str:
    if double_check is None:
        double_check = bool(os.environ.get(DOUBLE_CHECK_ENVIRONMENT_VARIABLE))
    if not double_check:
        return run_once(building_directory, question_text, question_id)

    def attempt(n: int) -> str | None:  # a failed run (API error, ...) doesn't spoil the others
        try:
            return run_once(building_directory, question_text, f"{question_id}-{n}" if question_id else None)
        except Exception:
            return None

    replies = [reply for reply in (attempt(1), attempt(2)) if reply is not None]
    if len(replies) < 2 or answer_line(replies[0]) != answer_line(replies[-1]):
        replies += [reply for reply in (attempt(3),) if reply is not None]
    if not replies:
        return run_once(building_directory, question_text, question_id)  # let the error through
    votes = Counter(answer_line(reply) for reply in replies if answer_line(reply))
    if not votes:
        return replies[0]
    best = votes.most_common(1)[0][0]
    return next(reply for reply in replies if answer_line(reply) == best)
