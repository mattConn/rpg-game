import type { TacticsSnapshot } from "../shared/tactics.js";

/** World-space purple flash and flying crystal shards, drawn without live 3D. */
export class GemExplosion {
  private burst: { x: number; y: number; born: number;
    shards: { vx: number; vy: number; vz: number }[] } | null = null;

  update(previous: TacticsSnapshot, snap: TacticsSnapshot, now: number): void {
    if (!snap.purpleGem.destroyed) this.burst = null;
    else if (!previous.purpleGem.destroyed) this.burst = {
      x: snap.purpleGem.x, y: snap.purpleGem.y, born: now,
      shards: Array.from({ length: 32 }, () => {
        const angle = Math.random() * Math.PI * 2, speed = 48 + Math.random() * 81;
        return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
          vz: 1.1 + Math.random() * 2.8 };
      }),
    };
  }

  draw(ctx: CanvasRenderingContext2D, now: number,
    project: (x: number, y: number, height: number) => { x: number; y: number }): void {
    const burst = this.burst;
    if (!burst) return;
    // Play the entire burst at double speed: 450 ms total, 150 ms flash.
    const age = (now - burst.born) / 500;
    if (age >= .9) { this.burst = null; return; }
    ctx.save();
    if (age < .3) {
      const center = project(burst.x, burst.y, 1.07);
      const edge = project(burst.x, burst.y, 1.07 + .3 + age * 4);
      const radius = Math.abs(edge.y - center.y);
      if (center.x >= 0 && radius > 0) {
        ctx.globalAlpha = (1 - age / .3) * .85;
        const glow = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius);
        glow.addColorStop(0, "#ffffff"); glow.addColorStop(.3, "#f4d9ff");
        glow.addColorStop(.65, "#b12cff"); glow.addColorStop(1, "#9d20ff00");
        ctx.fillStyle = glow; ctx.fillRect(center.x - radius, center.y - radius, radius * 2, radius * 2);
      }
    }
    ctx.globalAlpha = Math.min(1, (.9 - age) / .4);
    burst.shards.forEach((shard, i) => {
      const x = burst.x + shard.vx * age, y = burst.y + shard.vy * age;
      const height = Math.max(.03, 1.07 + shard.vz * age - 4 * age * age);
      const point = project(x, y, height);
      if (point.x < 0) return;
      const size = Math.min(14, Math.max(1, Math.abs(project(x, y, height + .12).y - point.y)));
      ctx.fillStyle = i % 3 ? "#b12cff" : "#f4e9ff";
      ctx.fillRect(Math.round(point.x - size / 2), Math.round(point.y - size / 2), size, size);
    });
    ctx.restore();
  }
}
