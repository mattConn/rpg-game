/** Server-authoritative dungeon, drawn as raycast walls and directional sprites. */
import { WORLD_HEIGHT, WORLD_WIDTH } from "../../../src/shared/constants.js";
import { LOOT_CLOSE_RECT, hitsRect, lootMenuProxyPoint } from "../../../src/shared/loot.js";
import type { Point } from "../../../src/shared/movement.js";
import { actionBarHandleRect, actionBarSize, squareAtPoint } from "../../../src/client/actionbar.js";
import { SERVER_TICK_MS, renderFraction, smoothInterval } from "../../../src/client/interpolation.js";
import { fillViewport } from "../../../src/client/viewport.js";
import { barOrigin, centreShift, drawOverlay, hits } from "../../../rpg-3d/src/client/overlay.js";
import { interpolateSnapshot } from "../../../rpg-3d/src/client/playback.js";
import {
  configureDungeon,
  configureEditorDungeon,
  TACTICS_ACTIONS,
  type TacticsInput,
  type TacticsSnapshot,
  type EditorDungeonConfig,
} from "../shared/tactics.js";
import { BAR_LAYOUT, drawTacticsChrome, deathResurrectRect } from "./chrome.js";
import { FloorStats } from "./floor-stats.js";
import { GemExplosion } from "./gem-explosion.js";
import { BloodEffects } from "./blood-effects.js";
import { selectAttackReticle } from "./attack-presentation.js";
import { RaycastRenderer } from "./raycast-renderer.js";
import { GRAPHICS_PRESETS, readGraphicsQuality, setupGraphicsControl } from "./graphics.js";

// ------------------------------------------------------------------ canvases

const pageUrl = new URL(location.href);
const carriedHealthStorageKey = "rpg-next-dungeon-health";
const carriedHealth = sessionStorage.getItem(carriedHealthStorageKey)
  ?? pageUrl.searchParams.get("health"); // Migrate links produced by older builds once.
sessionStorage.removeItem(carriedHealthStorageKey);
let pageUrlChanged = false;
if (pageUrl.searchParams.has("health")) {
  pageUrl.searchParams.delete("health");
  pageUrlChanged = true;
}
const requestedSeed = pageUrl.searchParams.get("seed");
let dungeonSeed = requestedSeed === null ? NaN : Number(requestedSeed);
if (!Number.isSafeInteger(dungeonSeed) || dungeonSeed < 1 || dungeonSeed > 0xffffffff) {
  dungeonSeed = crypto.getRandomValues(new Uint32Array(1))[0]! || 1;
  pageUrl.searchParams.set("seed", String(dungeonSeed));
  pageUrlChanged = true;
}
if (pageUrlChanged) history.replaceState(null, "", pageUrl);
const editorLevelId = pageUrl.searchParams.get("editor");
const editorLevelRaw = editorLevelId ? localStorage.getItem(`rpg-editor-level:${editorLevelId}`) : null;
if (editorLevelRaw) {
  try {
    configureEditorDungeon(JSON.parse(editorLevelRaw) as EditorDungeonConfig);
  } catch {
    configureDungeon(dungeonSeed);
  }
} else {
  configureDungeon(dungeonSeed);
}

const sceneCanvas = document.getElementById("scene") as HTMLCanvasElement;
const uiCanvas = document.getElementById("ui") as HTMLCanvasElement;
const ctx = uiCanvas.getContext("2d")!;

let graphicsQuality = readGraphicsQuality();
const stage = new RaycastRenderer(sceneCanvas, graphicsQuality);
const connectionStatus = document.getElementById("connection-status")!;
let assetsReady = false;
stage.ready.then(() => { assetsReady = true; connectionStatus.textContent = ""; }).catch(() => {
  connectionStatus.textContent = "Could not load game art. Refresh to retry.";
});
const dungeonFade = document.createElement("div");
Object.assign(dungeonFade.style, {
  position: "fixed", inset: "0", background: "#000", opacity: "0",
  pointerEvents: "none", zIndex: "10000",
});
document.body.appendChild(dungeonFade);

/**
 * How many room units wide the canvas currently is. The room's *height* is
 * always `WORLD_HEIGHT`; its width follows the browser, so this is the number
 * anything centred or right-anchored has to be placed against — and the number
 * a screen coordinate is converted back through.
 */
let viewWidth = WORLD_WIDTH;
let barPositioned = false;
const SHOW_ACTION_BAR = false;
const REGULAR_CURSOR = "default";

