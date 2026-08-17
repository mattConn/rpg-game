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

import { ACTION_BAR_COLUMN, actionBarSize } from "../../../src/client/actionbar.js";
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
  if (snap.paused && !isOver(snap.phase)) drawStanding(ctx, snap.aggro);
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
/**
 * **The bar is a stack on the left here, under the player's status**, rather
 * than the strip along the bottom the other two front ends draw. It is the same
 * `drawActionBar`, handed a different `ActionBarLayout` — the layout travels to
 * the drawing, the hit-test and these buttons from this one constant, so they
 * cannot end up describing different rectangles.
 */
export const BAR_LAYOUT = ACTION_BAR_COLUMN;
const BAR_SIZE = actionBarSize(BAR_LAYOUT);

const TURN_BUTTON_GAP = 6;
/** Shallower than a slot, so it reads as a button rather than a sixth weapon. */
const TURN_BUTTON_HEIGHT = Math.round(BAR_LAYOUT.square * 0.62);

const TURN_BUTTON_FONT = "12px monospace";
const TURN_KEY_FONT = "10px monospace";

export interface Rect { x: number; y: number; width: number; height: number }

export const hitsButton = (r: Rect, p: Point): boolean =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

/**
 * **The foot of the stack**, squared off to the column's own width so the whole
 * left edge reads as one object: five weapons, then the thing that swings the
 * one you picked. Beside the bar it needed a width of its own and left the
 * column looking like half a UI.
 *
 * Wait went with the turns entirely: the button, the `.` binding and the `wait`
 * message are all gone, and the server had already stopped handling it. A
 * button for passing time is meaningless in a world that only runs while you
 * act — holding still *is* the pause now.
 */
export function attackRect(barOrigin: Point): Rect {
  return {
    x: barOrigin.x,
    y: barOrigin.y + BAR_SIZE.height + TURN_BUTTON_GAP,
    width: BAR_SIZE.width,
    height: TURN_BUTTON_HEIGHT,
  };
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

  // Stacked, not side by side: at the column's width there is no room for a
  // key and a word on one line, and the word has to stay the readable one.
  const cx = rect.x + rect.width / 2;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.font = TURN_BUTTON_FONT;
  ctx.fillStyle = color;
  ctx.fillText(label, cx, rect.y + rect.height * 0.36);

  ctx.font = TURN_KEY_FONT;
  ctx.fillStyle = "#7a7a7a";
  ctx.fillText(keyLabel, cx, rect.y + rect.height * 0.72);
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

  drawTurnButton(
    ctx,
    attack,
    "(Space)",
    "Attack",
    !yours ? "#444444" : snap.selectedCanAttack ? GOLD : "#ffffff",
    !!cursor && yours && hitsButton(attack, cursor),
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

/**
 * A standing world needs saying, or a frozen hellhound reads as a hung server.
 * It sits high and centred rather than over the bar, because the hint line is
 * already carrying the sentence — this is just the state, where the eye is.
 *
 * **What a still world means depends on whether anything has noticed you**, and
 * since only acts spend time, in a fight it is still *most* of the time. A
 * PAUSED banner hanging over every exchange would read as the game having hung
 * at the exact moments it is waiting on the player hardest. With the pack awake
 * the same stillness is the player's turn, so that is what it says.
 */
function drawStanding(ctx: CanvasRenderingContext2D, awake: boolean): void {
  const y = WORLD_HEIGHT * 0.12;
  const label = awake ? "YOUR TURN" : "PAUSED";

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "600 26px monospace";
  // Outlined, like the damage numbers: it can land over lit stone, the glow of
  // the doorway, or the black of the corridor, and has to stay legible over all
  // three.
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
  ctx.strokeText(label, WORLD_WIDTH / 2, y);
  ctx.fillStyle = "#ffd633";
  ctx.fillText(label, WORLD_WIDTH / 2, y);
}

/** The end of the encounter, centred over the board. */
function drawOutcome(ctx: CanvasRenderingContext2D, snap: TacticsSnapshot): void {
  // Two outcomes now. Walking out of the room used to be a third, and is not an
  // outcome at all any more — you just leave, and the fight comes with you.
  const { title, color } =
    snap.phase === "cleared"
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
