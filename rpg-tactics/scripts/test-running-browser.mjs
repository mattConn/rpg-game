import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
const base = process.env.RAYCAST_TEST_URL ?? 'http://localhost:3301';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let latest;
  page.on('websocket', ws => ws.on('framereceived', f => { latest = JSON.parse(String(f.payload)); }));
  await page.addInitScript(() => {
    window.renderedFrames = 0;
    const original = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (...args) {
      if (this.canvas.id === 'scene') window.renderedFrames++;
      return original.apply(this, args);
    };
  });
  await page.route('**/tactics.js', async route => {
    const response = await route.fetch();
    const original = await response.text();
    assert(original.includes('stage.render(snap, now);'), 'Renderer instrumentation matches the built client');
    const source = original.replace('stage.render(snap, now);', 'stage.render(snap, now); window.renderedPlayer = { ...snap.player };');
    await route.fulfill({response,body:source});
  });
  const tiles = [];
  for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) tiles.push({x,y,type:'floor'});
  const project = process.env.TEST_SAVED_ROOM ? JSON.parse(await readFile('data/editor-project.json', 'utf8')) : null;
  const level = project ? project.rooms[project.activeRoom] : {version:1,name:'Running regression',width:30,height:30,tiles,entities:[{id:'player',type:'player',x:15,y:15,facing:0}]};
  const response = await fetch(`${base}/api/editor-level`, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(level)});
  assert(response.ok, 'Test level saved');
  const {id} = await response.json();
  await page.goto(`${base}/?seed=${Date.now() % 0xffffffff || 1}&editor=${id}`);
  await page.waitForFunction(() => document.getElementById('connection-status').textContent === '');
  await page.waitForTimeout(300);
  for (const sprint of [false,true]) {
    const before = {...latest.player};
    const frames = await page.evaluate(() => window.renderedFrames);
    const renderedBefore = await page.evaluate(() => window.renderedPlayer);
    if (sprint) await page.keyboard.down('Shift');
    await page.keyboard.down('w');
    // A single keydown misses the bug: native held keys keep sending repeats.
    for (let repeat = 0; repeat < 20; repeat++) {
      await page.waitForTimeout(35);
      await page.keyboard.down('w');
    }
    const renderedAfter = await page.evaluate(() => window.renderedPlayer);
    assert(Math.hypot(latest.player.x-before.x,latest.player.y-before.y)>20);
    assert(await page.evaluate(() => window.renderedFrames)>frames+3);
    assert(Math.hypot(renderedAfter.x-renderedBefore.x,renderedAfter.y-renderedBefore.y)>20, 'Displayed position advances before keys are released');
    assert.deepEqual(errors,[]);
    await page.keyboard.up('w');
    if (sprint) await page.keyboard.up('Shift');
    console.log(`PASS: ${sprint ? 'sprinting' : 'walking'} keeps rendering movement during key repeat`);
  }
} finally { await browser.close(); }
