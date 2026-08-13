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
  /** Horizontal patrol beat, in px. Fixed at spawn and always inside the room. */
  patrolMinX: number;
  patrolMaxX: number;
  /** Which way along the beat it's currently marching: +1 right, -1 left. */
  patrolDir: 1 | -1;
  /**
   * Which way the glyph should face: +1 right, -1 left. Tracks actual movement
   * and is *held* when standing still, so a stopped enemy keeps facing the way
   * it was going instead of snapping to a default.
   */
  facing: 1 | -1;
  chasing: boolean;
  /** True once the player has dealt damage — permanently chases. */
  aggro: boolean;
  /** Timestamp of last attack on the player (ms). */
  lastAttackAt: number;
}

/**
 * What a hellhound looks like. Exported because it is the only enemy in the
 * game and both front ends' worth of code identifies it by these three values —
 * the 3D wolf takes its ember accent from `color`, and the turn-based skirmish
 * fields the same animal.
 */
export const HELLHOUND = {
  name: "Hellhound",
  glyph: "♞",
  color: "#ff8c1a",
} as const;

/** Click/hit radius around an enemy's glyph — one neighboring cell (~1.5 cells). */
export const ENEMY_RADIUS = 45;

/** Distance at which enemies can hit the player (matches melee combat range). */
export const ENEMY_ATTACK_RANGE = 45;

/** Minimum interval between enemy attacks (ms). */
export const ENEMY_ATTACK_INTERVAL = 1000;

/** Damage dealt per enemy attack. */
export const ENEMY_DAMAGE = 3;

/** Collision half-size for enemies sliding against walls. */
export const ENEMY_HALF = 10;

export const ENEMY_SPEED_WANDER = 60;
export const ENEMY_SPEED_CHASE = 140;

/**
 * How wide a patrol beat is (px). Clamped to the room at spawn, so it can never
 * run off screen — the room is 1200 wide, so this always fits.
 */
export const PATROL_SPAN = 12 * CELL_SIZE;

/** Distance at which enemies switch from wandering to chasing the player. */
export const CHASE_RANGE = 200;

/**
 * The enemy under a point in the given room — the nearest within `radius`, or
 * null. Used with a tight radius for click targeting and a loose one for
 * name-on-hover.
 *
 * Generic over anything placed in a room, so corpses hit-test through the same
 * function as the living.
 */
