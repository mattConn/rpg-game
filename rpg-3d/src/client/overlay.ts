/**
 * The 2D UI, unchanged.
 *
 * The overlay canvas is the same 1200x900 room-unit surface the 2D client draws
 * on, stacked over the WebGL view, and the HUD / action bar / loot menu are the
 * *same modules* the 2D client uses — imported, not reimplemented, so the two
 * front ends can't drift apart.
 *
 * What is new here is only what used to be free in a top-down view: a label
 * that belongs to something in the world now has to be projected from 3D into
 * overlay coordinates first.
 */

import {
  NAME_REVEAL_DISTANCE,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  roomName,
  sameRoom,
} from "../../../src/shared/constants.js";
import type { Point } from "../../../src/shared/movement.js";
import type { GameSnapshot } from "../../../src/shared/protocol.js";
import { ACTIONS } from "../../../src/shared/actions.js";
import type { Action } from "../../../src/shared/actions.js";
import { DAMAGE_NUMBER_LIFETIME, DAMAGE_NUMBER_SPEED } from "../../../src/shared/combat.js";
import { corpseLabel } from "../../../src/shared/loot.js";
import { ACTION_BAR_ROW, ACTION_BAR_DEFAULT_ORIGIN, drawActionBar, type ActionBarLayout } from "../../../src/client/actionbar.js";
import { HUD_DEFAULT_ORIGIN, HUD_WIDTH, NAME_GAP, NAME_HEIGHT, PORTRAIT_SIZE, drawBarsOnlyHud, drawEnemyHud, drawHud } from "../../../src/client/hud.js";
import { drawLootMenu } from "../../../src/client/lootmenu.js";

const NAME_FONT = "12px monospace";
const ROOM_LABEL_FONT = "13px monospace";
const CLOCK_FONT = "13px monospace";
const RESURRECT_FONT = "12px monospace";
const AUTO_RES_FONT = "11px monospace";
const AUTO_RES_LABEL = "Auto-Res";

/** One in-game minute = this many ms of `gameElapsedMs`. Display-only. */
const MS_PER_GAME_MINUTE = 500;

/**
 * Damage numbers. The height is in 3D units and has to clear the *tallest*
 * thing a number can belong to — the player, at 1.9 — or a bite reads as a
 * label on their chest rather than over their head. Over a hellhound, which is
 * barely a unit tall, it simply floats a little higher.
 */
const DAMAGE_NUMBER_HEIGHT = 2.5;
const DAMAGE_NUMBER_RISE_PX = 30;
const DAMAGE_NUMBER_FONT = "bold 36px monospace";
/**
 * Held at full strength for most of its life and then dropped, rather than
 * fading from the instant it appears. A number that starts dying immediately is
 * never legible at the size these are drawn.
 */
const DAMAGE_NUMBER_HOLD = 0.6;

/** Health-bar geometry, matching the 2D client's bar above an enemy glyph. */
const HEALTH_BAR_WIDTH = 34;
const HEALTH_BAR_HEIGHT = 4;

export const hudOrigin: Point = { ...HUD_DEFAULT_ORIGIN };
export const barOrigin: Point = { ...ACTION_BAR_DEFAULT_ORIGIN };

export interface Rect { x: number; y: number; width: number; height: number }

export const hits = (r: Rect, p: Point): boolean =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

/** Centred "Resurrect" button under the name plate — only drawn when dead. */
export function resurrectRect(ctx: CanvasRenderingContext2D): Rect {
  ctx.font = RESURRECT_FONT;
  const width = ctx.measureText("Resurrect").width;
  return {
    x: hudOrigin.x + PORTRAIT_SIZE / 2 - width / 2,
    y: hudOrigin.y + PORTRAIT_SIZE + NAME_GAP + NAME_HEIGHT + 4,
    width,
    height: 12,
  };
}

/** The auto-resurrect toggle, left-aligned under the stats. Always present. */
export function autoResRect(ctx: CanvasRenderingContext2D): Rect {
  ctx.font = AUTO_RES_FONT;
  return {
    x: hudOrigin.x,
    y: hudOrigin.y + PORTRAIT_SIZE + NAME_GAP + NAME_HEIGHT + 22,
    width: ctx.measureText(AUTO_RES_LABEL).width,
    height: 11,
  };
}

