/**
 * **The weapon in your hands**, drawn into the bottom-right corner of the
 * overlay — the one piece of the player's own body that survives first person,
 * where `actors.player.root` is hidden and there is otherwise nothing on screen
 * to say what you are holding.
 *
 * There is one blade shape (`drawBlade`) and it is the sword, the dagger, the
 * swing and the throw. A held weapon that turned into a *different* weapon to
 * attack with is the thing this file exists to stop.
 *
 * **Rest and attack are two poses, not one motion.** They face opposite ways on
 * purpose: at rest the blade is mirrored about the hand so it points in across
 * the screen, and an attack is the original sweep, which starts out past the
 * right edge and cuts inward. Nothing has to reconcile them, because the resting
 * weapon is *hidden* for as long as an attack is playing and comes back when it
 * finishes — so the two are never on screen together and neither jumps into the
 * other.
 *
 * Everything is in room units (1200x900), like the rest of the overlay, so it
 * scales with the letterbox rather than with the window.
 */

import { WORLD_HEIGHT, WORLD_WIDTH } from "../../../src/shared/constants.js";
import type { AttackKind } from "../../../src/shared/actions.js";

/**
 * The hand, off the bottom-right corner. Every pose pivots here, which is what
 * makes an attack read as the same object moving rather than as a second sprite
 * appearing somewhere else.
 */
const PIVOT_X = WORLD_WIDTH * 0.85;
const PIVOT_Y = WORLD_HEIGHT * 1.1;

/** Blade geometry per weapon, in room units. */
const SWORD_LENGTH = WORLD_HEIGHT * 0.7;
const SWORD_WIDTH = 12;
/** The dagger is the same blade, shorter and slimmer — a knife, not a toy sword. */
const DAGGER_LENGTH = WORLD_HEIGHT * 0.34;
const DAGGER_WIDTH = 8;

/** Where the weapon is carried when nothing is happening. */
const REST_ANGLE_DEG = -30;

/**
 * The sword's sweep: it enters from past the right edge, crosses the view and
 * carries on **down and out through the bottom of the screen** — a full stroke
 * rather than one that stops halfway across. Drawn *unmirrored*, which is what
 * makes it read as a swing at all.
 *
 * The arc runs to +90, where the blade lies flat at the hand's own height. The
 * hand sits below the bottom of the room (`PIVOT_Y` is 1.1 of it), so the last
 * stretch of the sweep carries the whole blade out of frame on its own — the
 * tip crosses the bottom edge around +82 and everything after that is off
 * screen. That is why there is no fade any more: the stroke *leaves*, and a
 * blade dissolving in mid-air while still on screen was standing in for an exit
 * it never actually made.
 */
const SWING_START_DEG = -30;
const SWING_ARC_DEG = 120;

/**
 * Lengthened with the arc, so the blade travels at the speed it always did
 * rather than a third faster to cover a third more ground in the same time.
 * Still well inside `MELEE_COOLDOWN_MS`, so the sword is back in hand before
 * you can swing again.
 */
export const SWING_DURATION = 330;

/** How solid the weapon sits at rest. Not fully opaque — it is not the world. */
const REST_ALPHA = 0.85;

/**
 * The blade itself: a pointed polygon, wide at the hilt and tapering to a tip,
 * with a bright edge down the centre. Drawn along -Y from the origin, so the
 * caller owns the rotation.
 */
