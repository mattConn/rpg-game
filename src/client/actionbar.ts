/** The bottom action bar: a draggable strip of 5 squares holding attacks. */

import { WORLD_HEIGHT, WORLD_WIDTH } from "../shared/constants.js";
import type { Point } from "../shared/movement.js";
import { daggerAngle, drawDagger } from "./combat.js";
import { clampPanelOrigin, drawPanelBacking } from "./panel.js";

// Import shared action types/data and re-export for backward compat.
export { type AttackKind, type Action, ACTIONS } from "../shared/actions.js";

export const ACTION_SLOTS = 5;
const SQUARE = 44;
const GAP = 6;
const MARGIN = 16;

/**
 * **How the five squares are arranged.** The bar began as one strip along the
 * bottom and is still exactly that everywhere it isn't told otherwise; a front
 * end that wants a column of larger squares says so with a layout rather than
 * with a second copy of this file. Everything geometric here — the backing, the
 * hit-test, the cooldown blind — reads the layout, so a caller can never draw
 * one shape and click another.
 */
export interface ActionBarLayout {
  readonly orientation: "row" | "column";
  /** Edge of one square, in room units. The icons are sized from this. */
  readonly square: number;
  readonly gap: number;
  readonly draggable?: boolean;
}

const HANDLE_SIZE = 18;

export function actionBarHandleRect(origin: Point) {
  return { x: origin.x - HANDLE_SIZE / 2, y: origin.y - HANDLE_SIZE / 2, width: HANDLE_SIZE, height: HANDLE_SIZE };
}

/** The original: a horizontal strip of 44px squares. */
export const ACTION_BAR_ROW: ActionBarLayout = { orientation: "row", square: SQUARE, gap: GAP };

/** Stacked, and bigger — the squares carry an icon each with room to read it. */
export const ACTION_BAR_COLUMN: ActionBarLayout = { orientation: "column", square: 56, gap: 8 };

export function actionBarSize(layout: ActionBarLayout = ACTION_BAR_ROW): { width: number; height: number } {
  const along = ACTION_SLOTS * layout.square + (ACTION_SLOTS - 1) * layout.gap;
  return layout.orientation === "row"
    ? { width: along, height: layout.square }
    : { width: layout.square, height: along };
}

export const ACTION_BAR_WIDTH = actionBarSize(ACTION_BAR_ROW).width;
export const ACTION_BAR_HEIGHT = actionBarSize(ACTION_BAR_ROW).height;

/** Centred along the bottom edge by default. */
export const ACTION_BAR_DEFAULT_ORIGIN: Point = {
  x: (WORLD_WIDTH - ACTION_BAR_WIDTH) / 2,
  y: WORLD_HEIGHT - MARGIN - SQUARE,
};

export function clampActionBarOrigin(origin: Point, layout: ActionBarLayout = ACTION_BAR_ROW): Point {
  const { width, height } = actionBarSize(layout);
  return clampPanelOrigin(origin, width, height);
}

export function squareRect(origin: Point, index: number, layout: ActionBarLayout = ACTION_BAR_ROW) {
  const offset = index * (layout.square + layout.gap);
  return layout.orientation === "row"
    ? { x: origin.x + offset, y: origin.y, width: layout.square, height: layout.square }
    : { x: origin.x, y: origin.y + offset, width: layout.square, height: layout.square };
}

/** Index of the slot under a point, or null. */
export function squareAtPoint(origin: Point, point: Point, layout: ActionBarLayout = ACTION_BAR_ROW): number | null {
  for (let i = 0; i < ACTION_SLOTS; i++) {
    const r = squareRect(origin, i, layout);
    if (point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height) {
      return i;
    }
  }
  return null;
}

/** How dark a square goes at the instant of the attack. */
const COOLDOWN_SHADE = "rgba(0, 0, 0, 0.72)";

/**
 * The blind's moving edge — a bright line makes the progress readable. Gold,
 * matching the bar's other "live" accents rather than the white that now means
 * "this attack can't land".
 */
