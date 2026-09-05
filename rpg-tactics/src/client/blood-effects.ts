import { WORLD_HEIGHT } from "../../../src/shared/constants.js";
import type { TacticsSnapshot } from "../shared/tactics.js";

type Hit = { x: number; y: number; height: number; purple: boolean; player: boolean };

/** Snapshot changes trigger each impact once, including enemies removed by lethal hits. */
export function bloodHits(previous: TacticsSnapshot, snap: TacticsSnapshot): Hit[] {
  const hits: Hit[] = [];
  if (snap.stats.health < previous.stats.health) {
    hits.push({ ...snap.player, height: 1, purple: false, player: true });
  }
  const living = new Map(snap.enemies.map(enemy => [enemy.id, enemy]));
  for (const before of previous.enemies) {
    const after = living.get(before.id);
    const killed = !after && snap.corpses.some(corpse => corpse.id === before.id)
      && !previous.corpses.some(corpse => corpse.id === before.id);
    if (!(after && after.health < before.health) && !killed) continue;
    const enemy = after ?? before;
    hits.push({ x: enemy.x, y: enemy.y,
      height: enemy.kind === "bat" ? enemy.altitude ?? 2.25
        : enemy.kind === "spider" ? (enemy.altitude ?? 0) + .45 : 1.2,
      purple: enemy.kind === "spider", player: false });
  }
  return hits;
}

interface Drop {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  born: number; size: number; color: string;
}

/** Short-lived Canvas2D droplets; no meshes, textures, or persistent decals. */
export class BloodEffects {
  private drops: Drop[] = [];
  private nextEatingBurst = 0;

  update(previous: TacticsSnapshot, snap: TacticsSnapshot, now: number): void {
    if (previous.dead && !snap.dead) this.drops = [];
    const hits = bloodHits(previous, snap);
    if (!snap.playerEating || snap.dead) this.nextEatingBurst = 0;
    else if (now >= this.nextEatingBurst) {
      const corpse = snap.corpses.filter(c => !c.eaten && c.kind !== "gargoyle")
        .sort((a, b) => Math.hypot(a.x - snap.player.x, a.y - snap.player.y)
          - Math.hypot(b.x - snap.player.x, b.y - snap.player.y))[0];
      hits.push({ x: snap.player.x + snap.playerHeading.x * 30,
        y: snap.player.y + snap.playerHeading.y * 30, height: .45,
        purple: corpse?.kind === "spider", player: true });
      this.nextEatingBurst = now + 180;
    }
    for (const hit of hits) {
      for (let i = 0; i < 80; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 24 + Math.random() * 90;
        this.drops.push({ x: hit.x, y: hit.y, z: hit.height,
          vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
          vz: 2 + Math.random() * 6, born: now, size: .02 + Math.random() * .03,
          color: hit.purple ? (i % 3 ? "#78168f" : "#b32ec7")
            : (i % 3 ? "#8e0c16" : "#c3222c") });
      }
    }
    // Bound both overdraw and memory during a crowd fight.
    this.drops = this.drops.filter(drop => now - drop.born < 350).slice(-640);
  }

  draw(ctx: CanvasRenderingContext2D, now: number, viewWidth: number,
    project: (x: number, y: number, height: number) => { x: number; y: number }): void {
    this.drops = this.drops.filter(drop => now - drop.born < 350);
    ctx.save();
    for (const drop of this.drops) {
      const age = (now - drop.born) / 1000;
      const wx = drop.x + drop.vx * age, wy = drop.y + drop.vy * age;
      const z = Math.max(.03, drop.z + drop.vz * age - 20 * age * age);
      const point = project(wx, wy, z);
      if (point.x < 0 || point.x > viewWidth || point.y < 0 || point.y > WORLD_HEIGHT) continue;
      const size = Math.max(1, Math.min(5, Math.abs(project(wx, wy, z + drop.size).y - point.y)));
      ctx.globalAlpha = .9 * Math.min(1, (.35 - age) / .12);
      ctx.fillStyle = drop.color;
      ctx.fillRect(Math.round(point.x - size / 2), Math.round(point.y - size / 2), size, size);
    }
    ctx.restore();
  }
}