/** Projects a point in the room (px, px) at `height` 3D units into overlay space. */
export type ToScreen = (px: number, py: number, height: number) => Point;

export interface OverlayParams {
  snap: GameSnapshot;
  /** Cursor in overlay coordinates — for UI hit-testing (✕, buttons). */
  uiCursor: Point | null;
  /** Cursor projected onto the floor, in room px — for world hover reveals. */
  groundCursor: Point | null;
  toScreen: ToScreen;
  /** 0..1 fading flash after taking a hit. */
  hurt: number;
  /** Tactics replaces this line with the name of the hovered action item. */
  showAutoRes?: boolean;
  /** Optional front-end-specific contents for the shared five-slot bar. */
  actions?: readonly (Action | null)[];
  viableActions?: readonly boolean[];
  /** Hide the action bar without affecting keyboard-driven actions. */
  showActionBar?: boolean;
  /** Allow front ends to suppress ambient edge labels without replacing the HUD. */
  showRoomLabel?: boolean;
  /** Allow front ends to suppress player/enemy cursor-hover names. */
  showHoverNames?: boolean;
  showGameClock?: boolean;
  /** Draw only health and mana in the corner, without portrait or labels. */
  compactPlayerHud?: boolean;
  /** Optional larger, always-visible world bars for front ends with big models. */
  enemyHealthBars?: {
    always?: boolean;
    whenAggroed?: boolean;
    width?: number;
    height?: number;
    worldHeight?: number;
    maxDistance?: number;
  };
  /**
   * How to arrange the action bar. Omitted is the horizontal strip this client
   * has always drawn; the turn-based front end stacks it instead, and passes
   * the same layout to its own hit-testing so the two can't disagree.
   */
  barLayout?: ActionBarLayout;
  /**
   * How many room units wide the canvas is. Omitted is the fixed 4:3 room these
   * two front ends have always drawn; the turn-based client fills the window
   * instead, so its width follows the browser and only the *height* is fixed.
   * Everything anchored to the right edge or centred has to read this rather
   * than `WORLD_WIDTH`, or it lands off-screen on a wide window.
   */
  viewWidth?: number;
}

