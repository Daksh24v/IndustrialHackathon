# Demo script (website, 3–5 minutes, no restart)

Setup, before the jury arrives:

```bash
uv run --env-file .env uvicorn server.app:app --port 8000
cd app && npx expo start --web          # opens http://localhost:8081
```

Or build once and use one address: `cd app && npm run build`, then open http://localhost:8000 (the backend serves
the site).

**Map-first, like a map app:** "FINNI find it" shrinks into the search bar and the building is already there as
a floor stack (every floor a slab with its rooms; hover one, it turns grey; click it to fly in). The search card
(top left on a laptop, top on a phone) is where you ask: type, the mic, or a quick search made from what this
building has ("Toilets", "Exit", "Coffee"…). FINNI's answer opens under it (a bottom sheet on a phone): its
question with options to tap, or for a route **From → To**, the metres and minutes, the steps ("Turn right into
Office corridor 0.16, by the Coordinate measuring machine") and **Start**, which walks the route one step at a time
(Next goes up the stairs to the next floor). Hover a step and it lights up on the map. The buttons bottom right:
I'm here, the floor stack, 3D / Top (bird's eye) / 2D, turn left / right with the compass between (click it for
north up, drag it sideways to turn all the way round) and zoom. **Hold and drag the map itself**: sideways turns the
building or the floor all the way round, up and down tilts it (down looks from above, up from the side); Shift+drag or
right-drag moves a floor, a click on it says "I'm here" (on a phone: one finger moves, two fingers twist).
"‹ Building" at the top of a floor (or Escape) goes back to the whole building.

**Optional, the real venue:** with `EXPO_PUBLIC_GOOGLE_MAPS_KEY` in `app/.env` (see app/README.md) the opening flies
round Munich Urban Colab in Google's photorealistic 3D before our building takes over. Add `?intro=1` to the
address to show the opening again.

**For the jury's phones (QR code):** `scripts/share.sh` prints one public HTTPS link with an access code; make the
QR code from it. The mic works on phones only over that HTTPS link. Turn the tunnel off after judging.

Open the website on the factory (default building; on a laptop-wide window FINNI sits left of the map, and the building picker at the top switches buildings, e.g. to the Sunday building). Turn the sound on for FINNI's voice. Every step below was
run on the website on 2026-10-24 (steps 1–7 in one conversation, step 8 in a fresh one at desktop width; step 9 added on 2026-10-25, its route and card checked with a canned reply), with the replies shown (FINNI's wording
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
| 9 | Reload, tap **Forklift** under the search bar, then: "I'm in Warehouse zone H-C1 and Main aisle H-B2 is blocked by a pallet. Take me to the loading dock." (or tap "Loading dock" after saying where you are) | The route goes round through the assembly and additive zones to Logistics zone H-C5, 109 m; the card says "Forklift" and "Why this way: Main aisle H-B2 (Ground floor) is closed · 20 m longer · about 54 s". Then "Nearest forklift charger" | One map for people and vehicles: the profile changes which doors and spaces fit, and FINNI says why |

**The 60-second story (what makes FINNI different):**

1. A worker says (mic or typed): "Hey FINNI, the office lift is broken." FINNI confirms what it understood ("Office
   lift, Ground floor ↔ Floor 1, out of service; maintenance has been told"). The lift turns red on everyone's map, a
   red line appears under the search bar, and the Office lift's shaft in the floor stack turns red (hover it).
   Maintenance gets it in the inbox (the red line → Maintenance inbox), and by email with `RESEND_API_KEY` and
   `MAINTENANCE_EMAIL` in `.env`.
2. A colleague in another browser (or after a reload) in a wheelchair: "Take me to office 1.04, step-free." FINNI
   says honestly there is no step-free way right now. On foot: the route goes by the Office staircase instead.
3. Press the **shield** (Safety): the map dims; exits, fire extinguishers, defibrillators and the stairs light up on
   every floor (not the lifts: not in a fire). Tap "Nearest exit" or "Fire extinguisher": the route, at once.
4. "The lift works again" (or **Fixed** in the list): cleared for everyone, maintenance hears that too.

On a route, the things in the rooms you pass stay bright and the rest fade; the thing you're going to is orange
with its name, and the landmarks in the steps ("by the Coordinate measuring machine") are named on the map. First
aid kits aren't in the data: with a list of them, FINNI routes to them like the extinguishers.

Close with SUBMISSION/BENCHMARK.md: 145 test answers double-checked, build 114/114 and hold-out 35/36 on the organisers'
1.1.0 rules, and LOCATING.md for how we find where people and things are.

If something fails live: reload the page (a new conversation starts), and continue from step 1.
Record one full run as the video fallback.
