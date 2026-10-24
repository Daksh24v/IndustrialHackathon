// End-to-end check of the web build, like a person would use it: ask, pick an option, see the route.
// No Claude API calls: the /chat answers are canned, but the map in them is a real route from the server.
//
//   uv run --env-file .env uvicorn server.app:app --port 8000      (in the repo root)
//   npx expo export --platform web && npx serve dist -l 8081        (in app/)
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
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.route('**/sessions/*/chat', (request) =>
    request.fulfill({ contentType: 'application/json', body: JSON.stringify(replies.shift()) }));
  await page.goto(WEB);
  await page.waitForSelector('[data-testid="building-blocks"]', { timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/1-dashboard.png` });
  await page.fill('[data-testid="chat-input"]', 'Where is office 1.04?');
  await page.waitForSelector('[data-testid="send"]');
  await page.screenshot({ path: `${OUT}/2-typing.png` });
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid="question"]');
  await page.screenshot({ path: `${OUT}/3-question.png` });
  await page.click('[data-testid="chip-Ground floor"]');
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/4-flying.png` });
  await page.waitForSelector('[data-testid="floor-scene"]', { timeout: 10000 });
  await page.waitForSelector('[data-testid="you-are-here"]');
  await page.waitForSelector('[data-testid="route-line"]');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/5-floor-3d.png` });
  await page.click('[data-testid="turn"]');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/6-turned.png` });
  await page.click('[data-testid="view-2D"]');
  await page.waitForSelector('[data-testid="floor-plan"]');
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${OUT}/7-floor-2d.png` });
  await page.click('[data-testid="view-3D"]');
  await page.click('[data-testid="next-step"]');
  await page.waitForSelector('[data-testid="target-pin"]');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/8-upstairs-3d.png` });
  await browser.close();
  if (errors.length) {
    console.error('page errors:', errors);
    process.exit(1);
  }
  console.log(`ok: screenshots in ${OUT}`);
})();