export function drawOverlay(ctx: CanvasRenderingContext2D, params: OverlayParams): void {
  const { snap, uiCursor, groundCursor, toScreen } = params;
  const barLayout = params.barLayout ?? ACTION_BAR_ROW;
  const viewWidth = params.viewWidth ?? WORLD_WIDTH;

  ctx.clearRect(0, 0, viewWidth, WORLD_HEIGHT);
  ctx.setLineDash([]);

  if (params.showRoomLabel !== false) drawRoomLabel(ctx, snap);
  drawWorldLabels(ctx, snap, groundCursor, toScreen, params.enemyHealthBars, params.showHoverNames !== false);
  drawDamageNumbers(ctx, snap, toScreen);

  const hudStats = { name: snap.player.name, color: snap.player.color, ...snap.stats, dead: snap.dead };
  if (params.compactPlayerHud) drawBarsOnlyHud(ctx, hudOrigin, hudStats);
  else drawHud(ctx, hudOrigin, hudStats);

  if (snap.dead) {
    const rect = resurrectRect(ctx);
    ctx.font = RESURRECT_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = uiCursor && hits(rect, uiCursor) ? "#ffd633" : "#ffffff";
    ctx.fillText("Resurrect", rect.x, rect.y);
  }

  // Auto-resurrect toggle under the stats, with a countdown while one is due —
  // three frozen seconds with no feedback reads as a hang.
  if (params.showAutoRes !== false) {
    const rect = autoResRect(ctx);
    ctx.font = AUTO_RES_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = uiCursor && hits(rect, uiCursor)
      ? "#ffffff"
      : snap.autoResurrect ? "#ffd633" : "#444444";
    ctx.fillText(AUTO_RES_LABEL, rect.x, rect.y);

    if (snap.resurrectInMs !== null) {
      ctx.fillStyle = "#aaaaaa";
      ctx.fillText(`${(snap.resurrectInMs / 1000).toFixed(1)}s`, rect.x + rect.width + 8, rect.y);
    }
  }

  // Enemy portrait next to the player HUD when in combat.
  if (snap.attacking && snap.targetId) {
    const target = snap.enemies.find((e) => e.id === snap.targetId && sameRoom(e.room, snap.player.room));
    if (target) {
      drawEnemyHud(ctx, { x: hudOrigin.x + HUD_WIDTH + 16, y: hudOrigin.y }, {
        name: target.name,
        glyph: target.glyph,
        color: target.color,
        health: target.health,
        maxHealth: target.maxHealth,
      });
    }
  }

  if (params.showActionBar !== false) {
    drawActionBar(
      ctx, barOrigin, params.actions ?? ACTIONS, snap.activeSlot,
      snap.cooldown, snap.selectedCanAttack, barLayout, params.viableActions,
    );
  }
  if (params.showGameClock !== false) drawGameClock(ctx, snap.gameElapsedMs, viewWidth);

  if (params.hurt > 0) drawHurtFlash(ctx, params.hurt, viewWidth);

  // Last, so the inspect menu sits over the overlays as well as the room.
  //
  // Shifted, because its rectangle is the *server's* — `LOOT_MENU_RECT` is
  // centred in the fixed 1200-unit room, and both sides hit-test against it, so
  // it cannot simply be re-centred on a wider canvas. Drawing it offset and
  // taking the offset back off the cursor keeps the panel in the middle of the
  // screen while every coordinate crossing the wire stays in the room the
  // server believes in.
  if (snap.inspect) {
    const shift = centreShift(viewWidth);
    ctx.save();
    ctx.translate(shift, 0);
    drawLootMenu(ctx, snap.inspect, uiCursor ? { x: uiCursor.x - shift, y: uiCursor.y } : null);
    ctx.restore();
  }
}

/**
 * How far to slide furniture whose geometry is pinned to the fixed 1200-unit
 * room so it lands centred on a canvas of `viewWidth`. Zero on the two front
 * ends that still draw a 4:3 room.
 */
export const centreShift = (viewWidth: number): number => (viewWidth - WORLD_WIDTH) / 2;

// ------------------------------------------------------------- world labels

/**
 * Health bars, hover names and the "(You)" tag. In 2D these sat at fixed
 * offsets from a glyph; here each is pinned to a projected point above the
 * thing it describes, but the reveal rule is unchanged — it is still the
 * *floor* distance from the cursor that decides whether a name shows.
 */
function drawWorldLabels(
  ctx: CanvasRenderingContext2D,
  snap: GameSnapshot,
  groundCursor: Point | null,
  toScreen: ToScreen,
  healthBars?: OverlayParams["enemyHealthBars"],
  showHoverNames = true,
): void {
  const near = (x: number, y: number) =>
    !!groundCursor && Math.hypot(groundCursor.x - x, groundCursor.y - y) <= NAME_REVEAL_DISTANCE;

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const stone of snap.tombstones ?? []) {
    if (!sameRoom(stone.room, snap.player.room)) continue;
    if (!near(stone.x, stone.y)) continue;
    const at = toScreen(stone.x, stone.y, 1.2);
    drawStamp(ctx, at, stone.gameElapsedMs);
  }

  for (const corpse of snap.corpses ?? []) {
    if (!sameRoom(corpse.room, snap.player.room)) continue;
    if (!near(corpse.x, corpse.y)) continue;
    const at = toScreen(corpse.x, corpse.y, 0.9);
    ctx.font = NAME_FONT;
    ctx.fillStyle = "#999999";
    ctx.fillText(corpseLabel(corpse), at.x, at.y);
  }

  for (const enemy of snap.enemies) {
    if (!sameRoom(enemy.room, snap.player.room)) continue;

    const closeEnough = healthBars?.maxDistance === undefined ||
      Math.hypot(enemy.x - snap.player.x, enemy.y - snap.player.y) <= healthBars.maxDistance;
    const showHealth = closeEnough && (healthBars?.whenAggroed
      ? enemy.aggro
      : healthBars?.always || enemy.health < enemy.maxHealth);
    if (showHealth) {
      const barHeight = enemy.kind === "bat"
        ? (enemy.altitude ?? 4.2) + 1.3
        : healthBars?.worldHeight ?? 1.55;
      const bar = toScreen(enemy.x, enemy.y, barHeight);
      drawHealthBar(
        ctx,
        bar,
        enemy.health / enemy.maxHealth,
        healthBars?.width ?? HEALTH_BAR_WIDTH,
        healthBars?.height ?? HEALTH_BAR_HEIGHT,
        enemy.health,
        enemy.maxHealth,
      );
    }

    if (showHoverNames && near(enemy.x, enemy.y)) {
      const at = toScreen(enemy.x, enemy.y, enemy.kind === "bat" ? (enemy.altitude ?? 4.2) + 1.65 : 1.9);
      ctx.font = NAME_FONT;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(enemy.name, at.x, at.y);
    }
  }

  if (showHoverNames && near(snap.player.x, snap.player.y)) {
    const at = toScreen(snap.player.x, snap.player.y, 2.25);
    ctx.font = NAME_FONT;
    ctx.fillStyle = "#ffffff";
    ctx.fillText("(You)", at.x, at.y);
  }
}

