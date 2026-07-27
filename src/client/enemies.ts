/**
 * Enemies are glyph tokens with identity — unlike the decorative tile layer,
 * they can be targeted and named. Render-only for now: no stats, no movement.
 */

import { sameRoom, type RoomCoord } from "../shared/constants.js";
import type { Point } from "../shared/movement.js";

export interface Enemy {
  id: string;
  name: string;
  glyph: string;
  color: string;
  room: RoomCoord;
  x: number;
  y: number;
}

/** Click/hit radius around an enemy's glyph, in room units. */
export const ENEMY_RADIUS = 16;

/** Ring drawn around the current target: yellow when selected, red mid-attack. */
const TARGET_RING_RADIUS = 20;
const TARGET_COLOR = "#ffd633";
const ATTACK_COLOR = "#e23b3b";

const ENEMY_FONT = "28px monospace";
const NAME_FONT = "12px monospace";

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

  if (opts.showName) {
    ctx.font = NAME_FONT;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(enemy.name, enemy.x, enemy.y + ENEMY_RADIUS + 10);
  }
}
