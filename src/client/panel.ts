/** Shared chrome for the draggable overlays: the gold grab handle and clamping. */

import { WORLD_HEIGHT, WORLD_WIDTH } from "../shared/constants.js";
import { clamp, type Point } from "../shared/movement.js";

/** Backing inset around a panel's contents. */
export const PANEL_PADDING = 4;

/** The handle is drawn small, but given a more forgiving grab area. */
export const HANDLE_RADIUS = 4;
export const HANDLE_HIT_RADIUS = 9;
const HANDLE_COLOR = "#e3c04a";

/** Panels are anchored by their top-left corner, which is where the handle sits. */
export function isOverHandle(origin: Point, point: Point): boolean {
  return Math.hypot(point.x - origin.x, point.y - origin.y) <= HANDLE_HIT_RADIUS;
}

/** Keep a panel — backing and handle included — fully on the canvas. */
export function clampPanelOrigin(origin: Point, width: number, height: number): Point {
  const edge = PANEL_PADDING + HANDLE_RADIUS;
  return {
    x: clamp(origin.x, edge, WORLD_WIDTH - width - edge),
    y: clamp(origin.y, edge, WORLD_HEIGHT - height - edge),
  };
}

export function drawPanelBacking(ctx: CanvasRenderingContext2D, origin: Point, width: number, height: number) {
  ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
  ctx.fillRect(
    origin.x - PANEL_PADDING,
    origin.y - PANEL_PADDING,
    width + PANEL_PADDING * 2,
    height + PANEL_PADDING * 2,
  );
}

export function drawHandle(ctx: CanvasRenderingContext2D, origin: Point) {
  ctx.fillStyle = HANDLE_COLOR;
  ctx.beginPath();
  ctx.arc(origin.x, origin.y, HANDLE_RADIUS, 0, Math.PI * 2);
  ctx.fill();
}
