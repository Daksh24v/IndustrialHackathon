// End-to-end check of the web build, like a person would use it, on a phone and a laptop: the map is there from
// the start (the floor stack behind the opening); hover and open a floor; a quick search; ask, tap an option, the
// route with its steps; walk it with Start (up the stairs to Floor 1); turn the map, compass, bird's eye, 2D; back to the
// whole building; Escape drops a question without moving the map.
// No Claude API calls: the /chat answers are canned, but the map in them is a real route from the server.
//
//   uv run --env-file .env uvicorn server.app:app --port 8000      (in the repo root)
//   npm run build && npx serve dist -l 8081                         (in app/; or WEB=http://localhost:8000)
//   node e2e/run.cjs [screenshot directory]
const { chromium } = require('playwright');

const API = process.env.API ?? 'http://localhost:8000';
const WEB = process.env.WEB ?? 'http://localhost:8081';
const OUT = process.argv[2] ?? 'e2e/screenshots';

const expect = (ok, message) => {
  if (!ok) throw new Error(message);
};

(async () => {
  const route = await (await fetch(`${API}/buildings/proc-factory-dev-003/route`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ start: 'Quality lab 0.21 (Ground floor)', destination: 'Office 1.04 (Floor 1)' }),
  })).json();
  require('fs').mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const errors = [];
  for (const [size, viewport, scale] of [['phone', { width: 390, height: 844 }, 2], ['laptop', { width: 1440, height: 900 }, 1]]) {
    const queue = [
      { reply: 'The nearest toilet is Toilet 0.22, on the ground floor.', question: null, map: null, delay: 600 },
      { reply: '', question: { question: 'Which floor are you on?', options: [{ label: 'Ground floor' }, { label: 'Floor 1' }],
                                allow_free_text: true }, map: null, delay: 900 },
      { reply: `Office 1.04 is upstairs: about ${Math.round(route.summary.length_m)} m, up the Office staircase.`,
        question: null, map: route.map, delay: 600 },
    ];
    const page = await browser.newPage({ viewport, deviceScaleFactor: scale });
    page.on('pageerror', (error) => errors.push(`${size}: ${error}`));
    await page.route('**/sessions/*/chat', async (request) => {
      const { delay = 0, ...reply } = queue.shift();
      await new Promise((resolve) => setTimeout(resolve, delay)); // a real answer takes seconds
      await request.fulfill({ contentType: 'application/json', body: JSON.stringify(reply) });
    });
    const shot = (name) => page.screenshot({ path: `${OUT}/${size}-${name}.png` });
    const idle = () => page.waitForSelector('[data-testid="search-status"]', { state: 'detached', timeout: 20000 });

    // the opening, with the map already behind it
    await page.goto(WEB);
    await page.waitForSelector('[data-testid="intro"]', { timeout: 30000 });
    await page.waitForSelector('[data-testid="building-blocks"]', { timeout: 30000 });
    await page.waitForTimeout(700);
    await shot('0-intro');
    await page.waitForSelector('[data-testid="intro"]', { state: 'detached', timeout: 10000 });
    await page.waitForSelector('[data-testid="orb-mark"]');
    await page.waitForSelector('[data-testid="category-Toilets"]');
    await page.waitForTimeout(800);
    await shot('1-home');

    // light / dark: the button switches the whole look (the map and FINNI's cards), and back again
    const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'));
    const startedDark = await isDark();
    await page.click('[data-testid="theme-toggle"]');
    await page.waitForTimeout(1000);
    expect((await isDark()) !== startedDark, 'the theme button did not switch the look');
    await shot(startedDark ? '1t-light' : '1t-dark');
    await page.click('[data-testid="theme-toggle"]');
    await page.waitForTimeout(1000);
    expect((await isDark()) === startedDark, 'the theme button did not switch back');

    // turn the whole building with the buttons and by dragging the compass; the compass follows
    const compassTurn = () => page.$eval('[data-testid="compass"] svg', (svg) => svg.style.transform);
    await page.click('[data-testid="turn-right"]');
    await page.waitForTimeout(700);
    expect((await compassTurn()) !== 'rotate(0deg)', 'the turn button did not turn the building');
    const compass = await (await page.$('[data-testid="compass"]')).boundingBox();
    await page.mouse.move(compass.x + compass.width / 2, compass.y + compass.height / 2);
    await page.mouse.down();
    await page.mouse.move(compass.x - 150, compass.y + compass.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    await shot('1a-turned-building');

    // hover a floor of the stack (laptop), then open it and come back with the whole-building button
    if (size === 'laptop') {
      const box = await (await page.$('[data-testid="block-1"]')).boundingBox();
      const at = [box.x + box.width * 0.45, box.y + box.height * 0.45];
      await page.mouse.move(at[0], at[1]);
      await page.waitForSelector('[data-testid="floor-hint"]', { timeout: 5000 });
      await shot('1b-hover');
      await page.mouse.click(at[0], at[1]);
    } else {
      await page.click('[data-testid="stack-1"]');
    }
    await page.waitForSelector('[data-testid="floor-scene"]', { timeout: 15000 });
    await page.waitForTimeout(800);
    await shot('1c-floor');
    // turn the floor all the way round from the compass, then back out to the whole building (Escape or the button)
    const before = await compassTurn();
    const dial = await (await page.$('[data-testid="compass"]')).boundingBox();
    await page.mouse.move(dial.x + dial.width / 2, dial.y + dial.height / 2);
    await page.mouse.down();
    await page.mouse.move(dial.x - 200, dial.y + dial.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    expect((await compassTurn()) !== before, 'dragging the compass did not turn the floor');
    await shot('1d-floor-turned');
    if (size === 'laptop') {
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.keyboard.press('Escape');
    } else {
      await page.click('[data-testid="building"]');
    }
    await page.waitForSelector('[data-testid="building-blocks"]', { timeout: 15000 });

    // a quick search: one tap asks FINNI
    await page.click('[data-testid="category-Toilets"]');
    await page.waitForSelector('[data-testid="search-status"]');
    await shot('2-thinking');
    await idle();
    expect((await page.textContent('[data-testid="answer"]')).includes('Toilet 0.22'), 'the quick search was not answered');

    // ask, FINNI asks back, tap the option, the route with what it understood and the steps
    await page.fill('[data-testid="search-input"]', 'Where is office 1.04?');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="option-Ground floor"]', { timeout: 10000 });
    await shot('3-question');
    await page.click('[data-testid="option-Ground floor"]');
    await page.waitForSelector('[data-testid="route-card"]', { timeout: 10000 });
    await page.waitForSelector('[data-testid="floor-scene"]', { timeout: 15000 });
    await page.waitForSelector('[data-testid="route-line"]');
    expect((await page.textContent('[data-testid="route-to"]')) === 'Office 1.04', 'the route card does not say where to');
    expect((await page.textContent('[data-testid="route-from"]')) === 'Quality lab 0.21', 'the route card does not say from where');
    expect((await page.$$('[data-testid^="step-"]')).length >= 4, 'no steps');
    await page.waitForTimeout(1200);
    await shot('4-route');
    if (size === 'laptop') {
      await page.hover('[data-testid="step-1"]');
      await page.waitForSelector('[data-testid="route-highlight"]');
      await shot('5-step-hover');
      await page.mouse.move(900, 450);
    }

    // walk it: Start, Next up the stairs to Floor 1, arrive
    await page.click('[data-testid="start"]');
    await page.waitForSelector('[data-testid="walk"]');
    await page.waitForTimeout(1000);
    await shot('6-walk');
    for (let i = 0; i < 3; i += 1) {
      await page.click('[data-testid="walk-next"]');
      await page.waitForTimeout(900);
    }
    await page.waitForSelector('[data-testid="target-pin"]', { timeout: 10000 }); // on Floor 1 now
    await page.waitForTimeout(800);
    await shot('7-walk-floor1');
    while (await page.$('[data-testid="walk-next"]')) await page.click('[data-testid="walk-next"]');
    expect((await page.textContent('[data-testid="walk-step"]')).includes("You've arrived"), 'the walk did not arrive');
    await page.click('[data-testid="walk-done"]');
    await page.waitForSelector('[data-testid="walk"]', { state: 'detached' });

    // hold and drag turns the floor round (and up / down tilts it); a click without dragging says "I'm here"
    const scene = await (await page.$('[data-testid="floor-scene"]')).boundingBox();
    const centre = [scene.x + scene.width * (size === 'laptop' ? 0.62 : 0.5), scene.y + scene.height * 0.5];
    const facing = await compassTurn();
    await page.mouse.move(centre[0], centre[1]);
    await page.mouse.down();
    await page.mouse.move(centre[0] + 160, centre[1], { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    expect((await compassTurn()) !== facing, 'dragging did not turn the floor');
    await shot('8-turned');
    const dot = await page.$('[data-testid="you-are-here"]');
    const dotBefore = dot ? await dot.boundingBox() : null; // after the walk you are on Floor 1: no dot here yet
    await page.mouse.click(centre[0] - 60, centre[1] + 40);
    await page.waitForFunction((before) => {
      const dot = document.querySelector('[data-testid="you-are-here"]');
      if (!dot) return false;
      if (!before) return true;
      const box = dot.getBoundingClientRect();
      return Math.abs(box.x - before.x) + Math.abs(box.y - before.y) > 10;
    }, dotBefore, { timeout: 10000 });
    await page.click('[data-testid="compass"]');
    // the bird's eye view: straight down, still turns
    await page.click('[data-testid="view-top"]');
    await page.waitForSelector('[data-testid="view-top"][aria-checked="true"]');
    await page.waitForTimeout(800);
    await shot('8b-birds-eye');
    await page.click('[data-testid="view-2D"]');
    await page.waitForSelector('[data-testid="floor-plan"]');
    await page.waitForTimeout(1600);
    await shot('9-floor-2d');
    await page.click('[data-testid="view-3D"]');

    // the whole building, with the route across the floors
    await page.click('[data-testid="building"]');
    await page.waitForSelector('[data-testid="building-blocks"]', { timeout: 15000 });
    await page.waitForSelector('[data-testid="stack-route"]');
    await page.waitForTimeout(800);
    await shot('10-stack-route');

    // a question dropped with Escape never moves the map
    queue.push({ reply: 'Kitchen 0.31 is on the ground floor.', question: null, map: route.map, delay: 2000 });
    await page.fill('[data-testid="search-input"]', 'Where is the kitchen?');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="search-status"]');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(3000);
    expect(!(await page.$('[data-testid="floor-scene"]')), 'the map moved after Escape');
    expect(!(await page.$('[data-testid="search-status"]')), 'still busy after Escape');
    await page.close();
  }
  await browser.close();
  if (errors.length) {
    console.error('page errors:', errors);
    process.exit(1);
  }
  console.log(`ok: screenshots in ${OUT}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
