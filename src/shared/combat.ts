/** Pure projectile/dagger logic shared between server and client. */

import { WORLD_HEIGHT, WORLD_WIDTH } from "./constants.js";
import type { Point } from "./movement.js";

export interface Projectile {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Ranged fire rate (one dagger per second) and projectile speed. */
export const FIRE_INTERVAL_MS = 1000;
export const PROJECTILE_SPEED = 480;

/** A dagger is done once it reaches the target or leaves the room. */
export const HIT_RADIUS = 14;
const OFF_SCREEN_MARGIN = 40;

/**
 * The rotation (radians) that turns the dagger glyph `†` — whose point sits at
 * the bottom (south) — so its blade points along a direction vector, tip
 * leading. Pass (0,-1) for an upright sword, (-1,-1) for the NW throwing pose.
 */
export function daggerAngle(vx: number, vy: number): number {
  return Math.atan2(-vx, vy);
}

export function spawnDagger(from: Point, to: Point, speed: number = PROJECTILE_SPEED): Projectile {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  return { x: from.x, y: from.y, vx: (dx / distance) * speed, vy: (dy / distance) * speed };
}

export function advanceDagger(p: Projectile, dt: number): void {
  p.x += p.vx * dt;
  p.y += p.vy * dt;
}

export function daggerDone(p: Projectile, target: Point): boolean {
  const toTargetX = target.x - p.x;
  const toTargetY = target.y - p.y;

  // Reached the target, or flew past it — the target now lies behind the
  // velocity, so a large single step can't tunnel through without retiring.
  if (Math.hypot(toTargetX, toTargetY) <= HIT_RADIUS) return true;
  if (toTargetX * p.vx + toTargetY * p.vy <= 0) return true;

  return (
    p.x < -OFF_SCREEN_MARGIN ||
    p.x > WORLD_WIDTH + OFF_SCREEN_MARGIN ||
    p.y < -OFF_SCREEN_MARGIN ||
    p.y > WORLD_HEIGHT + OFF_SCREEN_MARGIN
  );
}
