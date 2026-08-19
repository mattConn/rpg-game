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

import { ACTION_BAR_COLUMN } from "../../../src/client/actionbar.js";
import { HUD_HEIGHT, HUD_WIDTH } from "../../../src/client/hud.js";
import { hudOrigin } from "../../../rpg-3d/src/client/overlay.js";
import { WORLD_HEIGHT, WORLD_WIDTH } from "../../../src/shared/constants.js";
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

/**
 * `viewWidth` is how many room units wide the canvas is right now — the room's
 * height is fixed but its width follows the browser, so everything centred here
 * has to be centred on *this* rather than on `WORLD_WIDTH`.
 */
export function drawTacticsChrome(
  ctx: CanvasRenderingContext2D,
  snap: TacticsSnapshot,
  viewWidth: number = WORLD_WIDTH,
): void {
  ctx.setLineDash([]);
  // Open when something is hunting you, half-lidded when you are merely close
  // enough to wake it. Open wins: a hound already on you is the louder fact.
  if (!isOver(snap.phase) && (snap.aggro || snap.nearAggro)) drawHuntedEye(ctx, !snap.aggro);
  if (isOver(snap.phase)) drawOutcome(ctx, snap, viewWidth);
}

// ----------------------------------------------------------------- hunted eye

const EYE_W = 40;
const EYE_H = 22;
/** Pale, so the red reads as the thing inside it rather than the whole mark. */
const EYE_WHITE = "#e9e4da";
const EYE_PUPIL = "#e03b3b";
const EYE_LID = "#1a1a1a";
/**
 * Where the lid sits when half open, as a fraction of the eye's half-height
 * above centre. Just above the middle: it has to cut the pupil to read as a
 * lid, but leave enough of the red showing to still read as an eye.
 */
const LID_DROP = 0.08;

/**
 * **Something is hunting you — or is about to be.** Three states in one mark:
 * gone when nothing has noticed you, **half-lidded** while you stand inside
 * `AGGRO_WARN_RANGE` of a sleeping hellhound, and **open** once anything is
 * actually awake.
 *
 * The lidded state is a warning with teeth behind it. Aggro is permanent and
 * there are no second chances at it, so the difference between waking one hound
 * and waking two is the difference between a fight you can win and one you
 * cannot — and without this the only way to find the line was to cross it. A
 * half-open eye says *something is stirring* without claiming it has seen you.
 *
 * Open, it marks the encounter rather than tracking a chase: lit from the first
 * bark, out when the last hound dies. It is the one piece of state the player
 * otherwise has to infer from a wolf's posture across a dark room.
 *
 * It sits at the right-hand end of the row directly under the player's status
 * panel. That strip is the only part of the block reliably free in every state:
 * the enemy portrait takes the space to the panel's right, the Resurrect button
 * and the Auto-Res toggle both hang off its *left* under the portrait, and the
 * action bar starts lower down. Anchored to the panel rather than to the canvas
 * so it travels with the status block.
 */