function resize() {
  const fit = fillViewport(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  viewWidth = fit.roomWidth;

  uiCanvas.style.width = `${fit.displayWidth}px`;
  uiCanvas.style.height = `${fit.displayHeight}px`;
  uiCanvas.width = fit.pixelWidth;
  uiCanvas.height = fit.pixelHeight;
  // Square room units: both axes get the same scale, since roomWidth was
  // derived from the height and the aspect in the first place.
  ctx.setTransform(fit.pixelWidth / viewWidth, 0, 0, fit.pixelHeight / WORLD_HEIGHT, 0, 0);

  const barSize = actionBarSize(BAR_LAYOUT);
  if (!barPositioned) {
    barOrigin.x = Math.max(9, Math.min(viewWidth - barSize.width, (viewWidth - barSize.width) / 2 + 140));
    barOrigin.y = (WORLD_HEIGHT - barSize.height) / 2 - 105;
    barPositioned = true;
  } else {
    barOrigin.x = Math.max(9, Math.min(viewWidth - barSize.width, barOrigin.x));
    barOrigin.y = Math.max(9, Math.min(WORLD_HEIGHT - barSize.height, barOrigin.y));
  }

  stage.resize(fit.displayWidth, fit.displayHeight, viewWidth);
}

setupGraphicsControl(graphicsQuality, (quality) => {
  graphicsQuality = quality;
  location.reload();
});
window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------- websocket

let prevSnapshot: TacticsSnapshot | null = null;
let currSnapshot: TacticsSnapshot | null = null;
let prevSnapshotTime = 0;
let currSnapshotTime = 0;
let snapshotInterval = SERVER_TICK_MS;

let showPerformance = true;
let statsStorage: Storage | null = null;
try { statsStorage = localStorage; } catch { /* Counters work in memory too. */ }
const floorStats = new FloorStats(statsStorage);
const floorStatsKey = editorLevelId ? `editor:${editorLevelId}:${dungeonSeed}` : String(dungeonSeed);
document.getElementById("export-stats")!.addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([floorStats.csv()], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = "wolf-dungeon-stats.csv";
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});

/** A deliberately faint edge glow, stamped whenever a hound lands a bite. */
let hurt = 0;
const blood = new BloodEffects();
const gemExplosion = new GemExplosion();

const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
const wsQuery = new URLSearchParams({ seed: String(dungeonSeed) });
if (editorLevelId) wsQuery.set("editor", editorLevelId);
const wsUrl = `${wsProtocol}//${location.host}/?${wsQuery}`;
const carriedHealthNumber = Number(carriedHealth);
const carriedHealthProtocol = Number.isFinite(carriedHealthNumber) && carriedHealthNumber > 0
  ? `health-${Math.round(carriedHealthNumber)}` : null;

function connectWebSocket() {
  const ws = carriedHealthProtocol
    ? new WebSocket(wsUrl, carriedHealthProtocol)
    : new WebSocket(wsUrl);

  ws.addEventListener("message", (event) => {
    try {
      const snap = JSON.parse(event.data as string) as TacticsSnapshot;
      if (snap.nextDungeonSeed !== null) {
        const next = new URL(location.href);
        next.searchParams.set("seed", String(snap.nextDungeonSeed));
        next.searchParams.delete("health");
        sessionStorage.setItem(carriedHealthStorageKey, String(Math.max(1, Math.round(snap.stats.health))));
        location.replace(next.toString());
        return;
      }
      if (snap.dead || snap.inspect) cameraDrag = null;
      if (assetsReady) connectionStatus.textContent = "";
      const now = performance.now();
      floorStats.update(floorStatsKey, dungeonSeed, snap);
      if (currSnapshot && snap.stats.health < currSnapshot.stats.health) {
        hurt = 0.32;
      }

      if (currSnapshot) {
        blood.update(currSnapshot, snap, now);
        gemExplosion.update(currSnapshot, snap, now);
      }

      prevSnapshotTime = currSnapshotTime;
      prevSnapshot = currSnapshot;
      currSnapshot = snap;
      currSnapshotTime = performance.now();
      if (prevSnapshot) snapshotInterval = smoothInterval(snapshotInterval, currSnapshotTime - prevSnapshotTime);
    } catch {
      // Ignore malformed messages.
    }
  });

  ws.addEventListener("close", () => {
    connectionStatus.textContent = "Reconnecting…";
    setTimeout(() => { socket = connectWebSocket(); }, 1000);
  });

  ws.addEventListener("error", () => {
    ws.close();
  });

  return ws;
}

let socket = connectWebSocket();

function send(msg: TacticsInput) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

let nextVisibilityReportAt = 0;
let lastVisibleEnemyKey = "";

