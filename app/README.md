# Talk to your building: the app

Expo (React Native) app for phones and the web. It talks to the backend in `../server` (see `../server/README.md`).

What it does: the building you're in, seen from outside as white blocks. Ask where to go ("Where's the
nearest coffee machine?"); the guide asks back with options when it needs to (which floor, where you are);
then the view flies into that floor: a 2D plan with a glowing orange "you are here", the orange route and a
pin on the target. Routes over several floors show "Take Lift 1 to Floor 2".

## Run it

```bash
# 1. backend (repo root; ANTHROPIC_API_KEY in .env)
uv sync
uv run --env-file .env uvicorn server.app:app --host 0.0.0.0 --port 8000

# 2. app (this folder)
npm install
EXPO_PUBLIC_API_URL=http://<your-laptop-ip>:8000 npx expo start
```

- **Phone:** install Expo Go, be on the same Wi-Fi as the laptop, scan the QR code. `localhost` won't work
  from the phone, so use the laptop's IP address in `EXPO_PUBLIC_API_URL`.
- **Browser:** press `w` in the Expo terminal (then `http://localhost:8000` is fine).
- **Which building:** `EXPO_PUBLIC_BUILDING=<building id>` (default: the first factory).

## Checks

```bash
npm test               # Jest: geometry, API client, state machine, chat chips
npx tsc --noEmit       # types
# end to end on the web build (no Claude API calls; uses a real route from the server):
npx expo export --platform web && npx serve dist -l 8081 &
node e2e/run.cjs       # screenshots in e2e/screenshots
```

## Code

- `App.tsx`: the screen; `src/state.ts`: its state machine (outside → flying in → floor).
- `src/components/BuildingBlocks.tsx`: the 3D outside view (three.js via react-three-fiber).
- `src/components/FloorPlan.tsx`: the 2D floor, the orange blob, route and pin.
- `src/components/ChatSheet.tsx`: messages, option chips, text field, microphone button (voice branch).
- `src/api.ts`, `src/geometry.ts`, `src/theme.ts`: server client, drawing maths, colours.
