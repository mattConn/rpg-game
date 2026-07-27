/** The bottom action bar: a draggable strip of 5 squares holding attacks. */

import { WORLD_HEIGHT, WORLD_WIDTH } from "../shared/constants.js";
import type { Point } from "../shared/movement.js";
import { daggerAngle, drawDagger } from "./combat.js";
import { clampPanelOrigin, drawHandle, drawPanelBacking } from "./panel.js";

export type AttackKind = "melee" | "ranged";

export interface Action {
  id: string;
  kind: AttackKind;
}

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

/** The two attacks live in the first two slots; the rest are placeholders. */
export const ACTIONS: (Action | null)[] = [
  { id: "attack", kind: "melee" },
  { id: "ranged", kind: "ranged" },
  null,
  null,
  null,
];

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

export function drawActionBar(
  ctx: CanvasRenderingContext2D,
  origin: Point,
  actions: readonly (Action | null)[],
  activeIndex: number,
): void {
  ctx.setLineDash([]);
  drawPanelBacking(ctx, origin, ACTION_BAR_WIDTH, ACTION_BAR_HEIGHT);

  for (let i = 0; i < ACTION_SLOTS; i++) {
    const r = squareRect(origin, i);

    ctx.fillStyle = "#141414";
    ctx.fillRect(r.x, r.y, r.width, r.height);

    // The selected attack gets a yellow border; the rest a dim one.
    const active = i === activeIndex;
    ctx.strokeStyle = active ? "#ffd633" : "#444444";
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
  }

  drawHandle(ctx, origin);
}
