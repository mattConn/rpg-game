/** The 3x3 dungeon map, draggable by the gold handle at its top-left corner. */

import {
  DUNGEON_COLS,
  DUNGEON_ROWS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  sameRoom,
  type RoomCoord,
} from "../shared/constants.js";
import type { Point } from "../shared/movement.js";
import {
  HANDLE_RADIUS,
  HANDLE_HIT_RADIUS,
  PANEL_PADDING,
  clampPanelOrigin,
  drawHandle,
  drawPanelBacking,
} from "./panel.js";

/** 36 divides into the room's 4:3 ratio exactly, so cells aren't distorted. */
const CELL_WIDTH = 36;
const CELL_HEIGHT = (CELL_WIDTH * WORLD_HEIGHT) / WORLD_WIDTH;

const MARGIN = 14;
const DOT_RADIUS = 2.5;

const WIDTH = CELL_WIDTH * DUNGEON_COLS;
const HEIGHT = CELL_HEIGHT * DUNGEON_ROWS;

/** Top-left of the grid — the map's anchor, and where the handle sits. */
export const DEFAULT_ORIGIN: Point = { x: WORLD_WIDTH - MARGIN - WIDTH, y: MARGIN };

export function clampOrigin(origin: Point): Point {
  return clampPanelOrigin(origin, WIDTH, HEIGHT);
}

/** Where the player's dot sits on the map, given their room and position in it. */
export function dotPosition(origin: Point, room: RoomCoord, x: number, y: number): Point {
  return {
    x: origin.x + room.col * CELL_WIDTH + (x / WORLD_WIDTH) * CELL_WIDTH,
    y: origin.y + room.row * CELL_HEIGHT + (y / WORLD_HEIGHT) * CELL_HEIGHT,
  };
}

export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  origin: Point,
  room: RoomCoord,
  x: number,
  y: number,
  color: string,
) {
  ctx.setLineDash([]);
  ctx.lineWidth = 1;

  drawPanelBacking(ctx, origin, WIDTH, HEIGHT);

  for (let row = 0; row < DUNGEON_ROWS; row++) {
    for (let col = 0; col < DUNGEON_COLS; col++) {
      const cellX = origin.x + col * CELL_WIDTH;
      const cellY = origin.y + row * CELL_HEIGHT;
      const isCurrent = sameRoom(room, { col, row });

      if (isCurrent) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.09)";
        ctx.fillRect(cellX, cellY, CELL_WIDTH, CELL_HEIGHT);
      }

      // Half-pixel offset keeps the 1px grid lines crisp.
      ctx.strokeStyle = isCurrent ? "#6f6f6f" : "#333333";
      ctx.strokeRect(cellX + 0.5, cellY + 0.5, CELL_WIDTH - 1, CELL_HEIGHT - 1);
    }
  }

  const dot = dotPosition(origin, room, x, y);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(dot.x, dot.y, DOT_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  drawHandle(ctx, origin);
}

/** Exposed for tests. */
export const MINIMAP_BOUNDS = {
  WIDTH,
  HEIGHT,
  CELL_WIDTH,
  CELL_HEIGHT,
  PADDING: PANEL_PADDING,
  HANDLE_RADIUS,
  HANDLE_HIT_RADIUS,
};