const COOLDOWN_EDGE = "#ffd633";
const COOLDOWN_EDGE_THICKNESS = 1.5;

/**
 * The key that selects a slot, printed in its top-left corner. 1-5 select the
 * slot in every front end, so the label is true everywhere — and in the
 * turn-based game, where choosing a weapon and swinging it are separate acts,
 * the bar has to say which key does the choosing.
 */
const KEY_FONT = "9px monospace";
const KEY_COLOR = "#7a7a7a";
const KEY_INSET = 4;

function drawPotionIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const neckW = size * 0.18;
  const neckTop = cy - size * 0.34;
  const shoulderY = cy - size * 0.08;
  const bottomY = cy + size * 0.32;
  const bodyW = size * 0.58;

  const flask = new Path2D();
  flask.moveTo(cx - neckW / 2, neckTop);
  flask.lineTo(cx + neckW / 2, neckTop);
  flask.lineTo(cx + neckW / 2, shoulderY);
  flask.lineTo(cx + bodyW / 2, bottomY - size * 0.08);
  flask.lineTo(cx + bodyW * 0.39, bottomY);
  flask.lineTo(cx - bodyW * 0.39, bottomY);
  flask.lineTo(cx - bodyW / 2, bottomY - size * 0.08);
  flask.lineTo(cx - neckW / 2, shoulderY);
  flask.closePath();

  ctx.save();
  ctx.clip(flask);
  ctx.fillStyle = "#42a936";
  ctx.fillRect(cx - bodyW / 2, cy + size * 0.05, bodyW, size * 0.3);
  ctx.fillStyle = "rgba(132, 255, 91, 0.38)";
  ctx.fillRect(cx - bodyW * 0.28, cy + size * 0.08, bodyW * 0.13, size * 0.2);
  ctx.restore();

  ctx.strokeStyle = "#b7ced0";
  ctx.lineWidth = Math.max(1.5, size * 0.045);
  ctx.stroke(flask);
  ctx.strokeStyle = "#73898c";
  ctx.beginPath();
  ctx.moveTo(cx - neckW * 0.72, neckTop);
  ctx.lineTo(cx + neckW * 0.72, neckTop);
  ctx.stroke();

  ctx.fillStyle = "#77e85d";
  const bubbles: Array<readonly [number, number, number]> = [
    [-0.18, -0.05, 0.055],
    [0.12, -0.16, 0.04],
    [0.23, -0.02, 0.03],
  ];
  for (const [x, y, radius] of bubbles) {
    ctx.beginPath();
    ctx.arc(cx + size * x, cy + size * y, size * radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawScrollIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  ctx.save();
  ctx.lineJoin = "round";
  const x = cx - size * 0.27;
  const y = cy - size * 0.31;
  const w = size * 0.54;
  const h = size * 0.62;
  const rollH = size * 0.13;

  ctx.fillStyle = "#c9ad72";
  ctx.strokeStyle = "#70512f";
  ctx.lineWidth = Math.max(1.5, size * 0.04);
  ctx.fillRect(x, y + rollH * 0.45, w, h - rollH * 0.9);
  ctx.strokeRect(x, y + rollH * 0.45, w, h - rollH * 0.9);

  // Matching horizontal rolls keep the silhouette square and readable instead
  // of making the parchment look twisted from one corner to the other.
  ctx.fillStyle = "#e0c98e";
  for (const rollY of [y, y + h - rollH]) {
    const roll = new Path2D();
    roll.moveTo(x, rollY);
    roll.lineTo(x + w, rollY);
    roll.quadraticCurveTo(x + w + size * 0.09, rollY + rollH / 2, x + w, rollY + rollH);
    roll.lineTo(x, rollY + rollH);
    roll.quadraticCurveTo(x - size * 0.09, rollY + rollH / 2, x, rollY);
    roll.closePath();
    ctx.fill(roll);
    ctx.stroke(roll);
  }

  ctx.strokeStyle = "#765b38";
  ctx.lineWidth = Math.max(1, size * 0.025);
  for (let row = 0; row < 3; row++) {
    const lineY = y + size * (0.22 + row * 0.1);
    ctx.beginPath();
    ctx.moveTo(x + size * 0.1, lineY);
    ctx.lineTo(x + size * (row === 2 ? 0.39 : 0.44), lineY);
    ctx.stroke();
  }
  ctx.restore();
}

function drawHandIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.58);
  ctx.translate(-cx, -cy);
  ctx.strokeStyle = "#5f4028";
  ctx.lineWidth = Math.max(1.5, size * 0.04);
  ctx.lineJoin = "round";

  // Open palm.
  ctx.fillStyle = "#9ea9ad";
  const palmX = cx - size * 0.19;
  const palmY = cy - size * 0.06;
  ctx.beginPath();
  ctx.roundRect(palmX, palmY, size * 0.38, size * 0.35, size * 0.09);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = "#d2d9db";
  ctx.lineWidth = Math.max(1, size * 0.022);
  for (const plateY of [0.04, 0.15]) {
    ctx.beginPath();
    ctx.moveTo(cx - size * 0.13, cy + size * plateY);
    ctx.lineTo(cx + size * 0.13, cy + size * plateY);
    ctx.stroke();
  }

  // Four clearly separated fingers, spread slightly rather than clenched.
  ctx.lineCap = "round";
  ctx.strokeStyle = "#9ea9ad";
  ctx.lineWidth = size * 0.115;
  for (const [x, top] of [[-0.16, -0.34], [-0.055, -0.43], [0.055, -0.4], [0.16, -0.3]] as const) {
    ctx.beginPath();
    ctx.moveTo(cx + size * x, cy + size * 0.02);
    ctx.lineTo(cx + size * x, cy + size * top);
    ctx.stroke();
  }
  // Dark narrow outlines make the finger gaps survive at icon scale.
  ctx.strokeStyle = "#5f4028";
  ctx.lineWidth = Math.max(1, size * 0.025);
  for (const x of [-0.108, 0, 0.108]) {
    ctx.beginPath();
    ctx.moveTo(cx + size * x, cy - size * 0.02);
    ctx.lineTo(cx + size * x, cy - size * 0.25);
    ctx.stroke();
  }

  // Splayed thumb.
  ctx.strokeStyle = "#9ea9ad";
  ctx.lineWidth = size * 0.12;
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.15, cy + size * 0.08);
  ctx.lineTo(cx - size * 0.34, cy - size * 0.08);
  ctx.stroke();

  // Silver gauntlet cuff beneath the wrist.
  const cuff = new Path2D();
  cuff.moveTo(cx - size * 0.2, cy + size * 0.23);
  cuff.lineTo(cx + size * 0.2, cy + size * 0.23);
  cuff.lineTo(cx + size * 0.25, cy + size * 0.43);
  cuff.lineTo(cx - size * 0.25, cy + size * 0.43);
  cuff.closePath();
  ctx.fillStyle = "#8e999d";
  ctx.strokeStyle = "#404a4e";
  ctx.lineWidth = Math.max(1.5, size * 0.04);
  ctx.fill(cuff);
  ctx.stroke(cuff);
  ctx.strokeStyle = "#c8d0d2";
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.16, cy + size * 0.28);
  ctx.lineTo(cx + size * 0.16, cy + size * 0.28);
  ctx.stroke();
  ctx.restore();
}

