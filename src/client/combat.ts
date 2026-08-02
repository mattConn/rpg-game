/**
 * Thin client wrapper around the shared combat module. Re-exports all pure
 * logic and keeps only the drawDagger rendering function.
 */

// Re-export everything the rest of the client imports from here.
export {
  FIRE_INTERVAL_MS,
  PROJECTILE_SPEED,
  HIT_RADIUS,
  daggerAngle,
  spawnDagger,
  advanceDagger,
  daggerDone,
  type Projectile,
} from "../shared/combat.js";

// ------------------------------------------------------------------- rendering

const DAGGER_COLOR = "#d6dbdf";

/** Draw the dagger glyph at a point, rotated and sized as asked. */
export function drawDagger(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rotation: number,
  sizePx: number,
  color: string = DAGGER_COLOR,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.font = `${sizePx}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText("\u2020", 0, 0);
  ctx.restore();
}
