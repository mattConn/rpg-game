import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
const base = process.env.RAYCAST_TEST_URL ?? 'http://localhost:3301';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  await mkdir('work', { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [], requests = [], sent = [];
  let latest;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  page.on('websocket', socket => {
    socket.on('framereceived', frame => { try { latest = JSON.parse(String(frame.payload)); } catch {} });
    socket.on('framesent', frame => { try { sent.push(JSON.parse(String(frame.payload))); } catch {} });
  });
  const tiles = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 14; x++) tiles.push({ x, y, type: 'floor' });
  const fixture = { version: 1, name: 'Raycast verification', width: 14, height: 8, tiles, entities: [
    { id: 'player', type: 'player', x: 4, y: 4, facing: 1 },
    { id: 'hound', type: 'hellhound', x: 6, y: 4, facing: -1 },
  ] };
  const response = await fetch(`${base}/api/editor-level`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fixture) });
  const { id } = await response.json();
  await page.addInitScript(({ id, fixture }) => { localStorage.setItem(`rpg-editor-level:${id}`, JSON.stringify(fixture)); }, { id, fixture });
  await page.goto(`${base}/?seed=1&editor=${id}`);
  await page.waitForFunction(() => document.getElementById('connection-status').textContent === '');
  await page.waitForTimeout(1000);
  assert(latest, 'Server snapshot received');
  await page.mouse.move(640, 400);
  assert(await page.evaluate(() => !document.pointerLockElement), 'Mouse remains uncaptured');
  const initial = { ...latest.player };
  await page.keyboard.down('w'); await page.waitForTimeout(350); await page.keyboard.up('w');
  await page.waitForTimeout(150);
  assert(latest.player.x > initial.x + 15, 'W moves through the server simulation');
  const headingBefore = { ...latest.playerHeading };
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(660, 390, { steps: 4 });
  await page.waitForTimeout(150);
  assert(!sent.some(message => message.type === 'useSlot'), 'Dragging does not attack');
  assert.deepEqual(latest.playerHeading, headingBefore, 'Orbiting leaves the player facing unchanged');
  const healthBefore = latest.enemies[0].health;
  await page.mouse.click(660, 390);
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(150);
  assert(latest.enemies[0].health < healthBefore, 'Left-click bites while right-dragging');
  assert.equal(latest.cooldown?.slot, 0, 'Server cooldown drives the bite animation');
  assert(sent.some(message => message.type === 'useSlot' && message.index === 0), 'Attack input remains connected');
  await page.keyboard.press('e');
  await page.waitForTimeout(150);
  assert(sent.some(message => message.type === 'keydown' && message.key === 'e'), 'Eating input remains connected');
  await page.screenshot({ path: 'work/raycast-third-person.png' });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.pointerLockElement);
  const results = [];
  for (const quality of ['low', 'med', 'high', 'max']) {
    await page.selectOption('#graphics-quality', quality);
    await page.waitForFunction(q => document.getElementById('graphics-quality').value === q && document.getElementById('connection-status').textContent === '', quality);
    await page.waitForTimeout(1800);
    const result = await page.evaluate(() => ({ quality: document.getElementById('graphics-quality').value, width: document.getElementById('scene').width, fps: document.getElementById('performance').textContent, render: document.getElementById('performance').title }));
    results.push(result);
  }
  assert.deepEqual(results.map(r => r.width), [320, 480, 640, 960]);
  assert.equal(requests.filter(url => /\.(gltf|glb|bin)(\?|$)/.test(url)).length, 0, 'No 3D models are loaded during play');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS: editor map, movement, independent orbit, attack/eat, graphics presets, no model loading, no browser errors', modes: results }));
} finally { await browser.close(); }
