// End-to-end check of the web build, like a person would use it, on a phone and a laptop: ask the orb, pick an
// option in its card, the map takes over with the route; turn, 2D, upstairs; back to the orb and to the map again.
// No Claude API calls: the /chat answers are canned, but the map in them is a real route from the server.
//
//   uv run --env-file .env uvicorn server.app:app --port 8000      (in the repo root)
//   npm run build && npx serve dist -l 8081                         (in app/; or WEB=http://localhost:8000)
//   node e2e/run.cjs [screenshot directory]
const { chromium } = require('playwright');

const API = process.env.API ?? 'http://localhost:8000';
const WEB = process.env.WEB ?? 'http://localhost:8081';
const OUT = process.argv[2] ?? 'e2e/screenshots';

(async () => {
  const route = await (await fetch(`${API}/buildings/proc-factory-dev-003/route`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ start: 'Quality lab 0.21 (Ground floor)', destination: 'Office 1.04 (Floor 1)' }),
  })).json();
  const replies = [
    { reply: '', question: { question: 'Which floor are you on?', options: [{ label: 'Ground floor' }, { label: 'Floor 1' }],
                              allow_free_text: true }, map: null },
    { reply: `Office 1.04 is upstairs: about ${Math.round(route.summary.length_m)} m, up the stairs. The route is on your map.`,
      question: null, map: route.map },
  ];
  require('fs').mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const errors = [];
  for (const [size, viewport, scale] of [['phone', { width: 390, height: 844 }, 2], ['laptop', { width: 1440, height: 900 }, 1]]) {
    const queue = [...replies];
    const page = await browser.newPage({ viewport, deviceScaleFactor: scale });
    page.on('pageerror', (error) => errors.push(`${size}: ${error}`));
    await page.route('**/sessions/*/chat', (request) =>
      request.fulfill({ contentType: 'application/json', body: JSON.stringify(queue.shift()) }));
    const shot = (name) => page.screenshot({ path: `${OUT}/${size}-${name}.png` });
    const answered = () => page.waitForSelector('[data-testid="orb-home"][data-phase="answered"]', { timeout: 20000 });
    await page.goto(WEB);
    // home: the orb
    await page.waitForSelector('[data-testid="resting-orb"]', { timeout: 30000 });
    await page.waitForSelector('[data-testid="building-picker"]');
    await page.waitForTimeout(1500);
    await shot('1-home');
    await page.fill('[data-testid="orb-input"]', 'Where is office 1.04?');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="orb-home"][data-phase="think"]', { timeout: 10000 });
    await page.waitForTimeout(600);
    await shot('2-thinking');
    await answered();
    await page.waitForTimeout(600);
    await shot('3-question');
    await page.click('[data-testid="orb-chip-Ground floor"]');
    await answered();
    await shot('4-answer');
    // the answer has a route: the map takes over (the map screen as on main)
    await page.waitForSelector('[data-testid="floor-scene"]', { timeout: 15000 });
    await page.waitForSelector('[data-testid="you-are-here"]');
    await page.waitForSelector('[data-testid="route-line"]');
    await page.waitForTimeout(1500);
    await shot('5-floor-3d');
    await page.click('[data-testid="turn"]');
    await page.waitForTimeout(800);
    await shot('6-turned');
    await page.click('[data-testid="view-2D"]');
    await page.waitForSelector('[data-testid="floor-plan"]');
    await page.waitForTimeout(1600);
    await shot('7-floor-2d');
    await page.click('[data-testid="view-3D"]');
    await page.click('[data-testid="next-step"]');
    await page.waitForSelector('[data-testid="target-pin"]');
    await page.waitForTimeout(1500);
    await shot('8-upstairs-3d');
    // back to the orb; "Map" opens the route again
    await page.click('[data-testid="home"]');
    await page.waitForSelector('[data-testid="open-map"]');
    await page.waitForTimeout(800);
    await shot('9-home-again');
    await page.click('[data-testid="open-map"]');
    await page.waitForSelector('[data-testid="floor-scene"]');
    await page.close();
  }
  await browser.close();
  if (errors.length) {
    console.error('page errors:', errors);
    process.exit(1);
  }
  console.log(`ok: screenshots in ${OUT}`);
})();
