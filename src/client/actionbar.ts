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

export function drawActionBar(
  ctx: CanvasRenderingContext2D,
  origin: Point,
  actions: readonly (import("../shared/actions.js").Action | null)[],
  activeIndex: number,
  cooldown: { slot: number; remainingMs: number; totalMs: number } | null = null,
  /** Whether the selected attack is in range of a live target right now. */
  canAttack = false,
  layout: ActionBarLayout = ACTION_BAR_ROW,
): void {
  ctx.setLineDash([]);
  const size = actionBarSize(layout);
  drawPanelBacking(ctx, origin, size.width, size.height);

  // The icons are a fraction of the square rather than fixed, so a bigger
  // square carries a bigger sword instead of the same one adrift in space.
  const swordLength = layout.square * 0.64;
  const daggerLength = layout.square * 0.45;

  for (let i = 0; i < ACTION_SLOTS; i++) {
    const r = squareRect(origin, i, layout);

    ctx.fillStyle = "#141414";
    ctx.fillRect(r.x, r.y, r.width, r.height);

    // The selected attack's border reports whether it would actually land:
    // gold when it's in range of a live target, white when it isn't. The rest
    // stay dim.
    const active = i === activeIndex;
    ctx.strokeStyle = active ? (canAttack ? "#ffd633" : "#ffffff") : "#444444";
    ctx.lineWidth = active ? 2 : 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.width - 1, r.height - 1);

    const action = actions[i];
    if (!action) continue;

    // Corner key label, before the blind so a spent slot darkens it too.
    ctx.font = KEY_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = KEY_COLOR;
    ctx.fillText(`(${i + 1})`, r.x + KEY_INSET, r.y + KEY_INSET);

    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    if (action.kind === "melee") {
      drawDagger(ctx, cx, cy, daggerAngle(0, -1), swordLength, "#d6dbdf"); // upright sword, blade up
    } else {
      drawDagger(ctx, cx, cy, daggerAngle(-1, -1), daggerLength, "#d6dbdf"); // smaller dagger, blade NW
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

}
