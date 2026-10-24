"""Chat with the building guide in the terminal: uv run --env-file .env python -m navagent data/dev/<id>"""

import argparse
from pathlib import Path

import anthropic

from navagent.agent import BuildingAgent
from navagent.tools import Session
from navcore.engine import Building

EXIT_WORDS = {"exit", "quit", "bye"}


def show_question(question: dict | None) -> None:
    """ask_user in the terminal: the question and numbered options; type a number or your own answer."""
    if not question:
        return
    print(f"\nguide> {question['question']}")
    for number, option in enumerate(question["options"], start=1):
        detail = f" - {option['description']}" if option.get("description") else ""
        print(f"  {number}. {option['label']}{detail}")
    print("  (or type your own answer)")


def main() -> None:
    parser = argparse.ArgumentParser(prog="navagent", description="Chat with an indoor building guide.")
    parser.add_argument("building", type=Path, help="building directory (with building.json) or a building.json")
    arguments = parser.parse_args()
    agent = BuildingAgent(Session(Building.load(arguments.building)))
    print(f"Guide for {agent.session.building.info['name']}. Ask me anything (type 'exit' to stop).")
    while True:
        try:
            user_text = input("\nyou> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not user_text:
            continue
        if user_text.lower() in EXIT_WORDS:
            break
        options = (agent.session.pending_question or {}).get("options", [])
        if user_text.isdigit() and 1 <= int(user_text) <= len(options):
            user_text = options[int(user_text) - 1]["label"]  # picked an option by its number
        try:
            reply = agent.ask(user_text)
            if reply:
                print(f"\nguide> {reply}")
            show_question(agent.session.pending_question)
        except anthropic.AuthenticationError:
            print("No valid API credentials: set ANTHROPIC_API_KEY in .env.")
            return
        except anthropic.APIError as error:
            print(f"API error: {error}")
    print(f"\nTokens used: {agent.usage}")


main()
