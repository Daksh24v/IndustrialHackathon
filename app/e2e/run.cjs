// End-to-end check of the web build, like a person would use it, on a phone and a laptop: one screen with FINNI over
// the 3D building; hover and click a floor; ask, pick an option, the route opens beside FINNI; turn it round, 2D,
// upstairs; back out to the building.
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
    await page.route('**/sessions/*/chat', async (request) => {
      const { delay = 0, ...reply } = queue.shift();
      await new Promise((resolve) => setTimeout(resolve, delay)); // a real answer takes seconds
      await request.fulfill({ contentType: 'application/json', body: JSON.stringify(reply) });
    });
    const shot = (name) => page.screenshot({ path: `${OUT}/${size}-${name}.png` });
    const answered = () => page.waitForSelector('[data-testid="orb-home"][data-phase="answered"]', { timeout: 20000 });
    await page.goto(WEB);
    // the opening: "Find using FINNI" over the building, then it shrinks into "Ask FINNI"
    await page.waitForSelector('[data-testid="intro"]', { timeout: 30000 });
    await page.waitForTimeout(900);
    await shot('0-intro');
    await page.waitForSelector('[data-testid="intro"]', { state: 'detached', timeout: 10000 });
    // one screen: the orb over the turning building, "Ask FINNI" above it
    await page.waitForSelector('[data-testid="resting-orb"]', { timeout: 30000 });
    await page.waitForSelector('[data-testid="ask-label"]');
    await page.waitForSelector('[data-testid="building-blocks"]');
    await page.waitForSelector('[data-testid="building-picker"]');
    await page.waitForTimeout(1500);
    await shot('1-home');
    // hover a floor of the building: it greys and says which floor; a click flies into it
    if (size === 'laptop') {
      const top = await page.$('[data-testid="block-1"]');
      const box = await top.boundingBox();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3);
      await page.waitForSelector('[data-testid="floor-hint"]', { timeout: 5000 });
      await shot('1b-hover');
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3);
      await page.waitForSelector('[data-testid="floor-scene"]', { timeout: 15000 });
      await page.waitForTimeout(1200);
      await shot('1c-floor-picked');
      await page.click('[data-testid="building"]');
      await page.waitForSelector('[data-testid="building-blocks"]', { timeout: 15000 });
      await page.waitForTimeout(800);
    }
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
    // the answer has a route: the map opens beside FINNI (column on a laptop, sheet on a phone), same screen
    await page.waitForSelector('[data-testid="floor-scene"]', { timeout: 15000 });
    await page.waitForSelector('[data-testid="you-are-here"]');
    await page.waitForSelector('[data-testid="route-line"]');
    await page.waitForTimeout(1500);
    const said = await page.textContent('[data-testid="orb-answer"]');
    if (!said.includes('Office 1.04')) throw new Error(`answer not shown beside the map: ${said}`);
    await shot('4-answer-and-map');
    await page.click('[data-testid="orb-history-toggle"]');
    await page.waitForSelector('[data-testid="orb-history"]');
    await page.waitForTimeout(500);
    await shot('5-earlier');
    await page.click('[data-testid="orb-history-toggle"]');
    // turn it round like a map app: Shift+drag on a laptop, the quarter-turn button; the compass puts north up
    const scene = await (await page.$('[data-testid="floor-scene"]')).boundingBox();
    if (size === 'laptop') {
      await page.keyboard.down('Shift');
      await page.mouse.move(scene.x + scene.width / 2, scene.y + scene.height / 2);
      await page.mouse.down();
      await page.mouse.move(scene.x + scene.width / 2 + 200, scene.y + scene.height / 2, { steps: 10 });
      await page.mouse.up();
      await page.keyboard.up('Shift');
    } else {
      await page.click('[data-testid="turn"]');
    }
    await page.waitForTimeout(800);
    await shot('6-turned');
    await page.click('[data-testid="compass"]');
    await page.waitForTimeout(800);
    await page.click('[data-testid="view-2D"]');
    await page.waitForSelector('[data-testid="floor-plan"]');
    await page.waitForTimeout(1600);
    await shot('7-floor-2d');
    await page.click('[data-testid="view-3D"]');
    await page.click('[data-testid="next-step"]');
    await page.waitForSelector('[data-testid="target-pin"]');
    await page.waitForTimeout(1500);
    await shot('8-upstairs-3d');
    // back out to the whole building: FINNI goes back to the middle
    await page.click('[data-testid="building"]');
    await page.waitForSelector('[data-testid="building-blocks"]', { timeout: 15000 });
    await page.waitForTimeout(1200);
    await shot('9-building-again');
    // a new question dropped with Escape never pulls the map in by itself
    queue.push({ reply: 'Kitchen 0.31 is on the ground floor.', question: null, map: route.map, delay: 2000 });
    await page.click('[data-testid="orb-reset"]');
    await page.waitForSelector('[data-testid="orb-home"][data-phase="idle"]');
    await page.fill('[data-testid="orb-input"]', 'Where is the kitchen?');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="orb-home"][data-phase="think"]');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(3500);
    if (await page.$('[data-testid="floor-scene"]')) throw new Error('the map came in after Escape');
    if (!(await page.$('[data-testid="orb-home"][data-phase="idle"]'))) throw new Error('orb not back to idle');
    await page.close();
  }
  await browser.close();
  if (errors.length) {
    console.error('page errors:', errors);
    process.exit(1);
  }
  console.log(`ok: screenshots in ${OUT}`);
})();
