// End-to-end check of the built website, like a person would use it, on a laptop and on a phone: ask, pick an
// option, see the route, zoom and drag with the mouse.
// No Claude API calls: the /chat answers are canned, but the map in them is a real route from the server.
//
//   uv run --env-file .env uvicorn server.app:app --port 8000      (in the repo root)
//   npm run build && npx serve dist -l 8081                         (in app/)
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
  for (const [size, viewport, scale] of [['laptop', { width: 1440, height: 900 }, 1], ['phone', { width: 390, height: 844 }, 2]]) {
    const queue = [...replies];
    const page = await browser.newPage({ viewport, deviceScaleFactor: scale });
    page.on('pageerror', (error) => errors.push(`${size}: ${error}`));
    await page.route('**/sessions/*/chat', (request) =>
      request.fulfill({ contentType: 'application/json', body: JSON.stringify(queue.shift()) }));
    const shot = (name) => page.screenshot({ path: `${OUT}/${size}-${name}.png` });
    await page.goto(WEB);
    await page.waitForSelector('[data-testid="building-blocks"]', { timeout: 30000 });
    if (size === 'laptop') await page.waitForSelector('[data-testid="sidebar"]');
    else if (await page.$('[data-testid="sidebar"]')) throw new Error('phone shows the sidebar');
    await page.waitForTimeout(2500);
    await shot('1-dashboard');
    await page.fill('[data-testid="chat-input"]', 'Where is office 1.04?');
    await page.waitForSelector('[data-testid="send"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="question"]');
    await shot('2-question');
    await page.click('[data-testid="chip-Ground floor"]');
    await page.waitForSelector('[data-testid="floor-scene"]', { timeout: 10000 });
    await page.waitForSelector('[data-testid="you-are-here"]');
    await page.waitForSelector('[data-testid="route-line"]');
    await page.waitForTimeout(1500);
    await shot('3-floor-3d');
    if (size === 'laptop') {
      // mouse: wheel zoom about the pointer, then drag
      const map = await page.$('[data-testid="floor-scene"]');
      const box = await map.boundingBox();
      const before = await page.$eval('[data-testid="you-are-here"]', (node) => node.getBoundingClientRect().width);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -400);
      await page.waitForTimeout(400);
      const after = await page.$eval('[data-testid="you-are-here"]', (node) => node.getBoundingClientRect().width);
      if (!(after > before)) throw new Error(`wheel did not zoom in (${before} -> ${after})`);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      await shot('4-zoomed-and-dragged');
    }
    await page.click('[data-testid="view-2D"]');
    await page.waitForSelector('[data-testid="floor-plan"]');
    await page.waitForTimeout(1600);
    await shot('5-floor-2d');
    await page.click('[data-testid="view-3D"]');
    await page.click('[data-testid="next-step"]');
    await page.waitForSelector('[data-testid="target-pin"]');
    await page.waitForTimeout(1500);
    await shot('6-upstairs-3d');
    await page.close();
  }
  await browser.close();
  if (errors.length) {
    console.error('page errors:', errors);
    process.exit(1);
  }
  console.log(`ok: screenshots in ${OUT}`);
})();