function reportGargoyleVisibility(snap: TacticsSnapshot, now: number): void {
  if (now < nextVisibilityReportAt) return;
  nextVisibilityReportAt = now + 100;
  const ids = snap.enemies
    .filter((enemy) => enemy.kind === "gargoyle" && stage.isPointVisible(enemy.x, enemy.y))
    .map((enemy) => enemy.id)
    .sort();
  const key = ids.join("|");
  if (key === lastVisibleEnemyKey) return;
  lastVisibleEnemyKey = key;
  send({ type: "enemyVisibility", ids });
}

// ---------------------------------------------------------------- keyboard

/** Direct movement oriented to the camera's current horizontal heading. */

const heldKeys = new Set<string>();
let running = false;

function sendMoveDir(): void {
  const across = Number(heldKeys.has("d")) - Number(heldKeys.has("a"));
  const forward = Number(heldKeys.has("w")) - Number(heldKeys.has("s"));
  const cameraYaw = stage.yaw;
  const dx = Math.cos(cameraYaw) * across - Math.sin(cameraYaw) * forward;
  const dy = -Math.sin(cameraYaw) * across - Math.cos(cameraYaw) * forward;

  send({ type: "move", dx, dy, turn: true, run: running });
}

/**
 * Half-turn on the spot. Purely a camera move — W and S read `stage.yaw`, so
 * turning the view is turning the player — but a held W has to be re-sent, or
 * the server keeps walking them the old way until the key is let go.
 */
function flipAbout() {
  stage.flip();
  if (heldKeys.size > 0) sendMoveDir();
}

/**
 * Wait is the one control that is *held* rather than pressed, so it needs a
 * release for every way a hold can end — key up, mouse up anywhere on the page,
 * and the window losing focus. Miss the last one and tabbing away leaves the
 * world running with hellhounds eating you off-screen, which is precisely what
 * the pause exists to prevent.
 */
let waitHeld = false;
function holdWait(held: boolean) {
  if (held === waitHeld) return; // idempotent: key auto-repeat must not spam
  waitHeld = held;
  send({ type: "wait", held });
}
window.addEventListener("blur", () => {
  holdWait(false);
  if (running || heldKeys.size > 0) {
    running = false;
    heldKeys.clear();
    sendMoveDir();
  }
});
document.addEventListener("visibilitychange", () => { if (document.hidden) holdWait(false); });

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if (key === "escape") cameraDrag = null;

  if (event.key === "Shift") {
    if (!running) {
      running = true;
      sendMoveDir();
    }
    event.preventDefault();
    return;
  }

  if (key === ".") {
    holdWait(true);
    event.preventDefault();
    return;
  }

  // Firefox opens quick-find on "/", so this has to be swallowed either way.
  if (key === "/") {
    if (!event.repeat) flipAbout();
    event.preventDefault();
    return;
  }

  if (event.code === "Tab") {
    event.preventDefault();
    if (!event.repeat) send({ type: "keydown", key, code: event.code });
    return;
  }

  if (key === "v") {
    stage.resetView();
    if (heldKeys.size > 0) sendMoveDir();
    event.preventDefault();
    return;
  }

  if (key === "f") {
    // Keep the over-the-shoulder camera while reserving F from gameplay.
    event.preventDefault();
    return;
  }

  if (key === "h") {
    if (!event.repeat) {
      showPerformance = !showPerformance;
    }
    event.preventDefault();
    return;
  }

  // Direct movement keys.
  if (key === "w" || key === "a" || key === "s" || key === "d" ||
      key === "arrowleft" || key === "arrowright" ||
      key === "arrowup" || key === "arrowdown") {
    const mapped = key === "arrowup" ? "w"
      : key === "arrowdown" ? "s"
      : key === "arrowleft" ? "a"
      : key === "arrowright" ? "d"
      : key;
    if (!heldKeys.has(mapped)) {
      heldKeys.add(mapped);
      sendMoveDir();
    }
    event.preventDefault();
    return;
  }

  // 1-5 choose a weapon, Space attacks, r restarts, escape drops the mark.
  if (
    (key.length === 1 && key >= "1" && key <= "5") ||
    key === "r" ||
    key === "e" ||
    key === "escape" ||
    key === " "
  ) {
    send({ type: "keydown", key, code: event.code });
    event.preventDefault();
  }
});

window.addEventListener("keyup", (event) => {
  const key = event.key.toLowerCase();
  if (event.key === "Shift") {
    running = false;
    sendMoveDir();
    return;
  }
  if (key === ".") { holdWait(false); return; }
  const mapped = key === "arrowup" ? "w"
    : key === "arrowdown" ? "s"
    : key === "arrowleft" ? "a"
    : key === "arrowright" ? "d"
    : key;
  if (heldKeys.has(mapped)) {
    heldKeys.delete(mapped);
    sendMoveDir();
  }
});

