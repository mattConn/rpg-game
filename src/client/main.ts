import {
  DIRECTIONS,
  NAME_REVEAL_DISTANCE,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  START_ROOM,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  neighborRoom,
  roomName,
  sameRoom,
  type Direction,
  type PlayerState,
} from "../shared/constants.js";
import {
  MAX_X,
  MAX_Y,
  MIN_X,
  MIN_Y,
  clamp,
  crossEdges,
  doorwayTarget,
  exitAtPoint,
  type Point,
} from "../shared/movement.js";
import {
  ACTIONS,
  ACTION_BAR_DEFAULT_ORIGIN,
  clampActionBarOrigin,
  drawActionBar,
  squareAtPoint,
} from "./actionbar.js";
import {
  FIRE_INTERVAL_MS,
  advanceDagger,
  daggerAngle,
  daggerDone,
  drawDagger,
  spawnDagger,
  type Projectile,
} from "./combat.js";
import { DEFAULT_CURSOR, EXIT_CURSORS } from "./cursors.js";
import { HUD_DEFAULT_ORIGIN, clampHudOrigin, drawHud } from "./hud.js";
import { DEFAULT_ORIGIN, clampOrigin, drawMinimap } from "./minimap.js";
import { isOverHandle } from "./panel.js";
import { type Enemy, drawEnemy, enemyAtPoint } from "./enemies.js";
import { Dungeon, cellCenter, drawTiles, fillWalls, rectBorder, resolveMove, segmentHitsWall } from "./tilemap.js";
import { fitToViewport } from "./viewport.js";

/** Stop click-to-move once this close to the target (px). */
const ARRIVAL_EPSILON = 1.5;

/** How close a melee attacker walks before stopping to strike. */
const ATTACK_RANGE = 44;

const GLYPH_FONT = "20px monospace";
const NAME_FONT = "12px monospace";
const ROOM_LABEL_FONT = "13px monospace";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

/**
 * Grow the canvas to the largest 4:3 rectangle the window allows. Drawing code
 * keeps using room coordinates — the transform maps them onto real pixels, so a
 * bigger window means sharper glyphs, not blurrier ones.
 */
function resizeCanvas() {
  const fit = fitToViewport(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);

  canvas.style.width = `${fit.displayWidth}px`;
  canvas.style.height = `${fit.displayHeight}px`;
  canvas.width = fit.pixelWidth;
  canvas.height = fit.pixelHeight;

  // Resizing the backing store resets the context, so the transform is re-applied here.
  ctx.setTransform(fit.pixelWidth / WORLD_WIDTH, 0, 0, fit.pixelHeight / WORLD_HEIGHT, 0, 0);
}

window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// ---------------------------------------------------------------- player

const FIRST_NAMES = ["Bran", "Kael", "Mira", "Oswin", "Tamsin", "Vek", "Yara", "Dorn", "Isolde", "Rook"];
const LAST_NAMES = ["the Bold", "Ashfoot", "Quickblade", "of Thornvale", "Emberhand", "Greycloak", "the Lost"];

const pick = <T,>(values: readonly T[]): T => values[Math.floor(Math.random() * values.length)]!;

