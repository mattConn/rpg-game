/**
 * Thin client wrapper around the shared enemies module. Re-exports all pure
 * logic and keeps only rendering functions and constants.
 */

import type { Enemy } from "../shared/enemies.js";

// Re-export everything the rest of the client imports from here.
export {
  ENEMY_RADIUS,
  ENEMY_HALF,
  ENEMY_SPEED_WANDER,
  ENEMY_SPEED_CHASE,
  CHASE_RANGE,
  enemyAtPoint,
  randomRoomPoint,
  spawnEnemy,
  updateEnemy,
  type Enemy,
} from "../shared/enemies.js";

// ------------------------------------------------------------------- rendering

/** Ring drawn around the current target: yellow when selected, red mid-attack. */
const TARGET_RING_RADIUS = 20;
const TARGET_COLOR = "#ffd633";
const ATTACK_COLOR = "#e23b3b";

const ENEMY_FONT = "28px monospace";
const NAME_FONT = "12px monospace";

/** Click/hit radius — re-imported from shared for the name label offset. */
const ENEMY_RADIUS_LOCAL = 45;

/** Health bar drawn above the enemy glyph. */
const HEALTH_BAR_WIDTH = 30;
const HEALTH_BAR_HEIGHT = 4;
const HEALTH_BAR_OFFSET_Y = -22;

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
    ctx.fillText(enemy.name, enemy.x, enemy.y + ENEMY_RADIUS_LOCAL + 10);
  }
}