// --------------------------------------------------------------- pointer

/** Mouse position in the overlay's room units — where the UI is hit-tested. */
function toOverlay(event: MouseEvent): Point {
  const bounds = uiCanvas.getBoundingClientRect();
  return {
    x: (event.clientX - bounds.left) * (viewWidth / bounds.width),
    y: (event.clientY - bounds.top) * (WORLD_HEIGHT / bounds.height),
  };
}

// --------------------------------------------------------------- mouse-look
let uiCursor: Point | null = null;
let groundCursor: Point | null = null;
let cameraDrag: { startX: number; startY: number; x: number; y: number; moved: boolean } | null = null;
document.getElementById("play-help")!.textContent =
  "WASD move · right-drag camera · V reset · left-click bite · scroll zoom · E eat · Shift run";
uiCanvas.addEventListener("mousedown", (event) => {
  if (event.button !== 2) return;
  if (!currSnapshot || currSnapshot.dead || currSnapshot.inspect) return;
  cameraDrag = { startX: event.clientX, startY: event.clientY,
    x: event.clientX, y: event.clientY, moved: false };
  event.preventDefault();
});
document.addEventListener("mousemove", (event) => {
  if (cameraDrag && !(event.buttons & 2)) cameraDrag = null;
  if (cameraDrag) {
    const drag = cameraDrag;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 4) {
      drag.moved = true;
    }
    if (drag.moved) {
      const bounds = uiCanvas.getBoundingClientRect();
      stage.look((event.clientX - drag.x) / bounds.width * 2,
        -(event.clientY - drag.y) / bounds.height * 2);
      if (heldKeys.size > 0) sendMoveDir();
      uiCursor = null;
    }
    drag.x = event.clientX; drag.y = event.clientY;
  } else if (event.target === uiCanvas) uiCursor = toOverlay(event);
});
document.addEventListener("mouseup", (event) => {
  if (event.button === 2) cameraDrag = null;
});
window.addEventListener("blur", () => { cameraDrag = null; });
uiCanvas.addEventListener("mouseleave", () => { uiCursor = null; groundCursor = null; });
uiCanvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? window.innerHeight : 1;
  stage.zoom(event.deltaY * unit);
}, { passive: false });
uiCanvas.addEventListener("contextmenu", (event) => event.preventDefault());

// ----------------------------------------------------------------- clicking

uiCanvas.addEventListener("click", (event) => {
  const uiPoint = toOverlay(event);
  if (SHOW_ACTION_BAR && hits(actionBarHandleRect(barOrigin), uiPoint)) return;

  // The HUD's own buttons first, exactly as in the other two clients — here
  // they restart the encounter rather than revive you mid-fight.
  if (currSnapshot?.dead && hitsRect(deathResurrectRect(viewWidth), uiPoint)) {
    send({ type: "resurrect" });
    return;
  }

  const slot = SHOW_ACTION_BAR ? squareAtPoint(barOrigin, uiPoint, BAR_LAYOUT) : null;
  if (slot !== null) {
    if (TACTICS_ACTIONS[slot]) send({ type: "useSlot", index: slot });
    return;
  }

  if (currSnapshot?.inspect) {
    // The menu is drawn shifted to sit centred on a wide canvas, so a click on
    // it has to be shifted back before the server, which knows only the
    // 1200-unit room its rectangle lives in, is asked about it.
    const shift = centreShift(viewWidth);
    const point = lootMenuProxyPoint({ x: uiPoint.x - shift, y: uiPoint.y });
    send({ type: "click", x: point.x, y: point.y });
    return;
  }

  // Left click bites. The server's forward cone determines
  // whether an enemy is close enough and sufficiently in front to be hit.
  send({ type: "useSlot", index: 0 });
});

let appliedCursor = REGULAR_CURSOR;

function updateCursorStyle(snap: TacticsSnapshot) {
  let wanted = REGULAR_CURSOR;
  if (uiCursor) {
    if (SHOW_ACTION_BAR && hits(actionBarHandleRect(barOrigin), uiCursor)) wanted = "grab";
    else if (snap.inspect && hitsRect(LOOT_CLOSE_RECT, { x: uiCursor.x - centreShift(viewWidth), y: uiCursor.y })) wanted = "pointer";
    else if (snap.dead && hitsRect(deathResurrectRect(viewWidth), uiCursor)) wanted = "pointer";
    else if (SHOW_ACTION_BAR && squareAtPoint(barOrigin, uiCursor, BAR_LAYOUT) !== null) wanted = "pointer";
  }

  if (wanted !== appliedCursor) {
    uiCanvas.style.cursor = wanted;
    appliedCursor = wanted;
  }
}

