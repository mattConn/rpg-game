import type { TacticsSnapshot } from "../shared/tactics.js";
export interface FloorRecord {
  key: string; seed: number; deaths: number; enemiesKilled: number; totalEnemies: number;
  deathIds: string[];
}
const STORAGE_KEY = "rpg-floor-stats-v1";
export class FloorStats {
  readonly floors = new Map<string, FloorRecord>();
  constructor(private storage: Pick<Storage, "getItem" | "setItem"> | null) {
    try {
      const saved: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "[]");
      if (Array.isArray(saved)) for (const row of saved) {
        if (typeof row.key === "string" && Number.isSafeInteger(row.seed)
          && Number.isSafeInteger(row.deaths) && row.deaths >= 0
          && Number.isSafeInteger(row.enemiesKilled) && row.enemiesKilled >= 0
          && Number.isSafeInteger(row.totalEnemies) && row.totalEnemies >= row.enemiesKilled
          && Array.isArray(row.deathIds) && row.deathIds.every((id: unknown) => typeof id === "string"))
          this.floors.set(row.key, row);
      }
    } catch { /* Keep playing if saved data or storage is unavailable. */ }
  }
  update(key: string, seed: number, snap: TacticsSnapshot): FloorRecord {
    const existing = this.floors.get(key);
    const row = existing ?? { key, seed, deaths: 0, enemiesKilled: 0, totalEnemies: 0, deathIds: [] };
    const killed = Math.max(0, snap.killCount);
    const total = killed + snap.enemies.length;
    let changed = !existing || row.enemiesKilled !== killed || row.totalEnemies !== total;
    // Snapshot counts replace the previous attempt; they never accumulate kills
    // from resurrected enemies or repeated websocket snapshots.
    row.enemiesKilled = killed; row.totalEnemies = total;
    const seen = new Set(row.deathIds);
    for (const stone of snap.tombstones) {
      const id = `${snap.floorRunId ?? "legacy"}:${stone.gameElapsedMs}:${stone.x}:${stone.y}`;
      if (!seen.has(id)) { seen.add(id); row.deathIds.push(id); row.deaths++; changed = true; }
    }
    this.floors.set(key, row);
    if (changed) try { this.storage?.setItem(STORAGE_KEY, JSON.stringify([...this.floors.values()])); } catch { /* Optional persistence. */ }
    return row;
  }
  get totalDeaths(): number { return [...this.floors.values()].reduce((sum, row) => sum + row.deaths, 0); }
  csv(): string {
    return "seed,deaths,enemies killed/total\r\n" + [...this.floors.values()]
      .map(row => `${row.seed},${row.deaths},${row.enemiesKilled}/${row.totalEnemies}`).join("\r\n") + "\r\n";
  }
}
