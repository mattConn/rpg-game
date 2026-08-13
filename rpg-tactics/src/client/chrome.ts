/**
 * What a turn-based board needs on top of the real-time UI.
 *
 * The HUD, the action bar, the enemy portrait, the inspect menu, the clock, the
 * world labels and the hurt flash are all drawn by `drawOverlay`, imported whole
 * from the 3D client — this file adds only the things a game with *turns* has
 * that a real-time one doesn't: whose turn it is, what just happened, and what
 * the board is waiting for.
 *
 * It draws after the overlay, so everything here is placed clear of it: the
 * banner sits above the enemy portrait's line, the log above the room label, and
 * the hint between the two in the strip over the action bar.
 */

import { ACTION_BAR_HEIGHT, ACTION_BAR_WIDTH } from "../../../src/client/actionbar.js";
import { WORLD_HEIGHT, WORLD_WIDTH } from "../../../src/shared/constants.js";
import type { Point } from "../../../src/shared/movement.js";
import { isOver, type TacticsSnapshot } from "../shared/tactics.js";

const BANNER_FONT = "bold 17px monospace";
const ROUND_FONT = "12px monospace";
const LOG_FONT = "12px monospace";
const HINT_FONT = "12px monospace";
const OUTCOME_FONT = "bold 34px monospace";
const OUTCOME_SUB_FONT = "13px monospace";

const GOLD = "#ffd633";
const EMBER = "#ff8c1a";
const DIM = "#8a8a8a";

/** Sits above the action bar, which starts at y = 840. */
const HINT_Y = WORLD_HEIGHT - 76;
/** Above the room label at y = 888. */
const LOG_BOTTOM = WORLD_HEIGHT - 34;
const LOG_LINE_HEIGHT = 15;

export function drawTacticsChrome(
  ctx: CanvasRenderingContext2D,
  snap: TacticsSnapshot,
  barOrigin: Point,
  cursor: Point | null,
): void {
  ctx.setLineDash([]);
  drawTurnBanner(ctx, snap);
  drawLog(ctx, snap);
  drawHint(ctx, snap);
  drawTurnButtons(ctx, snap, barOrigin, cursor);
  if (isOver(snap.phase)) drawOutcome(ctx, snap);
}

// ------------------------------------------------------------ turn buttons

/**
 * The two buttons that actually spend a turn, stacked to the right of the
 * action bar:
 *
 * ```
 *   [1] [2] [ ] [ ] [ ]  (Space) Attack
 *                        (.)     Wait
 * ```
 *
 * They are separate from the bar on purpose. The bar's squares choose *what* is
 * in your hand and cost nothing; these commit the turn. Putting the two kinds of
 * press in two different places is what stops a weapon swap from accidentally
 * being a swing.
 */
const TURN_BUTTON_GAP = 6;
const TURN_BUTTON_WIDTH = 132;
/** Two rows sharing the action bar's height exactly, so the strip reads as one. */
const TURN_BUTTON_HEIGHT = (ACTION_BAR_HEIGHT - TURN_BUTTON_GAP) / 2;

const TURN_BUTTON_FONT = "12px monospace";
const TURN_KEY_FONT = "10px monospace";

export interface Rect { x: number; y: number; width: number; height: number }

export const hitsButton = (r: Rect, p: Point): boolean =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

/** Attack sits on top — it is the one you reach for. */
export function attackRect(barOrigin: Point): Rect {
  return {
    x: barOrigin.x + ACTION_BAR_WIDTH + TURN_BUTTON_GAP,
    y: barOrigin.y,
    width: TURN_BUTTON_WIDTH,
    height: TURN_BUTTON_HEIGHT,
  };
}

export function waitRect(barOrigin: Point): Rect {
  const above = attackRect(barOrigin);
  return { ...above, y: above.y + TURN_BUTTON_HEIGHT + TURN_BUTTON_GAP };
}

function drawTurnButton(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  keyLabel: string,
  label: string,
  color: string,
  hovered: boolean,
): void {
  ctx.fillStyle = "#141414";
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.strokeStyle = hovered ? "#ffffff" : color;
  ctx.lineWidth = hovered ? 2 : 1;
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);

  const cy = rect.y + rect.height / 2;
  ctx.textBaseline = "middle";

  // Key on the left, dimmer than the word it belongs to.
  ctx.font = TURN_KEY_FONT;
  ctx.textAlign = "left";
  ctx.fillStyle = "#7a7a7a";
  ctx.fillText(keyLabel, rect.x + 8, cy);

  ctx.font = TURN_BUTTON_FONT;
  ctx.fillStyle = color;
  ctx.fillText(label, rect.x + 62, cy);
}