const me: PlayerState = {
  // Always spawn in the middle of the starting vault (centre of the room).
  x: WORLD_WIDTH / 2,
  y: WORLD_HEIGHT / 2,
  color: `hsl(${Math.floor(Math.random() * 360)} 85% 65%)`,
  name: `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
  room: { ...START_ROOM },
};

/** Character sheet values behind the portrait. Nothing damages you yet. */
const stats = {
  level: 1,
  health: 100,
  maxHealth: 100,
  mana: 100,
  maxMana: 100,
};

/** Click-to-move destination, or null when moving by keyboard / standing still. */
let moveTarget: { x: number; y: number } | null = null;

// -------------------------------------------------------------------- tiles

/** Glyph layer over each room. Rendering only — movement runs straight through it. */
const dungeon = new Dungeon();

// A solid-walled vault in the centre of the start room, with a doorway on its
// south side. The player spawns inside it. These walls are solid blocks and
// block movement (the only other tiles — decoration — never do).
fillWalls(
  dungeon.layer(START_ROOM),
  rectBorder(16, 11, 23, 18, [[19, 18], [20, 18]]), // gap on the south wall = doorway
  "#5a6b70",
);

// -------------------------------------------------------------------- enemies

/** Render-only enemies — no stats, no movement yet. */
const enemyStart = cellCenter(36, 5); // near the top-right of the start room
const enemies: Enemy[] = [
  {
    id: "hellhound-1",
    name: "hellhound",
    glyph: "♞",
    color: "#ff8c1a",
    room: { ...START_ROOM },
    x: enemyStart.x,
    y: enemyStart.y,
  },
];

/** The id of the targeted enemy, or null. Single-clicking never moves the player. */
let targetId: string | null = null;

/** Whether the target is being attacked (double-clicked) — draws the ring red. */
let attacking = false;

/** Which action-bar slot is active. Defaults to the melee attack. */
let activeSlot = 0;

/** Thrown daggers in flight, and the clock for the next shot. */
const projectiles: Projectile[] = [];
let lastFireAt = 0;

const activeKind = () => ACTIONS[activeSlot]?.kind ?? "melee";

/** The enemy currently in combat with us, if it's in this room. */
function combatTarget(): Enemy | undefined {
  if (!targetId) return undefined;
  return enemies.find((e) => e.id === targetId && sameRoom(e.room, me.room));
}

/** Stop attacking and drop any daggers still in flight. */
function endCombat() {
  attacking = false;
  projectiles.length = 0;
}

// ---------------------------------------------------------------------- input

const heldKeys = new Set<string>();

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();

  // Number keys 1-5 select the matching action-bar slot (if it holds an attack).
  if (key.length === 1 && key >= "1" && key <= "5") {
    const slot = Number(key) - 1;
    if (ACTIONS[slot]) activeSlot = slot;
    return;
  }

  if (!"wasd".includes(key) || key.length !== 1) return;
  heldKeys.add(key);
  moveTarget = null; // keyboard input cancels a pending click destination
  event.preventDefault();
});

window.addEventListener("keyup", (event) => {
  heldKeys.delete(event.key.toLowerCase());
});

// Holding a key while the tab loses focus would otherwise keep the player moving.
window.addEventListener("blur", () => heldKeys.clear());

/** Convert a mouse event into room coordinates, whatever size we're drawn at. */
function toWorld(event: MouseEvent) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - bounds.left) * (WORLD_WIDTH / bounds.width),
    y: (event.clientY - bounds.top) * (WORLD_HEIGHT / bounds.height),
  };
}

// ----------------------------------------------------------- panel dragging

type PanelName = "map" | "hud" | "bar";

/** Each draggable overlay: its top-left corner and how to keep it on-canvas. */
const panels: Record<PanelName, { origin: Point; clamp: (o: Point) => Point }> = {
  map: { origin: { ...DEFAULT_ORIGIN }, clamp: clampOrigin },
  hud: { origin: { ...HUD_DEFAULT_ORIGIN }, clamp: clampHudOrigin },
  bar: { origin: { ...ACTION_BAR_DEFAULT_ORIGIN }, clamp: clampActionBarOrigin },
};

/** Which handle a point grabs — the nearer one, should they ever overlap. */
function handleUnder(point: Point): PanelName | null {
  let grabbed: PanelName | null = null;
  let grabbedDistance = Infinity;

  for (const name of Object.keys(panels) as PanelName[]) {
    const { origin } = panels[name];
    const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
    if (isOverHandle(origin, point) && distance < grabbedDistance) {
      grabbed = name;
      grabbedDistance = distance;
    }
  }

  return grabbed;
}

/** Where inside the handle the drag started, so the panel doesn't jump on grab. */
let drag: { panel: PanelName; offsetX: number; offsetY: number } | null = null;

/** A mousedown on a handle must not also walk the player to that spot. */
let swallowNextClick = false;

canvas.addEventListener("mousedown", (event) => {
  const point = toWorld(event);
  const panel = handleUnder(point);
  swallowNextClick = panel !== null;

  if (panel) {
    const { origin } = panels[panel];
    drag = { panel, offsetX: point.x - origin.x, offsetY: point.y - origin.y };
    event.preventDefault();
  }
});

// On window, so a drag keeps tracking (and still ends) outside the canvas.
window.addEventListener("mousemove", (event) => {
  if (!drag) return;
  const point = toWorld(event);
  const panel = panels[drag.panel];
  panel.origin = panel.clamp({ x: point.x - drag.offsetX, y: point.y - drag.offsetY });
});

window.addEventListener("mouseup", () => {
  drag = null;
});

canvas.addEventListener("click", (event) => {
  if (swallowNextClick) {
    swallowNextClick = false;
    return;
  }

  const point = toWorld(event);

  // Clicking an action-bar slot selects that attack — nothing else happens.
  const slot = squareAtPoint(panels.bar.origin, point);
  if (slot !== null) {
    if (ACTIONS[slot]) activeSlot = slot;
    return;
  }

  // Left-clicking an enemy targets it (yellow ring) without moving toward it.
  // A single click only selects — the attack itself needs a double-click.
  const clicked = enemyAtPoint(enemies, me.room, point);
  if (clicked) {
    if (clicked.id !== targetId) endCombat();
    targetId = clicked.id;
    return;
  }

  // A click on open ground cancels combat, drops the target, and walks there.
  targetId = null;
  endCombat();
  const exit = exitAtPoint(me.room, point);
  moveTarget = exit
    ? doorwayTarget(exit, point)
    : { x: clamp(point.x, MIN_X, MAX_X), y: clamp(point.y, MIN_Y, MAX_Y) };
});

canvas.addEventListener("dblclick", (event) => {
  const point = toWorld(event);
  const enemy = enemyAtPoint(enemies, me.room, point);
  if (!enemy) return;

  // Double-clicking the enemy you're already fighting cancels combat (the
  // target stays selected, ring back to yellow); otherwise it starts the attack.
  if (attacking && enemy.id === targetId) {
    endCombat();
    moveTarget = null; // stop any melee approach in progress
    return;
  }

  // Double-click begins the attack: target turns red. Melee will approach in
  // the combat update; ranged fires on the next tick.
  targetId = enemy.id;
  attacking = true;
  projectiles.length = 0;
  lastFireAt = 0;
  moveTarget = null;
});

/** Cursor position in room coordinates, or null while the mouse is off-canvas. */
let cursor: { x: number; y: number } | null = null;

canvas.addEventListener("mousemove", (event) => {
  cursor = toWorld(event);
});

canvas.addEventListener("mouseleave", () => {
  cursor = null;
});

/** Swap the mouse pointer for a directional arrow while an exit is hovered. */
let appliedCursor = DEFAULT_CURSOR;

function updateCursorStyle() {
  const exit = cursor ? exitAtPoint(me.room, cursor) : null;

  // Panel dragging outranks the exit arrows — handles sit near the room edges.
  let wanted = DEFAULT_CURSOR;
  if (drag) wanted = "grabbing";
  else if (cursor && handleUnder(cursor)) wanted = "grab";
  else if (exit) wanted = EXIT_CURSORS[exit];

  if (wanted !== appliedCursor) {
    canvas.style.cursor = wanted;
    appliedCursor = wanted;
  }
}

// --------------------------------------------------------------------- update

/**
 * Drive the active attack. Runs before movement so a melee approach can steer
 * the same `moveTarget` the click-to-move system uses.
 */
function updateCombat(now: number, dt: number) {
  const target = combatTarget();

  // The target died or we walked out of its room — combat is off.
  if (attacking && !target) endCombat();

  if (attacking && target) {
    const dx = target.x - me.x;
    const dy = target.y - me.y;
    const distance = Math.hypot(dx, dy) || 1;

    if (activeKind() === "melee") {
      // Walk to just within striking range, then hold.
      moveTarget =
        distance > ATTACK_RANGE
          ? { x: target.x - (dx / distance) * ATTACK_RANGE, y: target.y - (dy / distance) * ATTACK_RANGE }
          : null;
    } else if (now - lastFireAt >= FIRE_INTERVAL_MS) {
      // Ranged: loose a dagger at the enemy on a fixed cadence.
      projectiles.push(spawnDagger({ x: me.x, y: me.y }, { x: target.x, y: target.y }));
      lastFireAt = now;
    }
  }

  // Advance daggers; retire any that reach the enemy, hit a wall, or leave the room.
  const goal = target ? { x: target.x, y: target.y } : { x: -1e4, y: -1e4 };
  const layer = dungeon.get(me.room);
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i]!;
    const px = p.x;
    const py = p.y;
    advanceDagger(p, dt);
    if (segmentHitsWall(layer, px, py, p.x, p.y) || daggerDone(p, goal)) {
      projectiles.splice(i, 1);
    }
  }
}

function applyMovement(dt: number) {
  const x0 = me.x;
  const y0 = me.y;
  let x1 = me.x;
  let y1 = me.y;

  let dx = 0;
  let dy = 0;

  if (heldKeys.has("w")) dy -= 1;
  if (heldKeys.has("s")) dy += 1;
  if (heldKeys.has("a")) dx -= 1;
  if (heldKeys.has("d")) dx += 1;

  if (dx !== 0 || dy !== 0) {
    // Normalise so diagonals aren't faster than the cardinal directions.
    const length = Math.hypot(dx, dy);
    x1 = me.x + (dx / length) * PLAYER_SPEED * dt;
    y1 = me.y + (dy / length) * PLAYER_SPEED * dt;
  } else if (moveTarget) {
    const toX = moveTarget.x - me.x;
    const toY = moveTarget.y - me.y;
    const distance = Math.hypot(toX, toY);
    const step = PLAYER_SPEED * dt;

    if (distance <= Math.max(step, ARRIVAL_EPSILON)) {
      x1 = moveTarget.x;
      y1 = moveTarget.y;
      moveTarget = null;
    } else {
      x1 = me.x + (toX / distance) * step;
      y1 = me.y + (toY / distance) * step;
    }
  }

  // Slide against solid wall cells in this room, then apply the move.
  const moved = resolveMove(dungeon.get(me.room), x0, y0, x1, y1, PLAYER_RADIUS);
  me.x = moved.x;
  me.y = moved.y;

  // Running past an open edge steps into the next room; a closed edge is a wall.
  const crossed = crossEdges(me.room, me.x, me.y);
  me.room = crossed.room;
  me.x = crossed.x;
  me.y = crossed.y;

  // The old destination was in the room you just left.
  if (crossed.exited) moveTarget = null;
}

// --------------------------------------------------------------------- render

/** Walls on the edges that are solid; a dashed threshold on the ones you can cross. */
function drawRoom() {
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

  const inset = 2;
  const edges: Record<Direction, [number, number, number, number]> = {
    north: [0, inset, WORLD_WIDTH, inset],
    south: [0, WORLD_HEIGHT - inset, WORLD_WIDTH, WORLD_HEIGHT - inset],
    west: [inset, 0, inset, WORLD_HEIGHT],
    east: [WORLD_WIDTH - inset, 0, WORLD_WIDTH - inset, WORLD_HEIGHT],
  };

  for (const direction of DIRECTIONS) {
    const open = neighborRoom(me.room, direction) !== null;
    const [x1, y1, x2, y2] = edges[direction];

    ctx.strokeStyle = open ? "#2f4f57" : "#3a3a3a";
    ctx.lineWidth = 4;
    ctx.setLineDash(open ? [10, 12] : []);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  ctx.setLineDash([]);

  // Bottom-left, clear of the portrait panel's default spot in the top-left.
  ctx.font = ROOM_LABEL_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = "#555555";
  ctx.fillText(roomName(me.room), 14, WORLD_HEIGHT - 12);
}

function drawPlayer(x: number, y: number, color: string) {
  ctx.font = GLYPH_FONT;
  ctx.fillStyle = color;
  ctx.fillText("@", x, y);
}

/** Tag under the player — "(You)" — while the cursor is near them. */
function drawLabelIfHovered(x: number, y: number, label: string) {
  if (!cursor || !label) return;
  if (Math.hypot(cursor.x - x, cursor.y - y) > NAME_REVEAL_DISTANCE) return;

  ctx.font = NAME_FONT;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, x, y + PLAYER_RADIUS + 10);
}

function render() {
  drawRoom();

  // Glyph tiles sit on the floor, under the player token.
  drawTiles(ctx, dungeon.get(me.room));

  // Enemies in this room, with the target ring and hover name.
  for (const enemy of enemies) {
    if (!sameRoom(enemy.room, me.room)) continue;
    const showName = !!cursor && Math.hypot(cursor.x - enemy.x, cursor.y - enemy.y) <= NAME_REVEAL_DISTANCE;
    drawEnemy(ctx, enemy, {
      targeted: enemy.id === targetId,
      attacking: attacking && enemy.id === targetId,
      showName,
    });
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (moveTarget) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
    ctx.beginPath();
    ctx.arc(moveTarget.x, moveTarget.y, 5, 0, Math.PI * 2);
    ctx.stroke();
  }

  drawPlayer(me.x, me.y, me.color);
  drawLabelIfHovered(me.x, me.y, "(You)");

  // Daggers in flight, oriented along their travel.
  for (const p of projectiles) {
    drawDagger(ctx, p.x, p.y, daggerAngle(p.vx, p.vy), 20);
  }

  // Overlays, so a player walking underneath can't cover them.
  drawMinimap(ctx, panels.map.origin, me.room, me.x, me.y, me.color);
  drawHud(ctx, panels.hud.origin, { name: me.name, color: me.color, ...stats });
  drawActionBar(ctx, panels.bar.origin, ACTIONS, activeSlot);
}

// ------------------------------------------------------------------ game loop

let lastFrame = performance.now();

function frame(now: number) {
  // Clamped so a backgrounded tab doesn't teleport the player on return.
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  updateCombat(now, dt);
  applyMovement(dt);
  updateCursorStyle();
  render();

  requestAnimationFrame(frame);
}

canvas.style.cursor = DEFAULT_CURSOR;
requestAnimationFrame(frame);
