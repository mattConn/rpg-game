/**
 * Thin client wrapper around the shared enemies module. Re-exports all pure
 * logic and keeps only rendering functions and constants.
 */

import type { Enemy } from "../shared/enemies.js";
import { corpseLabel } from "../shared/loot.js";

// Re-export everything the rest of the client imports from here.
export {
  ENEMY_RADIUS,
  ENEMY_HALF,
  ENEMY_SPEED_WANDER,
  ENEMY_SPEED_CHASE,
  CHASE_RANGE,
  enemyAtPoint,
  patrolBeat,
  PATROL_SPAN,
  spawnEnemy,
  updateEnemy,
  type Enemy,
} from "../shared/enemies.js";

// ------------------------------------------------------------------- rendering

/**
 * Draw a glyph facing a direction. The glyphs we use (`♞`, `@`) are drawn
 * facing left, so facing right means mirroring horizontally. Requires
 * `textAlign = "center"`, which puts the mirror axis through the glyph itself.
 */
export function drawFacingGlyph(
  ctx: CanvasRenderingContext2D,
  glyph: string,
  x: number,
  y: number,
  facing: 1 | -1,
): void {
  if (facing !== 1) {
    ctx.fillText(glyph, x, y);
    return;
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(-1, 1);
  ctx.fillText(glyph, 0, 0);
  ctx.restore();
}

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

/**
 * How much of its colour a body keeps. Fading it against the black room reads
 * as "darkened" without needing a second palette per enemy type.
 */
const CORPSE_ALPHA = 0.35;

/** Label colour for a corpse — dimmer than a living enemy's white name. */
const CORPSE_LABEL_COLOR = "#999999";

/**
 * A dead enemy: the same glyph, still facing the way it fell, dimmed. No health
 * bar — there's no health left to report.
 */
export function drawCorpse(
  ctx: CanvasRenderingContext2D,
  corpse: { name: string; glyph: string; color: string; x: number; y: number; facing: 1 | -1 },
  opts: { targeted: boolean; showName: boolean },
): void {
  ctx.setLineDash([]);

  // Corpses can be targeted but never attacked, so there's no red ring here.
  if (opts.targeted) {
    ctx.strokeStyle = TARGET_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(corpse.x, corpse.y, TARGET_RING_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.font = ENEMY_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.save();
  ctx.globalAlpha = CORPSE_ALPHA;
  ctx.fillStyle = corpse.color;
  drawFacingGlyph(ctx, corpse.glyph, corpse.x, corpse.y, corpse.facing);
  ctx.restore();

  if (opts.showName) {
    ctx.font = NAME_FONT;
    ctx.fillStyle = CORPSE_LABEL_COLOR;
    ctx.fillText(corpseLabel(corpse), corpse.x, corpse.y + 20);
  }
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
  drawFacingGlyph(ctx, enemy.glyph, enemy.x, enemy.y, enemy.facing);

  drawHealthBar(ctx, enemy);

  if (opts.showName) {
    ctx.font = NAME_FONT;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(enemy.name, enemy.x, enemy.y + 20);
  }
}
