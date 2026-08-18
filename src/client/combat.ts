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

/**
 * Draw the shared sword/dagger icon. Its unrotated tip still points south, just
 * like the old `†` glyph, so `daggerAngle` and every existing orientation stay
 * untouched. Size alone distinguishes the long sword from the compact dagger.
 */
export function drawDagger(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rotation: number,
  sizePx: number,
  color: string = DAGGER_COLOR,
  handleColor: string = "#35241d",
  ornateHilt = false,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);

  const s = sizePx;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // A small offset shadow separates pale steel from bright slot borders.
  ctx.beginPath();
  ctx.moveTo(-s * 0.105 + 1.2, -s * 0.12 + 1.2);
  ctx.lineTo(-s * 0.09 + 1.2, s * 0.22 + 1.2);
  ctx.lineTo(1.2, s * 0.48 + 1.2);
  ctx.lineTo(s * 0.09 + 1.2, s * 0.22 + 1.2);
  ctx.lineTo(s * 0.105 + 1.2, -s * 0.12 + 1.2);
  ctx.closePath();
  ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
  ctx.fill();

  const steel = ctx.createLinearGradient(-s * 0.12, 0, s * 0.12, 0);
  steel.addColorStop(0, "#737d8d");
  steel.addColorStop(0.42, color);
  steel.addColorStop(0.58, "#f5f1df");
  steel.addColorStop(1, "#687180");
  ctx.beginPath();
  ctx.moveTo(-s * 0.105, -s * 0.12);
  ctx.lineTo(-s * 0.09, s * 0.22);
  ctx.lineTo(0, s * 0.48);
  ctx.lineTo(s * 0.09, s * 0.22);
  ctx.lineTo(s * 0.105, -s * 0.12);
  ctx.closePath();
  ctx.fillStyle = steel;
  ctx.fill();
  ctx.strokeStyle = "#e6d7ad";
  ctx.lineWidth = Math.max(0.8, s * 0.025);
  ctx.stroke();

  // Fuller and centre ridge make the blade readable even in the 44px bar.
  ctx.beginPath();
  ctx.moveTo(0, -s * 0.08);
  ctx.lineTo(0, s * 0.34);
  ctx.strokeStyle = "rgba(45, 52, 64, 0.8)";
  ctx.lineWidth = Math.max(1, s * 0.04);
  ctx.stroke();

  // The sword gets a finished upswept guard; a utility dagger keeps a short,
  // plain iron bar rather than borrowing the sword's expensive furniture.
  ctx.beginPath();
  if (ornateHilt) {
    ctx.moveTo(-s * 0.28, -s * 0.15);
    ctx.quadraticCurveTo(-s * 0.18, -s * 0.1, 0, -s * 0.14);
    ctx.quadraticCurveTo(s * 0.18, -s * 0.1, s * 0.28, -s * 0.15);
  } else {
    ctx.moveTo(-s * 0.18, -s * 0.14);
    ctx.lineTo(s * 0.18, -s * 0.14);
  }
  ctx.strokeStyle = ornateHilt ? "#a17a3e" : "#3f4247";
  ctx.lineWidth = Math.max(2.2, s * (ornateHilt ? 0.075 : 0.06));
  ctx.stroke();
  if (ornateHilt) {
    ctx.strokeStyle = "#d0a85f";
    ctx.lineWidth = Math.max(0.8, s * 0.022);
    ctx.stroke();
  }

  // Dark leather grip with diagonal wrap marks.
  ctx.fillStyle = handleColor;
  ctx.fillRect(-s * 0.045, -s * 0.38, s * 0.09, s * 0.22);
  ctx.strokeStyle = ornateHilt ? "#9a6135" : "#49342b";
  ctx.lineWidth = Math.max(0.7, s * 0.018);
  for (let gy = -0.36; gy < -0.18; gy += 0.055) {
    ctx.beginPath();
    ctx.moveTo(-s * 0.042, s * gy);
    ctx.lineTo(s * 0.042, s * (gy + 0.035));
    ctx.stroke();
  }

  if (ornateHilt) {
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.48);
    ctx.lineTo(s * 0.075, -s * 0.415);
    ctx.lineTo(0, -s * 0.35);
    ctx.lineTo(-s * 0.075, -s * 0.415);
    ctx.closePath();
    ctx.fillStyle = "#8b6938";
    ctx.fill();
    ctx.strokeStyle = "#d0a85f";
    ctx.stroke();
  } else {
    ctx.fillStyle = "#35373b";
    ctx.fillRect(-s * 0.055, -s * 0.43, s * 0.11, s * 0.055);
  }
  ctx.restore();
}
