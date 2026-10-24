"""Chat with the building guide in the terminal: uv run --env-file .env python -m navagent data/dev/<id>"""

import argparse
from pathlib import Path

import anthropic

from navagent.agent import BuildingAgent
from navagent.tools import Session
from navcore.engine import Building

EXIT_WORDS = {"exit", "quit", "bye"}


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
        try:
            print(f"\nguide> {agent.ask(user_text)}")
        except anthropic.AuthenticationError:
            print("No valid API credentials: set ANTHROPIC_API_KEY in .env.")
            return
        except anthropic.APIError as error:
            print(f"API error: {error}")
    print(f"\nTokens used: {agent.usage}")


main()
