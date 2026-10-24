# Demo script (website, 3–5 minutes, no restart)

Setup, before the jury arrives:

```bash
uv run --env-file .env uvicorn server.app:app --port 8000
cd app && npx expo start --web          # opens http://localhost:8081
```

Open the website on the factory (default building). Turn the sound on for Finni's voice. Every step below was
run on the website on 2026-10-24 in one conversation, in this order, with the replies shown (Finni's wording
varies a little between runs; the landmark options can too, so pick any one on the ground floor).

| # | You say or do | What happened | What it shows off |
|---|---|---|---|
| 1 | "Where's the coffee machine?" | One question: "What can you see near you?" with things on both floors (Conveyor H-A2, Air compressor H-C5, Office lift, Coat rack 1.01) | No room numbers asked, and only one question |
| 2 | Tap "Air compressor H-C5" | Route to Kitchen 0.31, 62 m: "turn right into the main aisle … past the shoe cabinet … at the vending machine, turn right into the office corridor" | Locating by landmarks; directions people can follow |
| 3 | "I'm in the main aisle H-B4 now" | "You're still on the route, with about 40 m left", the dot moves, the line starts there | Following progress along the route |
| 4 | "Actually, I need the quality lab instead" | New route from H-B4 to Quality lab 0.21, 82 m, "by the coordinate measuring machine" | Changing your mind halfway |
| 5 | "I use a wheelchair, take me to office 1.04" | Step-free via the Office lift, 103 m, a "Take Office lift to Floor 1 ›" button; "I'll keep all your routes step-free from now on" | Accessibility, remembered |
| 6 | "Take me to room 9.99" | "There's no room 9.99 in this building", with real rooms as options | Wrong input handled honestly, no guess |
| 7 | Tap the floor somewhere else | The dot jumps to where you tapped; the next route starts there without a question | "I'm here" without GPS or hardware |

Close with BENCHMARK.md: 145 test answers double-checked, build 114/114 and hold-out 35/36 on the organisers'
1.1.0 rules, and LOCATING.md for how we find where people and things are.

If something fails live: reload the page (a new conversation starts), and continue from step 1.
Record one full run as the video fallback.
