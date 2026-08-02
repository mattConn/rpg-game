/**
 * Pure enemy logic shared between server and client. No rendering — the client
 * wrapper keeps drawEnemy, drawHealthBar, and rendering constants.
 */

import { CELL_SIZE, sameRoom, type RoomCoord } from "./constants.js";
import { MIN_X, MAX_X, MIN_Y, MAX_Y, type Point } from "./movement.js";
import { resolveMove, type TileLayer } from "./tilemap.js";

export interface Enemy {
  id: string;
  name: string;
  glyph: string;
  color: string;
  room: RoomCoord;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  wanderTarget: Point | null;
  chasing: boolean;
  /** True once the player has dealt damage — permanently chases. */
  aggro: boolean;
}

/** Click/hit radius around an enemy's glyph — one neighboring cell (~1.5 cells). */
export const ENEMY_RADIUS = 45;

/** Collision half-size for enemies sliding against walls. */
export const ENEMY_HALF = 10;

export const ENEMY_SPEED_WANDER = 60;
export const ENEMY_SPEED_CHASE = 140;

/** Distance at which enemies switch from wandering to chasing the player. */
export const CHASE_RANGE = 200;

/**
 * The enemy under a point in the given room — the nearest within `radius`, or
 * null. Used with a tight radius for click targeting and a loose one for
 * name-on-hover.
 */
export function enemyAtPoint(
  enemies: readonly Enemy[],
  room: RoomCoord,
  point: Point,
  radius: number = ENEMY_RADIUS,
): Enemy | null {
  let nearest: Enemy | null = null;
  let nearestDistance = radius;

  for (const enemy of enemies) {
    if (!sameRoom(enemy.room, room)) continue;
    const distance = Math.hypot(point.x - enemy.x, point.y - enemy.y);
    if (distance <= nearestDistance) {
      nearest = enemy;
      nearestDistance = distance;
    }
  }

  return nearest;
}

/** Pick a random point inside the room boundaries (with margin for the glyph). */
export function randomRoomPoint(): Point {
  return {
    x: MIN_X + Math.random() * (MAX_X - MIN_X),
    y: MIN_Y + Math.random() * (MAX_Y - MIN_Y),
  };
}

/** Create a hellhound at a random edge of the given room with 30 HP. */
export function spawnEnemy(id: string, room: RoomCoord): Enemy {
  // Pick a random edge: 0=north, 1=east, 2=south, 3=west
  const edge = Math.floor(Math.random() * 4);
  let x: number;
  let y: number;

  switch (edge) {
    case 0: // north
      x = MIN_X + Math.random() * (MAX_X - MIN_X);
      y = MIN_Y + 2;
      break;
    case 1: // east
      x = MAX_X - 2;
      y = MIN_Y + Math.random() * (MAX_Y - MIN_Y);
      break;
    case 2: // south
      x = MIN_X + Math.random() * (MAX_X - MIN_X);
      y = MAX_Y - 2;
      break;
    default: // west
      x = MIN_X + 2;
      y = MIN_Y + Math.random() * (MAX_Y - MIN_Y);
      break;
  }

  return {
    id,
    name: "Hellhound",
    glyph: "\u265E",
    color: "#ff8c1a",
    room: { ...room },
    x,
    y,
    health: 30,
    maxHealth: 30,
    wanderTarget: null,
    chasing: false,
    aggro: false,
  };
}

/**
 * Update one enemy's AI: wander toward a random point, switch to chasing the
 * player when within CHASE_RANGE, move toward player. Uses resolveMove for
 * wall collision.
 */
export function updateEnemy(
  enemy: Enemy,
  playerX: number,
  playerY: number,
  dt: number,
  layer: TileLayer | undefined,
): void {
  const dx = playerX - enemy.x;
  const dy = playerY - enemy.y;
  const distToPlayer = Math.hypot(dx, dy);

  enemy.chasing = enemy.aggro || distToPlayer <= CHASE_RANGE;

  let goalX: number;
  let goalY: number;
  let speed: number;

  /** Stop half a cell away from the player so enemies don't all pile up. */
  const CHASE_STOP_DIST = CELL_SIZE / 2;

  if (enemy.chasing) {
    if (distToPlayer <= CHASE_STOP_DIST) return; // close enough — hold position
    goalX = playerX;
    goalY = playerY;
    speed = ENEMY_SPEED_CHASE;
  } else {
    // Pick a new wander target when we don't have one or we've reached it.
    if (
      !enemy.wanderTarget ||
      Math.hypot(enemy.wanderTarget.x - enemy.x, enemy.wanderTarget.y - enemy.y) < 10
    ) {
      enemy.wanderTarget = randomRoomPoint();
    }
    goalX = enemy.wanderTarget.x;
    goalY = enemy.wanderTarget.y;
    speed = ENEMY_SPEED_WANDER;
  }

  const toX = goalX - enemy.x;
  const toY = goalY - enemy.y;
  const dist = Math.hypot(toX, toY) || 1;
  const step = speed * dt;

  const x1 = enemy.x + (toX / dist) * step;
  const y1 = enemy.y + (toY / dist) * step;

  const moved = resolveMove(layer, enemy.x, enemy.y, x1, y1, ENEMY_HALF);
  enemy.x = moved.x;
  enemy.y = moved.y;
}
