# FINNI: the app

Expo (React Native) app for phones and the web. It talks to the backend in `../server` (see `../server/README.md`).

**One screen** (`App.tsx`): the map fills it and FINNI sits on top. It opens with "Find using FINNI" over the 3D
building (`src/orb/Intro.tsx`, once per visit, a click or key skips it, `?intro=1` shows it again), which shrinks
into the "Ask FINNI" label above the orange dotted orb (`src/orb/MorphOrb.tsx`, styles `src/orb/orb.css`,
timelines `src/orb/motion.ts`); the "Ask FINNI…" pill (with the orange mic) is at the bottom, the building picker at
the top. Send a question: the pill shrinks into a ball, flies into the orb, the orb thinks ("Searching the
building…"), turns green and unfolds into the answer card; when FINNI asks back, the options are chips in the
card. When an answer has a route, the floor opens and FINNI moves beside it (a 400 px column on a laptop, the
bottom of the screen on a phone); "Earlier" in the card shows the whole conversation. No modes to switch.

The building: seen from outside as white blocks, turning slowly; drag to turn it all the way round. Hover a floor
and it turns grey ("Floor 1 · click to open"); click (or tap) it to fly into that floor. "‹ Building" goes back
out. Inside a floor:
a tilted 3D view with low walls and door gaps, an orange band for the route with arrows flowing along it, a
pin on the target and an orange disc with a spreading ring where you are. Drag to move, pinch, wheel or +/− to
zoom; turn it all the way round like a map app with right-drag or Shift/Alt+drag (two fingers on a phone), ⟳ for a
quarter turn and the compass to put north up again; the 2D/3D switch shows the flat plan instead. Routes over several floors show "Take Lift 1 to
Floor 2".

Where you are: **tap the floor ("I'm here")** and the dot moves there (`api.setPositionAt(sessionId, floorId,
[x, y])`, `POST /sessions/{id}/position` with `{floor, x, y}`). Or just say it ("I'm at the lift", "next to the
CNC mill"). From then on FINNI doesn't ask, starts routes there, remembers where you were ("take me back") and
follows your progress along the route. When it doesn't know, it asks once by landmarks you can see. The AR
camera (later) sends points the same way, or a place with `api.setPosition(sessionId, room)`. No GPS: indoors
it's 5-50 m off and doesn't know floors.

The 3D view is drawn with SVG (a projected camera in `src/geometry.ts`), not a 3D engine: three.js and
react-three-fiber crash Expo Go on iPhones.

## Run it

```bash
# 1. backend (repo root; ANTHROPIC_API_KEY and, for the mic, ELEVENLABS_API_KEY in .env)
uv sync
uv run --env-file .env uvicorn server.app:app --host 0.0.0.0 --port 8000

# 2. app (this folder)
npm install
EXPO_PUBLIC_API_URL=http://<your-laptop-ip>:8000 npx expo start
```

- **Public link:** `../scripts/share.sh` builds the site, starts the backend and opens a Cloudflare tunnel: one
  HTTPS link with `?code=` (the access code from `.env`, `FINNI_ACCESS_CODE`) for the QR code; the mic works on
  phones only over HTTPS.
- **One address (website):** `npm run build` (in this folder) puts the site in `dist/`; the backend then serves it
  at http://localhost:8000 too (site and API on one address, for hosting and a QR code). The site talks to its
  own address unless `EXPO_PUBLIC_API_URL` is set at build time.

- **Voice:** tap the mic once and talk. It stops listening when you pause, FINNI answers in one short sentence
  out loud and listens again; tap while it talks to interrupt, or before you speak to stop. Typed and tapped
  turns are read out too while a spoken conversation is going. The backend serves the voice endpoints
  (`../voice/README.md`), so there's nothing else to start.
- **Phone:** install Expo Go, be on the same Wi-Fi as the laptop, scan the QR code. `localhost` won't work
  from the phone, so use the laptop's IP address in `EXPO_PUBLIC_API_URL`.
- **Browser:** press `w` in the Expo terminal (then `http://localhost:8000` is fine).
- **Which building:** `EXPO_PUBLIC_BUILDING=<building id>` (default: the first factory).
- **Optional, the real venue in Google 3D:** the opening can fly round Munich Urban Colab (UnternehmerTUM) in
  Google's photorealistic 3D (`src/orb/GoogleIntro.tsx`). Google's 3D models can be shown live but not downloaded,
  so the routes stay on our own building. In the Google Cloud console make a project with billing, turn on the
  **Maps JavaScript API** and the **Map Tiles API**, make an API key and restrict it to your site's address
  (HTTP referrers: `http://localhost:8000/*` and the share link). Put it in `app/.env` (gitignored) as
  `EXPO_PUBLIC_GOOGLE_MAPS_KEY=...` and run `npm run build` again: the key is built into the page (that is how
  Maps keys work, hence the referrer restriction). `EXPO_PUBLIC_INTRO_PLACE=lat,lng` points it elsewhere. Without
  a key, or if Google doesn't draw the venue within 5 s, the opening shows our building.

## Checks

```bash
npm test               # Jest: geometry and the 3D camera, API client, state machine, chat card, floor views, voice
npx tsc --noEmit       # types
# end to end on the web build (no Claude API calls; uses a real route from the server):
npx expo export --platform web && npx serve dist -l 8081 &
node e2e/run.cjs       # screenshots in e2e/screenshots
```

## Code

- `App.tsx`: the screen; `src/state.ts`: its state machine (outside → flying in → floor).
- `src/components/BuildingBlocks.tsx`: the outside view: floors as white isometric blocks, drawn with SVG.
- `src/components/FloorScene.tsx`: the 3D floor (default); `src/components/FloorPlan.tsx`: the 2D floor.
- `src/components/Markers.tsx`: you-are-here and the target pin; `src/gestures.ts`: drag and pinch.
- `src/orb/`: FINNI (the orb, its card and pill), the opening (`Intro.tsx`) and the optional Google 3D opening.
- `src/components/ChatCard.tsx`: `plain()` (answer text without markdown) and the older chat card.
- The FINNI wordmark on the website is in `src/orb/MorphOrb.tsx` (`mo-logo`); `src/components/FinniLogo.tsx` is the native one.
- `src/useVoice.ts`, `src/voice.ts`: the microphone and the spoken answers (expo-audio, the backend's /voice).
- `src/api.ts`, `src/geometry.ts`, `src/theme.ts`: server client, drawing maths, colours.