export function drawActionBar(
  ctx: CanvasRenderingContext2D,
  origin: Point,
  actions: readonly (import("../shared/actions.js").Action | null)[],
  activeIndex: number,
  cooldown: { slot: number; remainingMs: number; totalMs: number } | null = null,
  /** Whether the selected attack is in range of a live target right now. */
  canAttack = false,
  layout: ActionBarLayout = ACTION_BAR_ROW,
  viableSlots?: readonly boolean[],
): void {
  ctx.setLineDash([]);
  const size = actionBarSize(layout);
  drawPanelBacking(ctx, origin, size.width, size.height);

  // The icons are a fraction of the square rather than fixed, so a bigger
  // square carries a bigger sword instead of the same one adrift in space.
  const swordLength = layout.square * 0.74;
  const daggerLength = layout.square * 0.45;

  for (let i = 0; i < ACTION_SLOTS; i++) {
    const r = squareRect(origin, i, layout);

    ctx.fillStyle = "#141414";
    ctx.fillRect(r.x, r.y, r.width, r.height);

    // The selected attack's border reports whether it would actually land:
    // gold when it's in range of a live target, white when it isn't. The rest
    // stay dim.
    const active = i === activeIndex;
    const viable = viableSlots?.[i] ?? (active && canAttack);
    ctx.strokeStyle = viable ? "#ffd633" : active ? "#ffffff" : "#444444";
    ctx.lineWidth = viable || active ? 2 : 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.width - 1, r.height - 1);

    const action = actions[i];
    const placeholder = i === 2 ? "potion" : i === 3 ? "spell" : null;
    if (!action && !placeholder) continue;

    // Corner key label, before the blind so a spent slot darkens it too.
    ctx.font = KEY_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = KEY_COLOR;
    if (action) ctx.fillText(`(${i + 1})`, r.x + KEY_INSET, r.y + KEY_INSET);

    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    if (placeholder === "potion") {
      drawPotionIcon(ctx, cx, cy, layout.square * 0.78);
    } else if (placeholder === "spell") {
      drawScrollIcon(ctx, cx, cy, layout.square * 0.78);
    } else if (action?.kind === "interact") {
      drawHandIcon(ctx, cx, cy, layout.square * 0.78);
    } else if (action?.kind === "melee") {
      drawDagger(ctx, cx, cy, daggerAngle(0, -1), swordLength, "#d6dbdf", "#543725", true); // upright sword, blade up
    } else if (action) {
      drawDagger(ctx, cx, cy, daggerAngle(-1, -1), daggerLength, "#d6dbdf", "#33231d"); // smaller dagger, blade NW
    }

    // Cooldown blind. Drawn last so it darkens the icon too: full square at the
    // moment of the attack, then its bottom edge rises like a blind being
    // pulled up, so the square refills with colour from the bottom.
    if (cooldown && cooldown.slot === i && cooldown.totalMs > 0) {
      const fraction = Math.max(0, Math.min(1, cooldown.remainingMs / cooldown.totalMs));
      const height = r.height * fraction;
      if (height > 0) {
        const x = r.x + 1;
        const y = r.y + 1;
        const width = r.width - 2;
        const shadeHeight = Math.max(0, height - 2);

        ctx.fillStyle = COOLDOWN_SHADE;
        ctx.fillRect(x, y, width, shadeHeight);

        // Bright line on the moving edge. Pulled fully inside the square so it
        // stays visible at both ends of the sweep rather than being clipped by
        // the border when the blind is full.
        const edgeY = Math.min(y + shadeHeight, r.y + r.height - 1 - COOLDOWN_EDGE_THICKNESS);
        ctx.fillStyle = COOLDOWN_EDGE;
        ctx.fillRect(x, edgeY, width, COOLDOWN_EDGE_THICKNESS);
      }
    }
  }

  if (layout.draggable) {
    const handle = actionBarHandleRect(origin);
    ctx.fillStyle = "#242424";
    ctx.fillRect(handle.x, handle.y, handle.width, handle.height);
    ctx.strokeStyle = "#777777";
    ctx.lineWidth = 1;
    ctx.strokeRect(handle.x + 0.5, handle.y + 0.5, handle.width - 1, handle.height - 1);
    ctx.fillStyle = "#a6a6a6";
    for (const offset of [5, 9, 13]) {
      ctx.beginPath();
      ctx.arc(handle.x + offset, handle.y + offset, 1.25, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