export function enemyAtPoint<T extends { room: RoomCoord; x: number; y: number }>(
  enemies: readonly T[],
  room: RoomCoord,
  point: Point,
  radius: number = ENEMY_RADIUS,
): T | null {
  let nearest: T | null = null;
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

/**
 * The patrol beat for an enemy spawned at `x`: `PATROL_SPAN` wide and centred on
 * it where possible. Near a wall the beat *slides* inward rather than shrinking,
 * so a patrol keeps its full width wherever it spawns, and it is clamped to the
 * room either way so it can never leave the screen.
 */
export function patrolBeat(x: number): { patrolMinX: number; patrolMaxX: number } {
  const half = PATROL_SPAN / 2;
  let minX = x - half;
  let maxX = x + half;

  if (minX < MIN_X) {
    maxX += MIN_X - minX;
    minX = MIN_X;
  }
  if (maxX > MAX_X) {
    minX -= maxX - MAX_X;
    maxX = MAX_X;
  }

  return { patrolMinX: Math.max(MIN_X, minX), patrolMaxX: Math.min(MAX_X, maxX) };
}

/**
 * How far in from the room border an enemy enters. Flush against the edge left
 * a patrolling hellhound glued to the screen border, since patrol is purely
 * horizontal and never carries it inward the way wandering used to.
 */
export const SPAWN_INSET = 2 * CELL_SIZE;

/** A random coordinate along an edge, kept clear of both perpendicular ends. */
function alongEdge(min: number, max: number): number {
  const lo = min + SPAWN_INSET;
  const hi = max - SPAWN_INSET;
  return hi > lo ? lo + Math.random() * (hi - lo) : (min + max) / 2;
}

/** Create a hellhound just inside a random edge of the given room, with 30 HP. */
export function spawnEnemy(id: string, room: RoomCoord): Enemy {
  // Pick a random edge: 0=north, 1=east, 2=south, 3=west
  const edge = Math.floor(Math.random() * 4);
  const dir: 1 | -1 = Math.random() < 0.5 ? -1 : 1;
  let x: number;
  let y: number;

  switch (edge) {
    case 0: // north
      x = alongEdge(MIN_X, MAX_X);
      y = MIN_Y + SPAWN_INSET;
      break;
    case 1: // east
      x = MAX_X - SPAWN_INSET;
      y = alongEdge(MIN_Y, MAX_Y);
      break;
    case 2: // south
      x = alongEdge(MIN_X, MAX_X);
      y = MAX_Y - SPAWN_INSET;
      break;
    default: // west
      x = MIN_X + SPAWN_INSET;
      y = alongEdge(MIN_Y, MAX_Y);
      break;
  }

  return {
    id,
    ...HELLHOUND,
    room: { ...room },
    x,
    y,
    health: 30,
    maxHealth: 30,
    ...patrolBeat(x),
    patrolDir: dir,
    facing: dir,
    chasing: false,
    aggro: false,
    lastAttackAt: 0,
  };
}

/**
 * Point the glyph the way it just moved. Sub-pixel drift is ignored and a
 * stationary enemy keeps its previous facing, so the sprite doesn't flicker
 * when it stops or when it's only moving vertically.
 */
function updateFacing(enemy: Enemy, startX: number): void {
  const dx = enemy.x - startX;
  if (dx > 0.01) enemy.facing = 1;
  else if (dx < -0.01) enemy.facing = -1;
}

/**
 * March left and right along the patrol beat, reversing at either end. Purely
 * horizontal — the enemy holds whatever line it's on, which after a chase is
 * wherever the chase left it.
 */
function patrol(enemy: Enemy, dt: number, layer: TileLayer | undefined): void {
  const step = ENEMY_SPEED_WANDER * dt;

  // A chase can end anywhere, including off the beat. Head back to it first.
  const offBeat = enemy.x < enemy.patrolMinX || enemy.x > enemy.patrolMaxX;
  if (enemy.x < enemy.patrolMinX) enemy.patrolDir = 1;
  else if (enemy.x > enemy.patrolMaxX) enemy.patrolDir = -1;

  let nextX = enemy.x + enemy.patrolDir * step;

  // Turn around at the ends — but only while actually on the beat, or the
  // clamp would drag a returning enemy backwards instead of letting it walk in.
  if (!offBeat) {
    if (nextX <= enemy.patrolMinX) {
      nextX = enemy.patrolMinX;
      enemy.patrolDir = 1;
    } else if (nextX >= enemy.patrolMaxX) {
      nextX = enemy.patrolMaxX;
      enemy.patrolDir = -1;
    }
  }

  const moved = resolveMove(layer, enemy.x, enemy.y, nextX, enemy.y, ENEMY_HALF);

  // A wall counts as an edge too: if we barely moved, we're up against
  // something, so reverse rather than grinding into it.
  if (Math.abs(moved.x - enemy.x) < step * 0.5) {
    enemy.patrolDir = enemy.patrolDir === 1 ? -1 : 1;
  }

  enemy.x = moved.x;
  enemy.y = moved.y;
}

/**
 * Update one enemy's AI: march its horizontal patrol beat, switching to chasing
 * the player when within CHASE_RANGE. Uses resolveMove for wall collision.
 */
export function updateEnemy(
  enemy: Enemy,
  playerX: number,
  playerY: number,
  dt: number,
  layer: TileLayer | undefined,
): void {
  const startX = enemy.x;
  const dx = playerX - enemy.x;
  const dy = playerY - enemy.y;
  const distToPlayer = Math.hypot(dx, dy);

  enemy.chasing = enemy.aggro || distToPlayer <= CHASE_RANGE;

  let goalX: number;
  let goalY: number;
  let speed: number;

  /** Stop half a cell away from the player so enemies don't all pile up. */
  const CHASE_STOP_DIST = CELL_SIZE / 2;

  if (!enemy.chasing) {
    patrol(enemy, dt, layer);
    updateFacing(enemy, startX);
    return;
  }

  if (distToPlayer <= CHASE_STOP_DIST) return; // close enough — hold position
  goalX = playerX;
  goalY = playerY;
  speed = ENEMY_SPEED_CHASE;

  const toX = goalX - enemy.x;
  const toY = goalY - enemy.y;
  const dist = Math.hypot(toX, toY) || 1;
  const step = speed * dt;

  const x1 = enemy.x + (toX / dist) * step;
  const y1 = enemy.y + (toY / dist) * step;

  const moved = resolveMove(layer, enemy.x, enemy.y, x1, y1, ENEMY_HALF);
  enemy.x = moved.x;
  enemy.y = moved.y;

  updateFacing(enemy, startX);
}
