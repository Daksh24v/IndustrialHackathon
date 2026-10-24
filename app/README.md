# Finni: the app

Expo (React Native) app for phones and the web. It talks to the backend in `../server` (see `../server/README.md`).

What it does: a clean white start screen with the Finni logo and a "Talk to Finni…" field at the top (the
keyboard can't cover it), an orange mic and a few example questions. Below,
the building you're in, seen from outside as white blocks. Ask where to go ("Where's the coffee machine?");
Finni asks back with options when it needs to (which floor, where you are); then the view flies into that floor:
a tilted 3D view with low walls and door gaps, an orange band for the route with arrows flowing along it, a
pin on the target and an orange disc with a spreading ring where you are. Drag to move, pinch or +/− to zoom,
⟳ to turn; the 2D/3D switch shows the flat plan instead. Routes over several floors show "Take Lift 1 to
Floor 2".

Where you are: for now Finni asks. The AR camera (later) will tell the server with
`api.setPosition(sessionId, room)` (`POST /sessions/{id}/position`); from then on Finni doesn't ask and the map
shows it. No GPS: indoors it's 5-50 m off and doesn't know floors.

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

- **Voice:** tap the mic once and talk. It stops listening when you pause, Finni answers in one short sentence
  out loud and listens again; tap while it talks to interrupt, or before you speak to stop. Typed and tapped
  turns are read out too while a spoken conversation is going. The backend serves the voice endpoints
  (`../voice/README.md`), so there's nothing else to start.
- **Phone:** install Expo Go, be on the same Wi-Fi as the laptop, scan the QR code. `localhost` won't work
  from the phone, so use the laptop's IP address in `EXPO_PUBLIC_API_URL`.
- **Browser:** press `w` in the Expo terminal (then `http://localhost:8000` is fine).
- **Which building:** `EXPO_PUBLIC_BUILDING=<building id>` (default: the first factory).

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
- `src/components/ChatCard.tsx`: the field, mic, example questions, replies and option chips.
- `src/components/FinniLogo.tsx`: placeholder logo: replace this one file with the real logo.
- `src/useVoice.ts`, `src/voice.ts`: the microphone and the spoken answers (expo-audio, the backend's /voice).
- `src/api.ts`, `src/geometry.ts`, `src/theme.ts`: server client, drawing maths, colours.