function drawHuntedEye(ctx: CanvasRenderingContext2D, lidded: boolean): void {
  const cx = hudOrigin.x + HUD_WIDTH - EYE_W / 2;
  const cy = hudOrigin.y + HUD_HEIGHT + 20;

  const rx = EYE_W / 2;
  // The control points are pulled to twice the half-height, because a quadratic
  // only reaches halfway to its control at the midpoint — this is what makes
  // the lids meet in points at either corner instead of bulging into an ellipse.
  const lid = EYE_H;

  const almond = new Path2D();
  almond.moveTo(cx - rx, cy);
  almond.quadraticCurveTo(cx, cy - lid, cx + rx, cy);
  almond.quadraticCurveTo(cx, cy + lid, cx - rx, cy);
  almond.closePath();

  ctx.fillStyle = EYE_WHITE;
  ctx.fill(almond);

  // Clipped, so the pupil is cut off by the lids at the top and bottom the way
  // a real one is, rather than sitting on the eye like a sticker.
  ctx.save();
  ctx.clip(almond);
  ctx.fillStyle = EYE_PUPIL;
  ctx.beginPath();
  ctx.arc(cx, cy, EYE_H * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#5c0d0d";
  ctx.beginPath();
  ctx.arc(cx, cy, EYE_H * 0.18, 0, Math.PI * 2);
  ctx.fill();

  // The lid comes *down over* the eye rather than the eye being drawn shorter:
  // a squashed almond reads as a small eye, where a full one with its top
  // covered reads as one half closed.
  //
  // Both the lid and its edge are drawn inside the clip, so they take the
  // almond's own curve at the corners. The edge especially — a straight rule
  // across the full width would jut out past the eye at both ends, since the
  // almond narrows towards its points.
  if (lidded) {
    const lidY = cy - EYE_H * LID_DROP;
    ctx.fillStyle = EYE_LID;
    ctx.fillRect(cx - rx, cy - EYE_H, EYE_W, EYE_H - EYE_H * LID_DROP);

    ctx.lineWidth = 2;
    ctx.strokeStyle = EYE_LID;
    ctx.beginPath();
    ctx.moveTo(cx - rx, lidY);
    ctx.lineTo(cx + rx, lidY);
    ctx.stroke();
  }
  ctx.restore();

  ctx.lineWidth = 2;
  ctx.strokeStyle = EYE_LID;
  ctx.stroke(almond);
}

// ------------------------------------------------------------ the action bar

/**
 * **The bar is a stack on the left here, under the player's status**, rather
 * than the strip along the bottom the other two front ends draw. It is the same
 * `drawActionBar`, handed a different `ActionBarLayout` — the layout travels to
 * the drawing and to the hit-test from this one constant, so the two cannot end
 * up describing different rectangles.
 *
 * **Attack, Wait and Flip used to hang under it as buttons, and no longer do.**
 * The actions are untouched — Space swings, `.` holds time open, `/` turns you
 * about — they simply have no drawn control any more. Nothing hit-tests where
 * they were either: leaving the rectangles behind would have left three
 * invisible dead zones swallowing clicks meant for the floor.
 */
export const BAR_LAYOUT = { ...ACTION_BAR_COLUMN, draggable: true } as const;

/**
 * Whose turn it is, centred at the top. This is the one thing the real-time UI
 * has no vocabulary for at all — every other piece of state on screen was
 * already something the action bar or the HUD could say.
 */
function drawTurnBanner(ctx: CanvasRenderingContext2D, snap: TacticsSnapshot, viewWidth: number): void {
  if (isOver(snap.phase)) return;

  const yours = snap.phase === "player";
  const label = yours ? "YOUR TURN" : "THE PACK MOVES";

  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  ctx.font = ROUND_FONT;
  ctx.fillStyle = DIM;
  ctx.fillText(`Round ${snap.round}`, viewWidth / 2, 16);

  ctx.font = BANNER_FONT;
  ctx.fillStyle = yours ? GOLD : EMBER;
  ctx.fillText(label, viewWidth / 2, 32);

  // A quiet note while the pack is still asleep — it explains why nothing is
  // happening between your turns, which otherwise reads as a broken loop.
  if (!snap.aggro) {
    ctx.font = ROUND_FONT;
    ctx.fillStyle = DIM;
    ctx.fillText("the hounds have not moved", viewWidth / 2, 54);
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
function drawHint(ctx: CanvasRenderingContext2D, snap: TacticsSnapshot, viewWidth: number): void {
  if (isOver(snap.phase)) return;

  ctx.font = HINT_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = snap.phase === "player" ? "#cccccc" : DIM;
  ctx.fillText(snap.hint, viewWidth / 2, HINT_Y);
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
function drawStanding(ctx: CanvasRenderingContext2D, awake: boolean, viewWidth: number): void {
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
  ctx.strokeText(label, viewWidth / 2, y);
  ctx.fillStyle = "#ffd633";
  ctx.fillText(label, viewWidth / 2, y);
}

/** The end of the encounter, centred over the board. */
function drawOutcome(ctx: CanvasRenderingContext2D, snap: TacticsSnapshot, viewWidth: number): void {
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
  ctx.fillRect(viewWidth / 2 - 220, cy - 40, 440, 80);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(viewWidth / 2 - 220, cy - 40, 440, 80);

  ctx.font = OUTCOME_FONT;
  ctx.fillStyle = color;
  ctx.fillText(title, viewWidth / 2, cy - 10);

  ctx.font = OUTCOME_SUB_FONT;
  ctx.fillStyle = DIM;
  ctx.fillText(snap.hint, viewWidth / 2, cy + 22);
}
