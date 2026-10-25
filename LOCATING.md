# Where is the person, and where are things?

Every answer starts with two places: where the person is, and where the thing they want is. If either is
wrong, nothing after it is right. This page says how we find both, and why this way.

## What the data gives us (all 280 buildings, checked)

| Location source | In the data? | Used for |
|---|---|---|
| Room names and numbers | ✅ every room (16,608) | finding places by what people say |
| Door positions and widths | ✅ every door | the route, the turns, step-free and wide loads |
| Things with x/y and their room | ✅ 85,703 (coffee machines, CNC mills, defibrillators …) | targets, and landmarks people can see |
| Stairs, lifts, entrances | ✅ with names | landmarks, step-free routing |
| WiFi, Bluetooth, magnetic, photos | ❌ none | not used: nothing to build or test against |

GPS is 5–50 m off indoors and can't tell floors. AR tracks movement but doesn't know where it started.
QR stickers on every door don't scale to big buildings. So we locate people the way people locate
themselves: by what they know and what they can see.

## Where the person is, in order

1. **What we already know.** The position the phone sent (a tap on the map: "I'm here"; AR later through
   the same endpoint), what they said ("I'm at the lift", "next to the CNC mill H-A1-A"), the entrance they
   came in by, or the route they are walking. The agent hears it every turn and never asks again.
2. **Following the route.** "I'm at the stairs now" moves them along the route; if they left it, the next
   route starts where they are; "take me back" uses where they were (the last 10 places).
3. **Asking once, by landmarks.** Only when it matters and nothing is known: "What can you see near you?"
   with 2–4 options taken from the building's own data: things that are rare on a floor, stairs and lifts,
   entrances, rooms with a name nothing else has, nearest to where they were last. In buildings with up to
   4 floors the options span the floors, so one question finds floor and place together.

Nothing is hard-coded per building, so this works on a building nobody has seen
(`tests/test_unseen.py` runs it on all 40 test buildings).

## Where things are

Exact names first ("Quality lab 0.21 (Ground floor)", a room number, an id), exactly as before, so the
scored answers never depend on what follows. Only when nothing is exact:

- accents and little words: "Buero" = "Büro", "the quality lab", "room 0.21";
- the name without its number or apartment: "Quality lab", Swiss "Kitchen 1.01";
- floors as people say them: "first floor", "EG", "OG 1", "basement", "top floor";
- everyday words for things: WC, elevator, AED, copier, "extinguisher";
- a name shared by several rooms ("Büro" × 12): the agent asks which, with the rooms as options;
- **a typo is never taken silently**: "Qualty lab" comes back as "did you mean Quality lab 0.21?", and
  "room 9.99" is answered with "there is no room 9.99", not a guess.

## Directions people can follow

Routes follow the judges' 1.1.0 walking model (door to door, 15 cm off the walls). Each step says how far,
which way to turn at the door (from the walk itself), and a thing they can see there:
"Walk about 32 m, then turn left through the door into Kitchen 0.28 (by the Coffee machine 0.28)". Said
out loud, Finni gives the same in one sentence.

## How it's checked

- `tests/test_locate.py`: names, typos, floors, types, position and route progress, landmarks, turns
  checked against the geometry.
- `tests/test_unseen.py`: all 40 test buildings: every label finds its room again, routes are never shorter
  than a straight line, step-free never shorter than free, landmarks on every floor, turn-by-turn steps.
- `tests/test_live.py --live`: the tricky users of the Interaction test (wrong room, no number, phone
  position and progress, change of mind, wheelchair, lost).
- On the website: tap the floor, the dot moves there, and the next route starts from it without a question.