function drawBlade(ctx: CanvasRenderingContext2D, length: number, width: number, alpha: number): void {
  const dagger = length < WORLD_HEIGHT * 0.5;
  const gripLength = dagger ? 42 : 62;
  const guardWidth = width * (dagger ? 3.2 : 4.8);

  const bladeGradient = ctx.createLinearGradient(-width / 2, 0, width / 2, 0);
  bladeGradient.addColorStop(0, `rgba(102, 110, 123, ${alpha})`);
  bladeGradient.addColorStop(0.42, `rgba(226, 232, 239, ${alpha})`);
  bladeGradient.addColorStop(0.58, `rgba(171, 181, 194, ${alpha})`);
  bladeGradient.addColorStop(1, `rgba(76, 83, 96, ${alpha})`);

  ctx.beginPath();
  ctx.moveTo(-width * 0.5, 0);             // hilt left
  ctx.lineTo(-width * 0.48, -length * 0.72);
  ctx.lineTo(-width * 0.34, -length * 0.92);
  ctx.lineTo(0, -length);                  // tip
  ctx.lineTo(width * 0.34, -length * 0.92);
  ctx.lineTo(width * 0.48, -length * 0.72);
  ctx.lineTo(width * 0.5, 0);              // hilt right
  ctx.closePath();
  ctx.fillStyle = bladeGradient;
  ctx.fill();
  ctx.strokeStyle = `rgba(238, 224, 188, ${alpha * 0.8})`;
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // A dark central fuller gives the broad blade depth without modern gloss.
  ctx.beginPath();
  ctx.moveTo(0, -length * 0.06);
  ctx.lineTo(0, -length * 0.84);
  ctx.strokeStyle = `rgba(52, 58, 70, ${alpha * 0.7})`;
  ctx.lineWidth = Math.max(2, width * 0.16);
  ctx.stroke();

  // Guard, wrapped grip and pommel travel with the blade in every pose.
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-guardWidth / 2, 3);
  ctx.lineTo(guardWidth / 2, 3);
  ctx.strokeStyle = `rgba(111, 88, 50, ${alpha})`;
  ctx.lineWidth = dagger ? 7 : 9;
  ctx.stroke();

  ctx.fillStyle = `rgba(55, 35, 25, ${alpha})`;
  ctx.fillRect(-width * 0.34, 8, width * 0.68, gripLength);
  ctx.strokeStyle = `rgba(151, 103, 54, ${alpha * 0.85})`;
  ctx.lineWidth = 2;
  for (let y = 12; y < gripLength + 7; y += 8) {
    ctx.beginPath();
    ctx.moveTo(-width * 0.32, y);
    ctx.lineTo(width * 0.32, y + 5);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(0, gripLength + 13, dagger ? 7 : 9, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(99, 77, 45, ${alpha})`;
  ctx.fill();
}

/**
 * Put the blade in the hand at `angleDeg`, optionally mirrored and optionally
 * pushed along its own axis. Mirroring is what separates the resting pose from
 * an attack: the same angle read one way points across the screen and the other
 * way points off the right edge.
 */
function poseBlade(
  ctx: CanvasRenderingContext2D,
  opts: { angleDeg: number; length: number; width: number; alpha: number; mirrored: boolean },
): void {
  ctx.save();
  ctx.translate(PIVOT_X, PIVOT_Y);
  if (opts.mirrored) ctx.scale(-1, 1);
  ctx.rotate(-opts.angleDeg * (Math.PI / 180));
  drawBlade(ctx, opts.length, opts.width, Math.max(0, opts.alpha));
  ctx.restore();
}

export interface HeldWeapon {
  /** The weapon currently selected — what is carried when nothing is playing. */
  kind: AttackKind;
  /** ms since the sword last swung, or null if it never has this session. */
  sinceSwing: number | null;
  /**
   * True while the thrown dagger is spent — read straight off the ranged
   * cooldown, so the hand refills exactly when you could throw again.
   */
  spent: boolean;
}

/**
 * Draw whatever belongs in the corner this frame: an attack if one is playing,
 * otherwise the selected weapon at rest. An attack takes precedence over the
 * carried weapon rather than drawing on top of it, which is what "hide it while
 * the animation plays" means in practice — including when the player swaps
 * weapons mid-animation, since the swing is owned by the attack that fired it.
 */
export function drawHeldWeapon(ctx: CanvasRenderingContext2D, held: HeldWeapon): void {
  if (held.sinceSwing !== null && held.sinceSwing < SWING_DURATION) {
    const t = held.sinceSwing / SWING_DURATION;
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    // Two faint preceding poses sell speed without turning the sword into a
    // modern glowing trail.
    for (const lag of [0.08, 0.04]) {
      const ghost = Math.max(0, eased - lag);
      poseBlade(ctx, {
        angleDeg: SWING_START_DEG + SWING_ARC_DEG * ghost,
        length: SWORD_LENGTH,
        width: SWORD_WIDTH,
        alpha: 0.1,
        mirrored: false,
      });
    }
    poseBlade(ctx, {
      angleDeg: SWING_START_DEG + SWING_ARC_DEG * eased,
      length: SWORD_LENGTH,
      width: SWORD_WIDTH,
      // No fade: the swing exits through the bottom of the screen under its own
      // geometry, so it stays solid for every frame it is visible for.
      alpha: REST_ALPHA,
      mirrored: false,
    });
    return;
  }

  // **A thrown dagger has no animation: it is simply gone, cut, not faded.**
  // The thing that left your hand is already drawn — the server flies it across
  // the room as a projectile — so a second dagger animating in the corner was
  // the same throw told twice. It stays gone for as long as the cooldown says
  // it is spent, which is also exactly how long until you can throw the next
  // one. Only while the dagger is what's selected: swapping to the sword puts
  // the sword in your hand at once, because that is what drawing it means.
  const melee = held.kind === "melee";
  if (!melee && held.spent) return;

  // Nothing playing: carry the selected weapon, mirrored so it points in across
  // the screen instead of out past the corner the hand already occupies.
  poseBlade(ctx, {
    angleDeg: REST_ANGLE_DEG,
    length: melee ? SWORD_LENGTH : DAGGER_LENGTH,
    width: melee ? SWORD_WIDTH : DAGGER_WIDTH,
    alpha: REST_ALPHA,
    mirrored: true,
  });
}