// ------------------------------------------------------------- board paint

// ----------------------------------------------------------------- game loop

function toScreen(px: number, py: number, height: number): Point {
  return stage.project(px, py, height);
}
let fpsAt = performance.now(), fpsFrames = 0;
const performanceLabel = document.getElementById("performance")!;

let lastFrameTime = performance.now();
let nextFrameTime = 0;

function frame(now: number) {
  requestAnimationFrame(frame);

  if (document.hidden) return;
  const interval = 1000 / GRAPHICS_PRESETS[graphicsQuality].maxFps;
  if (now < nextFrameTime - 0.5) return;
  // Keep the cadence on high-refresh screens without accumulating missed frames.
  nextFrameTime = interval > 0
    ? now + interval - Math.max(0, now - nextFrameTime) % interval : now;

  const dt = Math.min((now - lastFrameTime) / 1000, 0.1);
  lastFrameTime = now;
  hurt = Math.max(0, hurt - dt * 0.8);

  if (!currSnapshot) return;

  const t = renderFraction(now, currSnapshotTime, snapshotInterval, prevSnapshot !== null);
  const snap = prevSnapshot
    ? interpolateSnapshot(prevSnapshot, currSnapshot, t, now - currSnapshotTime)
    : currSnapshot;

  dungeonFade.style.opacity = String(Math.max(0, Math.min(1,
    (snap.dungeonPortal.fallProgress - 0.4) / 0.55,
  )));
  stage.render(snap, now);
  fpsFrames++;
  if (now - fpsAt >= 500) {
    performanceLabel.textContent = showPerformance ? `${Math.round(fpsFrames * 1000 / (now - fpsAt))} FPS` : "";
    performanceLabel.title = `Render: ${stage.renderMs.toFixed(1)} ms`;
    fpsFrames = 0; fpsAt = now;
  }
  reportGargoyleVisibility(snap, now);

  updateCursorStyle(snap);
  drawOverlay(ctx, {
    snap, uiCursor, groundCursor, toScreen, hurt,
    showAutoRes: false,
    showResurrect: false,
    showRoomLabel: false,
    showHoverNames: false,
    showGameClock: false,
    showActionBar: SHOW_ACTION_BAR,
    compactPlayerHud: true,
    enemyHealthBars: { whenAggroed: true, maxDistance: 360, width: 150, height: 18, worldHeight: 3.8 },
    actions: TACTICS_ACTIONS,
    viableActions: snap.viableActions,
    barLayout: BAR_LAYOUT,
    viewWidth,
  });
  if (!snap.inspect) {
    blood.draw(ctx, now, viewWidth, toScreen);
    gemExplosion.draw(ctx, now, toScreen);
  }
  const reticle = selectAttackReticle(snap, (x, y) => stage.isPointVisible(x, y));
  if (reticle) {
    const enemy = reticle.enemy;
    const height = enemy.kind === "bat" ? enemy.altitude ?? 2.25
      : enemy.kind === "spider" ? (enemy.altitude ?? 0) + .45 : 1.35;
    const point = stage.project(enemy.x, enemy.y, height);
    const ready = reticle.inRange && reticle.aligned;
    ctx.save();
    ctx.beginPath(); ctx.arc(point.x, point.y, 19, 0, Math.PI * 2);
    ctx.strokeStyle = "#17120e"; ctx.lineWidth = 5; ctx.stroke();
    ctx.strokeStyle = ready ? "#ffd633" : "#c4bca9"; ctx.lineWidth = 2; ctx.stroke();
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      ctx.beginPath(); ctx.moveTo(point.x + dx * 14, point.y + dy * 14);
      ctx.lineTo(point.x + dx * 24, point.y + dy * 24); ctx.stroke();
    }
    ctx.restore();
  }
  if (!snap.dead && !snap.inspect) {
    const x = viewWidth / 2, y = WORLD_HEIGHT / 2;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x - 4, y); ctx.lineTo(x + 4, y);
    ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.65)"; ctx.lineWidth = 3; ctx.stroke();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)"; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
  }
  drawTacticsChrome(ctx, snap, viewWidth, floorStats.totalDeaths, uiCursor, floorStats.floors.get(floorStatsKey)?.deaths ?? 0);
}

uiCanvas.style.cursor = REGULAR_CURSOR;
requestAnimationFrame(frame);
