import { TACTICS_ACTIONS, type TacticsSnapshot } from '../shared/tactics.js';

/** Match the active portion of the existing melee action; rejected clicks have no cooldown and no bite. */
export function playerBiteFrame(snap: Pick<TacticsSnapshot, 'cooldown' | 'dead' | 'playerEating'>): number | null {
  const cd = snap.cooldown;
  if (snap.dead || snap.playerEating || !cd || TACTICS_ACTIONS[cd.slot]?.kind !== 'melee') return null;
  const spent = cd.totalMs - cd.remainingMs;
  if (spent < 0 || spent >= 320) return null;
  return Math.min(7, Math.floor(spent / 320 * 8));
}

/** A visual guide, following the old reticle's 35-degree cone and hound reach allowance. */
export function selectAttackReticle(snap: TacticsSnapshot, visible: (x: number, y: number) => boolean) {
  if (snap.dead) return null;
  const headingLength = Math.max(.001, Math.hypot(snap.playerHeading.x, snap.playerHeading.y));
  let result: { enemy: TacticsSnapshot['enemies'][number]; inRange: boolean; aligned: boolean } | null = null;
  let bestScore = Infinity;
  for (const enemy of snap.enemies) {
    const dx = enemy.x - snap.player.x, dy = enemy.y - snap.player.y;
    const distance = Math.hypot(dx, dy);
    const aligned = distance < .001 || (dx * snap.playerHeading.x + dy * snap.playerHeading.y) / (distance * headingLength) >= Math.cos(35 * Math.PI / 180);
    const reach = snap.meleeRange + (enemy.kind === 'hellhound' ? snap.meleeRange * (2 / 15) : 0);
    const inRange = distance <= reach;
    if ((!inRange && !aligned) || distance > snap.meleeRange * 4 || !visible(enemy.x, enemy.y)) continue;
    const score = (inRange && aligned ? 0 : 10000) + distance;
    if (score < bestScore) { bestScore = score; result = { enemy, inRange, aligned }; }
  }
  return result;
}
