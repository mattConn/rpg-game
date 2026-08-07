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

export const ACTION_BAR_WIDTH = ACTION_SLOTS * SQUARE + (ACTION_SLOTS - 1) * GAP;
export const ACTION_BAR_HEIGHT = SQUARE;

/** Centred along the bottom edge by default. */
export const ACTION_BAR_DEFAULT_ORIGIN: Point = {
  x: (WORLD_WIDTH - ACTION_BAR_WIDTH) / 2,
  y: WORLD_HEIGHT - MARGIN - SQUARE,
};

export function clampActionBarOrigin(origin: Point): Point {
  return clampPanelOrigin(origin, ACTION_BAR_WIDTH, ACTION_BAR_HEIGHT);
}

export function squareRect(origin: Point, index: number) {
  return { x: origin.x + index * (SQUARE + GAP), y: origin.y, width: SQUARE, height: SQUARE };
}

/** Index of the slot under a point, or null. */
export function squareAtPoint(origin: Point, point: Point): number | null {
  for (let i = 0; i < ACTION_SLOTS; i++) {
    const r = squareRect(origin, i);
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

export function drawActionBar(
  ctx: CanvasRenderingContext2D,
  origin: Point,
  actions: readonly (import("../shared/actions.js").Action | null)[],
  activeIndex: number,
  cooldown: { slot: number; remainingMs: number; totalMs: number } | null = null,
  /** Whether the selected attack is in range of a live target right now. */
  canAttack = false,
): void {
  ctx.setLineDash([]);
  drawPanelBacking(ctx, origin, ACTION_BAR_WIDTH, ACTION_BAR_HEIGHT);

  for (let i = 0; i < ACTION_SLOTS; i++) {
    const r = squareRect(origin, i);

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

    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    if (action.kind === "melee") {
      drawDagger(ctx, cx, cy, daggerAngle(0, -1), 28, "#d6dbdf"); // upright sword, blade up
    } else {
      drawDagger(ctx, cx, cy, daggerAngle(-1, -1), 20, "#d6dbdf"); // smaller dagger, blade NW
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
