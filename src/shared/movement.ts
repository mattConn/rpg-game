/** Pure room-boundary logic, shared so it can be exercised without a browser. */

import {
  DIRECTIONS,
  EDGE_HOVER_MARGIN,
  PLAYER_RADIUS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  neighborRoom,
  type Direction,
  type RoomCoord,
} from "./constants.js";

export const MIN_X = PLAYER_RADIUS;
export const MAX_X = WORLD_WIDTH - PLAYER_RADIUS;
export const MIN_Y = PLAYER_RADIUS;
export const MAX_Y = WORLD_HEIGHT - PLAYER_RADIUS;

export interface Point {
  x: number;
  y: number;
}

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * The exit a point hovers over: the nearest edge within the hover margin that
 * actually leads somewhere. Edges backing onto solid rock offer nothing.
 */
export function exitAtPoint(room: RoomCoord, point: Point): Direction | null {
  const distances: Record<Direction, number> = {
    west: point.x,
    east: WORLD_WIDTH - point.x,
    north: point.y,
    south: WORLD_HEIGHT - point.y,
  };

  let closest: Direction | null = null;
  let closestDistance = EDGE_HOVER_MARGIN;

  for (const direction of DIRECTIONS) {
    const distance = distances[direction];
    if (distance <= closestDistance && neighborRoom(room, direction)) {
      closest = direction;
      closestDistance = distance;
    }
  }

  return closest;
}

/** A destination just past the given edge, so walking there triggers the exit. */
export function doorwayTarget(direction: Direction, point: Point): Point {
  switch (direction) {
    case "west":
      return { x: MIN_X - 1, y: clamp(point.y, MIN_Y, MAX_Y) };
    case "east":
      return { x: MAX_X + 1, y: clamp(point.y, MIN_Y, MAX_Y) };
    case "north":
      return { x: clamp(point.x, MIN_X, MAX_X), y: MIN_Y - 1 };
    case "south":
      return { x: clamp(point.x, MIN_X, MAX_X), y: MAX_Y + 1 };
  }
}

export interface CrossResult extends Point {
  room: RoomCoord;
  /** True when the player left the room they started the frame in. */
  exited: boolean;
}

/**
 * Resolve a position that may have run past the room's edges: step into the
 * neighbouring room through an open edge (entering from its far side), or stop
 * at a wall. At most one exit per call, so cutting a corner diagonally can
 * never skip a room.
 */
export function crossEdges(room: RoomCoord, x: number, y: number): CrossResult {
  let next: RoomCoord = room;
  let exited = false;

  const step = (direction: Direction): boolean => {
    const destination = neighborRoom(room, direction);
    if (!destination) return false;

    next = destination;
    if (direction === "west") x = MAX_X;
    else if (direction === "east") x = MIN_X;
    else if (direction === "north") y = MAX_Y;
    else y = MIN_Y;

    return true;
  };

  if (x < MIN_X) exited = step("west");
  else if (x > MAX_X) exited = step("east");

  if (!exited) {
    if (y < MIN_Y) exited = step("north");
    else if (y > MAX_Y) exited = step("south");
  }

  return { room: next, x: clamp(x, MIN_X, MAX_X), y: clamp(y, MIN_Y, MAX_Y), exited };
}
