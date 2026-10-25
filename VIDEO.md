# Video script (2 minutes: 1 minute demo, 1 minute how it works)

The voiceover alone, for ElevenLabs, is in `video_voiceover.txt` (demo 111 words, how it works
116 words; about a minute each at a calm pace, with room for the screen). Leave out the two headings
(DEMO, HOW IT WORKS) when you paste it, or generate the two halves separately.

## Minute 1: the demo

Record the website on the factory (dark look, laptop width), following [DEMO.md](DEMO.md): steps 1–2, the
60-second story steps 1 and 3, and step 9 (Forklift). Keep cuts fast: the voice leads, the screen proves it.

| Time | On screen | Voiceover |
|---|---|---|
| 0:00–0:08 | The website opens and flies into the factory; the floor stack turns | This factory has two floors, eighty rooms and five hundred machines. Meet Finni: Google Maps for every building. |
| 0:08–0:28 | Type "Where's the coffee machine?" → tap "Air compressor H-C5" → route card with steps → Start | Where's the coffee machine? Finni asks one thing: what can you see near you? Tap the air compressor. Turn right into the main aisle, past the shoe cabinet, the kitchen is on your left. Press Start, and it walks you there. |
| 0:28–0:40 | Mic: "the office lift is broken" → the lift turns red, the red line under the search bar, the maintenance inbox | The office lift is broken. Finni reports it for everyone. The lift turns red on every map, and maintenance is told. |
| 0:40–0:52 | Tap Forklift → "Main aisle H-B2 is blocked, take me to the loading dock" → the route goes round; "Why this way … 20 m longer · about 54 s" | Driving a forklift? Aisle B2 is blocked. Finni goes around it, and tells you why: twenty metres longer, under a minute. |
| 0:52–1:00 | Shield → the map dims to exits and extinguishers → Nearest exit | In an emergency, press the shield. Nearest exit: one tap. |

## Minute 2: how it works

Slides or screen captures; one picture per sentence is enough.

| Time | On screen | Voiceover |
|---|---|---|
| 1:00–1:15 | A simple diagram: person → Claude (conversation) → tools → navcore graph → map | How it works. Claude is only the conversation layer. It understands the person, asks at most one question, and calls tools. It never guesses a distance. |
| 1:15–1:32 | The floor plan with the walking graph drawn over it (doors, centres, stairs); a route lighting up | Every answer comes from a deterministic core: a graph of rooms, doors, corridors, stairs and lifts, with real walking paths inside each room, and a shortest-path search. |
| 1:32–1:42 | The Walk · Wheelchair · Trolley · Forklift chip; the same trip as walk and as forklift | A wheelchair, a trolley or a forklift only changes the graph: door widths, no steps, and a forklift only through halls and aisles. |
| 1:42–1:52 | A Swiss floor plan (SVG) turning into the 3D floor stack, stairs found | Give Finni only floor plans, and it reads the drawings, lines up the floors, and finds the stairs, even when none are drawn. |
| 1:52–2:00 | BENCHMARK.md: the hold-out row 35 / 36; the one-command run in a terminal | On buildings we locked away and never tuned on: thirty-five of thirty-six questions right. Any building, one command. Finni. |

**For ElevenLabs:** "Finni" is said "Finny"; the blank lines between scenes give natural pauses. Speed 1.0, a
calm, clear voice. Record the screen first, then cut it to the voice.

**Facts in the voiceover:** Fertigung Ost 27 has 2 floors, 79 rooms and 505 things; the hold-out run (buildings locked
away, nothing tuned on them) got 35 of 36 questions right (BENCHMARK.md); the forklift detour around Main aisle H-B2 is 20 m longer, about
54 s; stairs are found from plans that draw none (Swiss Dwellings, BENCHMARK.md Level 4).
