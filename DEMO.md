# Demo script (website, 3–5 minutes, no restart)

Setup, before the jury arrives:

```bash
uv run --env-file .env uvicorn server.app:app --port 8000
cd app && npx expo start --web          # opens http://localhost:8081
```

Open the website on the factory (default building). Turn the sound on for Finni's voice. Steps 2–4 were run on
the website on 2026-10-24 (step 1 then asked two questions; it now asks one, checked against the agent but not
yet on the website). Steps 5–8 are covered by the live agent tests (`tests/test_live.py --live`) but not yet
clicked through on the website: rehearse them there before the demo.

| # | You do | What they see | What it shows off |
|---|---|---|---|
| 1 | Say (mic): "Where's the coffee machine?" | One question: "What can you see near you?" with things from both floors (Conveyor H-A2, Air compressor H-C5, Office lift …) | We don't ask for room numbers, and we ask only once |
| 2 | Tap "Coordinate measuring machine 0.21" | The building flies in; route to Kitchen 0.28, about 37 m; Finni says "turn left into the office corridor … turn left into the kitchen, by the coffee machine" | Locating by landmarks; turn-by-turn people can follow |
| 3 | Tap the floor in Meeting room 0.24 | The orange dot jumps to where you tapped | "I'm here" without GPS or hardware |
| 4 | Say: "Take me to the locker room" | No question: "about 13 m from Meeting room 0.24, where you are now … turn left … turn right into the locker room" | Uses the position it already has |
| 5 | Say: "I'm in the office corridor now" | Finni follows you along the route | Route progress |
| 6 | Say: "Actually, I need the quality lab instead" | New route from where you are | Changing your mind halfway |
| 7 | Say: "I use a wheelchair, take me to office 1.04" | Route by the lift, not the stairs | Step-free without asking twice |
| 8 | Say: "Take me to room 9.99" | "There's no room 9.99", with real rooms nearby | Wrong input handled honestly, no guess |

Close with BENCHMARK.md: 145 test answers double-checked, build 114/114 and hold-out 35/36 on the organisers'
1.1.0 rules, and LOCATING.md for how we find where people and things are.

If something fails live: reload the page (the server keeps nothing that matters), and continue from step 1.
Record one full run as the video fallback.
