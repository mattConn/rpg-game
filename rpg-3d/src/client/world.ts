/**
 * The bridge between the simulation's room units and the 3D scene.
 *
 * The server still thinks in the 2D game's 1200x900 pixel room; nothing about
 * the rules changes here. One 30px tile becomes exactly **one 3D unit**, so the
 * arena is 40x30 units and a 1.9-unit human stands a bit taller than two tiles
 * — the same proportions the glyphs implied.
 */

import * as THREE from "three";
import { CELL_SIZE, WORLD_HEIGHT, WORLD_WIDTH } from "../../../src/shared/constants.js";

/** Room pixels -> 3D units. */
export const UNITS_PER_PX = 1 / CELL_SIZE;

export const ROOM_W = WORLD_WIDTH * UNITS_PER_PX; // 40
export const ROOM_D = WORLD_HEIGHT * UNITS_PER_PX; // 30

/** Room x -> scene x, room y -> scene z. Ground is the y = 0 plane. */
export const toX = (px: number): number => px * UNITS_PER_PX;
export const toZ = (py: number): number => py * UNITS_PER_PX;

/** Scene x/z -> room pixels, for turning a ground raycast back into input. */
export const toPixelX = (x: number): number => x / UNITS_PER_PX;
export const toPixelY = (z: number): number => z / UNITS_PER_PX;

/**
 * The yaw that points a model built facing +X (which is the 2D game's "facing
 * right") along a room-space direction. Rotating +X about Y by t gives
 * (cos t, 0, -sin t), so the heading we want is atan2(-dz, dx).
 */
export function yawFor(dx: number, dz: number): number {
  return Math.atan2(-dz, dx);
}

/** Fold an angle into [-PI, PI]. */
export function normalizeAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Shortest signed angle from `a` to `b`, so smoothing never spins the long way. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * `THREE.Color` only parses the comma form of `hsl()`, and the player's colour
 * arrives as the CSS space-separated form (`hsl(210 85% 65%)`). Normalise it
 * rather than colour every player the fallback white.
 */
export function parseColor(css: string): THREE.Color {
  const match = /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/i.exec(css.trim());
  const normalised = match ? `hsl(${match[1]}, ${match[2]}%, ${match[3]}%)` : css;
  return new THREE.Color(normalised);
}

/** Blend toward black — how corpses read as "darkened" without a second palette. */
export function darken(color: THREE.Color, amount: number): THREE.Color {
  return color.clone().lerp(new THREE.Color(0x000000), amount);
}

/** Frame-rate independent exponential smoothing. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}