function drawHealthBar(
  ctx: CanvasRenderingContext2D,
  at: Point,
  fraction: number,
  width: number,
  height: number,
  health: number,
  maxHealth: number,
): void {
  const x = at.x - width / 2;
  const y = at.y - height / 2;

  ctx.fillStyle = "#1b1b1b";
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = "#c0392b";
  ctx.fillRect(x, y, width * Math.max(0, Math.min(1, fraction)), height);
  ctx.strokeStyle = "#080808";
  ctx.lineWidth = Math.max(1, height * 0.12);
  ctx.strokeRect(x, y, width, height);
  ctx.font = `bold ${Math.max(9, height - 2)}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.fillStyle = "#ffffff";
  const label = `${Math.ceil(health)}/${Math.ceil(maxHealth)}`;
  ctx.strokeText(label, at.x, at.y + 0.5);
  ctx.fillText(label, at.x, at.y + 0.5);
}

/**
 * Damage numbers, floating over the head of whatever took the hit.
 *
 * Two corrections are needed to get them there. The server drifts them along
 * the room's **y** axis, which in 3D is depth, so that drift is undone before
 * projecting and reapplied upward — otherwise every hit would creep toward the
 * camera instead of rising. And the number is drawn with a dark outline: over a
 * lit stone floor, in a scene with its own warm highlights, plain coloured text
 * at this size is unreadable about half the time.
 */
function drawDamageNumbers(ctx: CanvasRenderingContext2D, snap: GameSnapshot, toScreen: ToScreen): void {
  ctx.font = DAMAGE_NUMBER_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";

  for (const dn of snap.damageNumbers) {
    const life = Math.min(1, Math.max(0, dn.age / DAMAGE_NUMBER_LIFETIME));
    const alpha = life <= DAMAGE_NUMBER_HOLD ? 1 : 1 - (life - DAMAGE_NUMBER_HOLD) / (1 - DAMAGE_NUMBER_HOLD);

    const originY = dn.y + DAMAGE_NUMBER_SPEED * dn.age;
    const at = toScreen(dn.x, originY, DAMAGE_NUMBER_HEIGHT);
    const y = at.y - life * DAMAGE_NUMBER_RISE_PX;

    const r = parseInt(dn.color.slice(1, 3), 16);
    const g = parseInt(dn.color.slice(3, 5), 16);
    const b = parseInt(dn.color.slice(5, 7), 16);

    ctx.lineWidth = 4;
    ctx.strokeStyle = `rgba(0, 0, 0, ${(alpha * 0.85).toFixed(2)})`;
    ctx.strokeText(dn.text, at.x, y);

    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
    ctx.fillText(dn.text, at.x, y);
  }
}

// -------------------------------------------------------------------- chrome

function drawRoomLabel(ctx: CanvasRenderingContext2D, snap: GameSnapshot): void {
  ctx.font = ROOM_LABEL_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = "#555555";
  ctx.fillText(roomName(snap.player.room), 14, WORLD_HEIGHT - 12);
}

/** Draw a filled time-of-day icon (sun/sunset/moon) centred at (cx, cy). */
function drawTimeIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, hourOfDay: number): void {
  if (hourOfDay >= 6 && hourOfDay < 18) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd633";
    ctx.fill();
  } else if (hourOfDay >= 18 && hourOfDay < 22) {
    ctx.save();
    ctx.translate(cx, cy + r * 0.45);
    ctx.rotate(Math.PI / 2);
    ctx.beginPath();
    ctx.arc(0, 0, r, Math.PI * 0.5, Math.PI * 1.5);
    ctx.fillStyle = "#e68a00";
    ctx.fill();
    ctx.restore();
  } else {
    const moonColor = hourOfDay >= 3 && hourOfDay < 6 ? "#cc3333" : "#ffffff";
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = moonColor;
    ctx.fill();
    // The cutout is drawn in the room's black, which the overlay doesn't have —
    // clear it instead so the 3D view shows through the crescent's bite.
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(cx + r * 0.65, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function clockParts(gameElapsedMs: number) {
  const totalMinutes = Math.floor(gameElapsedMs / MS_PER_GAME_MINUTE);
  const totalHours = Math.floor(totalMinutes / 60);
  const hourOfDay = totalHours % 24;
  const minute = totalMinutes % 60;
  const ampm = hourOfDay < 12 ? "AM" : "PM";
  const display12 = hourOfDay === 0 ? 12 : hourOfDay > 12 ? hourOfDay - 12 : hourOfDay;
  return {
    day: Math.floor(totalHours / 24) + 1,
    hourOfDay,
    time: `${display12}:${String(minute).padStart(2, "0")} ${ampm}`,
  };
}

function drawGameClock(ctx: CanvasRenderingContext2D, gameElapsedMs: number, viewWidth: number): void {
  const { day, hourOfDay, time } = clockParts(gameElapsedMs);
  const margin = 14;
  const x = viewWidth - margin;
  const y = margin;

  ctx.font = CLOCK_FONT;
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#aaaaaa";
  const dayText = `Day ${day}`;
  ctx.fillText(dayText, x, y);

  drawTimeIcon(ctx, x - ctx.measureText(dayText).width - 12, y + 7, 6, hourOfDay);

  ctx.fillStyle = "#aaaaaa";
  ctx.fillText(time, x, y + 16);
}

/** The death stamp on a tombstone: time-of-day icon plus "Day H:MM AM". */
function drawStamp(ctx: CanvasRenderingContext2D, at: Point, gameElapsedMs: number): void {
  const { day, hourOfDay, time } = clockParts(gameElapsedMs);
  const label = `${day} ${time}`;

  ctx.font = NAME_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const iconR = 4;
  const iconGap = 3;
  const startX = at.x - (iconR * 2 + iconGap + ctx.measureText(label).width) / 2;

  drawTimeIcon(ctx, startX + iconR, at.y, iconR, hourOfDay);

  ctx.fillStyle = "#999999";
  ctx.fillText(label, startX + iconR * 2 + iconGap, at.y);
}

/**
 * A red bloom at the edges when something bites you. In the 2D game a hit was
 * obvious — the whole room was on screen. From behind the shoulder it isn't.
 */
function drawHurtFlash(ctx: CanvasRenderingContext2D, strength: number, viewWidth: number): void {
  const gradient = ctx.createRadialGradient(
    viewWidth / 2, WORLD_HEIGHT / 2, WORLD_HEIGHT * 0.3,
    viewWidth / 2, WORLD_HEIGHT / 2, viewWidth * 0.62,
  );
  gradient.addColorStop(0, "rgba(180, 20, 20, 0)");
  gradient.addColorStop(1, `rgba(180, 20, 20, ${(strength * 0.55).toFixed(3)})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, viewWidth, WORLD_HEIGHT);
}
