# Finni: the website

A website for laptops and phones (built with Expo / React Native for web). It talks to the backend in
`../server`, which also serves the built site, so site and API share one address.

Layout: on a laptop (wide screen) the conversation is a sidebar on the left and the map fills the rest; on a
phone it's one column with the "Talk to Finni…" field at the top (the keyboard can't cover it).

What it does: a clean white start screen with the Finni logo, the "Talk to Finni…" field, an orange mic and a
few example questions, and the building you're in, seen from outside as white blocks. Ask where to go ("Where's the coffee machine?");
Finni asks back with options when it needs to (which floor, where you are); then the view flies into that floor:
a tilted 3D view with low walls and door gaps, an orange band for the route with arrows flowing along it, a
pin on the target and an orange disc with a spreading ring where you are. Drag to move; pinch, the mouse wheel,
a trackpad pinch or +/− to zoom; ⟳ to turn; the 2D/3D switch shows the flat plan instead. Routes over several floors show "Take Lift 1 to
Floor 2".

Where you are: for now Finni asks. The AR camera (later) will tell the server with
`api.setPosition(sessionId, room)` (`POST /sessions/{id}/position`); from then on Finni doesn't ask and the map
shows it. No GPS: indoors it's 5-50 m off and doesn't know floors.

The 3D view is drawn with SVG (a projected camera in `src/geometry.ts`), not a 3D engine, so it's light on phones.

## Run it

```bash
# 1. build the site (this folder)
npm install
npm run build                      # -> dist/

# 2. backend + site (repo root; ANTHROPIC_API_KEY and, for the mic, ELEVENLABS_API_KEY in .env)
uv sync
uv run --env-file .env uvicorn server.app:app --host 0.0.0.0 --port 8000
```

Open http://localhost:8000 . From a phone on the same Wi-Fi: http://<laptop-ip>:8000 (`ipconfig getifaddr en0`
on a Mac). The microphone in a browser needs `localhost` or https, so on a phone voice works once the site is
hosted with https.

- **While working on the UI:** `npm run web` (live reload at http://localhost:8081; it uses the backend at
  localhost:8000, which must be running).
- **Hosting the site elsewhere (e.g. Vercel):** build with `EXPO_PUBLIC_API_URL=https://<backend address>
  npm run build`; the backend must then be reachable at that address over https.
- **Voice:** tap the mic once and talk. It stops listening when you pause, Finni answers in one short sentence
  out loud and listens again; tap while it talks to interrupt, or before you speak to stop. Typed and tapped
  turns are read out too while a spoken conversation is going. The backend serves the voice endpoints
  (`../voice/README.md`), so there's nothing else to start.
- **Which building:** `EXPO_PUBLIC_BUILDING=<building id>` at build time (default: the first factory).

## Checks

```bash
npm test               # Jest: geometry and the 3D camera, API client, state machine, chat card, floor views, voice
npm run typecheck      # types
# end to end on the built site, laptop and phone sizes (no Claude API calls; uses a real route from the server):
npm run build && npx serve dist -l 8081 &
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
