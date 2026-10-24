# Demo script (website, 3–5 minutes, no restart)

Setup, before the jury arrives:

```bash
uv run --env-file .env uvicorn server.app:app --port 8000
cd app && npx expo start --web          # opens http://localhost:8081
```

Or build once and use one address: `cd app && npm run build`, then open http://localhost:8000 (the backend serves
the site).

**Home is the orb:** the website opens on a white screen with the orange orb and the "Ask Finni…" pill. Step 1 is
asked there; Finni's options appear as chips in the orb's card, and when the answer has a route the map screen
takes over. The rest of the steps run in the map screen as below. The **Ask / Map** switch (top right) moves
between the two at any time; the orb shows Finni's last answer when you come back.

**For the jury's phones (QR code):** `scripts/share.sh` prints one public HTTPS link with an access code; make the
QR code from it. The mic works on phones only over that HTTPS link. Turn the tunnel off after judging.

Open the website on the factory (default building; on a laptop-wide window the chat sits left of the map, and the building picker at the top switches buildings, e.g. to the Sunday building). Turn the sound on for Finni's voice. Every step below was
run on the website on 2026-10-24 (steps 1–7 in one conversation, step 8 in a fresh one at desktop width), with the replies shown (Finni's wording
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
| 8 | Reload, then: "I'm in the quality lab. The office lift is out of service today, and I moved the coordinate measuring machine to office 1.04." | "I've updated three things …"; the lift turns red on the map ("Office lift closed"); on Floor 1 the machine stands in Office 1.04; "there's no step-free route to the machine today" | The facility manager: the map keeps up |

Close with BENCHMARK.md: 145 test answers double-checked, build 114/114 and hold-out 35/36 on the organisers'
1.1.0 rules, and LOCATING.md for how we find where people and things are.

If something fails live: reload the page (a new conversation starts), and continue from step 1.
Record one full run as the video fallback.