function drawTurnButtons(
  ctx: CanvasRenderingContext2D,
  snap: TacticsSnapshot,
  barOrigin: Point,
  cursor: Point | null,
): void {
  const yours = snap.phase === "player" && !isOver(snap.phase);

  // Gold when the swing would land, plain white when it would only spend the
  // turn, grey when it isn't yours to spend. Same three-state reading as the
  // selected slot's border, so the two never disagree.
  const attack = attackRect(barOrigin);
  const wait = waitRect(barOrigin);

  drawTurnButton(
    ctx,
    attack,
    "(Space)",
    "Attack",
    !yours ? "#444444" : snap.selectedCanAttack ? GOLD : "#ffffff",
    !!cursor && yours && hitsButton(attack, cursor),
  );

  drawTurnButton(
    ctx,
    wait,
    "(.)",
    "Wait",
    yours ? "#cccccc" : "#444444",
    !!cursor && yours && hitsButton(wait, cursor),
  );
}

/**
 * Whose turn it is, centred at the top. This is the one thing the real-time UI
 * has no vocabulary for at all — every other piece of state on screen was
 * already something the action bar or the HUD could say.
 */
function drawTurnBanner(ctx: CanvasRenderingContext2D, snap: TacticsSnapshot): void {
  if (isOver(snap.phase)) return;

  const yours = snap.phase === "player";
  const label = yours ? "YOUR TURN" : "THE PACK MOVES";

  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  ctx.font = ROUND_FONT;
  ctx.fillStyle = DIM;
  ctx.fillText(`Round ${snap.round}`, WORLD_WIDTH / 2, 16);

  ctx.font = BANNER_FONT;
  ctx.fillStyle = yours ? GOLD : EMBER;
  ctx.fillText(label, WORLD_WIDTH / 2, 32);

  // A quiet note while the pack is still asleep — it explains why nothing is
  // happening between your turns, which otherwise reads as a broken loop.
  if (!snap.aggro) {
    ctx.font = ROUND_FONT;
    ctx.fillStyle = DIM;
    ctx.fillText("the hounds have not moved", WORLD_WIDTH / 2, 54);
  }
}

/** The last few things that happened, oldest at the top and fading upward. */
function drawLog(ctx: CanvasRenderingContext2D, snap: TacticsSnapshot): void {
  ctx.font = LOG_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";

  const lines = snap.log;
  lines.forEach((line, i) => {
    const fromBottom = lines.length - 1 - i;
    // Newest is white; each older line is dimmer, so the eye lands on the tail.
    const shade = Math.max(0.3, 1 - fromBottom * 0.22);
    ctx.fillStyle = `rgba(220, 220, 220, ${shade.toFixed(2)})`;
    ctx.fillText(line, 14, LOG_BOTTOM - fromBottom * LOG_LINE_HEIGHT);
  });
}

/** One line over the action bar saying what the board wants from you. */
function drawHint(ctx: CanvasRenderingContext2D, snap: TacticsSnapshot): void {
  if (isOver(snap.phase)) return;

  ctx.font = HINT_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = snap.phase === "player" ? "#cccccc" : DIM;
  ctx.fillText(snap.hint, WORLD_WIDTH / 2, HINT_Y);
}

/** The end of the encounter, centred over the board. */
function drawOutcome(ctx: CanvasRenderingContext2D, snap: TacticsSnapshot): void {
  const { title, color } =
    snap.phase === "escaped"
      ? { title: "ESCAPED", color: GOLD }
      : snap.phase === "cleared"
        ? { title: "PACK SLAIN", color: "#9fe8ff" }
        : { title: "KILLED", color: "#c0392b" };

  const cy = WORLD_HEIGHT * 0.34;

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // A slab behind it: over a lit floor, unbacked text at this size disappears.
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillRect(WORLD_WIDTH / 2 - 220, cy - 40, 440, 80);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(WORLD_WIDTH / 2 - 220, cy - 40, 440, 80);

  ctx.font = OUTCOME_FONT;
  ctx.fillStyle = color;
  ctx.fillText(title, WORLD_WIDTH / 2, cy - 10);

  ctx.font = OUTCOME_SUB_FONT;
  ctx.fillStyle = DIM;
  ctx.fillText(snap.hint, WORLD_WIDTH / 2, cy + 22);
}
