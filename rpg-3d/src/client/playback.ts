/**
 * Snapshot playback: turning a 20 Hz stream of state into something worth
 * drawing at 60.
 *
 * Kept out of `main.ts` so both 3D front ends run the *same* interpolation —
 * the real-time client and the turn-based one differ in their rules, not in how
 * they play a snapshot back.
 *
 * Generic over the snapshot type: a front end whose snapshot *extends*
 * `GameSnapshot` gets its extra fields carried through untouched by the spread,
 * so nothing here has to know about them.
 */

import type { GameSnapshot } from "../../../src/shared/protocol.js";

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Interpolate between two snapshots. Positional fields are lerped; everything
 * else comes from `curr`. `sinceSnapshot` is real ms since `curr` arrived, used
 * for the two things that must run on rather than blend: projectiles, which
 * travel far enough per tick to show, and the cooldown, which at 600ms visibly
 * stair-steps if it only moves when a packet lands.
 */
export function interpolateSnapshot<T extends GameSnapshot>(
  prev: T,
  curr: T,
  t: number,
  sinceSnapshot: number,
): T {
  const player = {
    ...curr.player,
    x: lerp(prev.player.x, curr.player.x, t),
    y: lerp(prev.player.y, curr.player.y, t),
  };

  const prevEnemies = new Map(prev.enemies.map((e) => [e.id, e]));
  const enemies = curr.enemies.map((enemy) => {
    const before = prevEnemies.get(enemy.id);
    if (!before) return enemy;
    return { ...enemy, x: lerp(before.x, enemy.x, t), y: lerp(before.y, enemy.y, t) };
  });

  const elapsed = Math.max(0, sinceSnapshot) / 1000;
  const projectiles = curr.projectiles.map((p) => ({
    ...p,
    x: p.x + p.vx * elapsed,
    y: p.y + p.vy * elapsed,
  }));

  // Paired by id, not by array position. Numbers expire out of the middle of
  // the list while newer ones are still alive, so an index pairs a survivor
  // with a different number the moment an older neighbour retires — which reads
  // on screen as the number jittering where it floats.
  const prevDamage = new Map(prev.damageNumbers.map((d) => [d.id, d]));
  const damageNumbers = curr.damageNumbers.map((dn) => {
    const before = prevDamage.get(dn.id);
    if (!before) return dn;
    return { ...dn, y: lerp(before.y, dn.y, t), age: lerp(before.age, dn.age, t) };
  });

  const moveTarget =
    prev.moveTarget && curr.moveTarget
      ? { x: lerp(prev.moveTarget.x, curr.moveTarget.x, t), y: lerp(prev.moveTarget.y, curr.moveTarget.y, t) }
      : curr.moveTarget;

  const cooldown = curr.cooldown
    ? { ...curr.cooldown, remainingMs: Math.max(0, curr.cooldown.remainingMs - Math.max(0, sinceSnapshot)) }
    : null;

  return {
    ...curr,
    player,
    enemies,
    projectiles,
    damageNumbers,
    moveTarget,
    gameElapsedMs: lerp(prev.gameElapsedMs, curr.gameElapsedMs, t),
    cooldown,
  };
}
