"""Rewrite build-set questions in other words, keeping every name and number, to test how the agent copes
with wording it has never seen (the Sunday questions may be phrased differently).

  uv run --env-file .env python -m evals.reword     # writes evals/sets/build_reworded.jsonl (~$0.3)

Each rewrite is checked: every building name and every number of the original must still be in it,
otherwise it is retried once and then dropped."""

import re

import anthropic

from evals.sets import DATA, load, write
from navcore.engine import Building

MODEL = "claude-opus-5-5"
STYLES = (
    "casual and chatty, like a colleague asking on the shop floor",
    "terse, like a note typed on a phone",
    "formal and technical, like a facility manager's ticket",
    "roundabout, with one sentence of harmless background context first",
)
PROMPT = """Rewrite this question about a building the way a different person would ask it: {style}.

Rules:
- Keep the meaning and every constraint exactly the same.
- Copy every room name, floor name, lift/stair name, thing and number exactly as written, including \
the parts in brackets such as "(Floor 1)".
- If the question ends with an instruction like "Finish with a line 'Answer: ...'", keep that sentence \
word for word at the end.
- Reply with the rewritten question only.

Question:
{question}"""
NUMBER = re.compile(r"-?\d+(?:\.\d+)?")


def protected_names(building: Building, text: str) -> list[str]:
    """Names from the building that occur in the question (longest first, no name inside another)."""
    names = {space["name"] for space in building.spaces.values()}
    names |= {connector["name"] for connector in building.connectors.values()}
    names |= {floor["name"] for floor in building.floors.values()}
    found = sorted((name for name in names if len(name) > 2 and name in text), key=len, reverse=True)
    kept: list[str] = []
    for name in found:
        if not any(name in longer for longer in kept):
            kept.append(name)
    return kept


def faithful(original: str, rewrite: str, building: Building) -> bool:
    lowered = rewrite.lower()
    if not all(name.lower() in lowered for name in protected_names(building, original)):
        return False
    return sorted(NUMBER.findall(original)) == sorted(NUMBER.findall(rewrite)) and rewrite.strip() != original.strip()


def reword(client: anthropic.Anthropic, question: str, style: str) -> str:
    response = client.messages.create(
        model=MODEL,
        max_tokens=2000,
        output_config={"effort": "low"},
        messages=[{"role": "user", "content": PROMPT.format(style=style, question=question)}],
    )
    return "\n".join(block.text for block in response.content if block.type == "text").strip()


def main() -> None:
    client = anthropic.Anthropic(max_retries=5)
    originals = load("build_benchmark") + load("build_warmup")
    reworded = []
    for index, item in enumerate(originals):
        building = Building.load(DATA / item["building_path"])
        style = STYLES[index % len(STYLES)]
        for _ in range(2):
            text = reword(client, item["question"], style)
            if faithful(item["question"], text, building):
                reworded.append({**item, "id": item["id"] + "-R", "question": text, "original": item["question"],
                                 "style": style})
                break
        else:
            print(f"dropped {item['id']}: rewrite changed a name or number")
    print(f"{write('build_reworded', reworded)}: {len(reworded)} of {len(originals)} questions")


if __name__ == "__main__":
    main()
