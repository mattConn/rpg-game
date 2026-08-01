/**
 * Enemies are glyph tokens with identity — unlike the decorative tile layer,
 * they can be targeted and named. They wander randomly and chase the player
 * when close.
 */

import { WORLD_WIDTH, WORLD_HEIGHT, PLAYER_RADIUS, sameRoom, type RoomCoord } from "../shared/constants.js";
import { MIN_X, MAX_X, MIN_Y, MAX_Y, type Point } from "../shared/movement.js";
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

/** Click/hit radius around an enemy's glyph, in room units. */
export const ENEMY_RADIUS = 16;

/** Ring drawn around the current target: yellow when selected, red mid-attack. */
const TARGET_RING_RADIUS = 20;
const TARGET_COLOR = "#ffd633";
const ATTACK_COLOR = "#e23b3b";

const ENEMY_FONT = "28px monospace";
const NAME_FONT = "12px monospace";

/** Collision half-size for enemies sliding against walls. */
const ENEMY_HALF = 10;

const ENEMY_SPEED_WANDER = 60;
const ENEMY_SPEED_CHASE = 140;

/** Distance at which enemies switch from wandering to chasing the player. */
export const CHASE_RANGE = 200;

/** Health bar drawn above the enemy glyph. */
const HEALTH_BAR_WIDTH = 30;
const HEALTH_BAR_HEIGHT = 4;
const HEALTH_BAR_OFFSET_Y = -22;

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
function randomRoomPoint(): Point {
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

  if (enemy.chasing) {
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

/** Small red health bar above the enemy glyph. */
export function drawHealthBar(ctx: CanvasRenderingContext2D, enemy: Enemy): void {
  if (enemy.health >= enemy.maxHealth) return; // full health — don't clutter

  const barX = enemy.x - HEALTH_BAR_WIDTH / 2;
  const barY = enemy.y + HEALTH_BAR_OFFSET_Y;
  const fill = Math.max(0, Math.min(1, enemy.health / enemy.maxHealth));

  // Dark track
  ctx.fillStyle = "#1b1b1b";
  ctx.fillRect(barX, barY, HEALTH_BAR_WIDTH, HEALTH_BAR_HEIGHT);

  // Red fill
  ctx.fillStyle = "#c0392b";
  ctx.fillRect(barX, barY, HEALTH_BAR_WIDTH * fill, HEALTH_BAR_HEIGHT);

  // Border
  ctx.strokeStyle = "#3a3a3a";
  ctx.lineWidth = 0.5;
  ctx.strokeRect(barX, barY, HEALTH_BAR_WIDTH, HEALTH_BAR_HEIGHT);
}

export function drawEnemy(
  ctx: CanvasRenderingContext2D,
  enemy: Enemy,
  opts: { targeted: boolean; attacking: boolean; showName: boolean },
): void {
  ctx.setLineDash([]);

  // Ring goes under the glyph so it frames rather than covers it. Attacking
  // (red) takes precedence over merely targeted (yellow).
  const ring = opts.attacking ? ATTACK_COLOR : opts.targeted ? TARGET_COLOR : null;
  if (ring) {
    ctx.strokeStyle = ring;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(enemy.x, enemy.y, TARGET_RING_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.font = ENEMY_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = enemy.color;
  ctx.fillText(enemy.glyph, enemy.x, enemy.y);

  drawHealthBar(ctx, enemy);

  if (opts.showName) {
    ctx.font = NAME_FONT;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(enemy.name, enemy.x, enemy.y + ENEMY_RADIUS + 10);
  }
}
