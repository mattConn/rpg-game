import { ARENA_X, ARENA_Y, TILE_PX, REGIONS, ROOM_REGIONS, DUNGEON_CONNECTIONS, DUNGEON_PORTAL, EDITOR_DUNGEON, PRESSURE_PLATES, regionCentre, type Region, type TacticsSnapshot } from '../shared/tactics.js';

export interface RayHit { distance: number; x: number; y: number; side: number; material: number }
export interface Gate { x: number; y: number; min: number; max: number; vertical: boolean; material: number }
export class FloorGrid {
  readonly minCol: number; readonly minRow: number; readonly width: number; readonly height: number;
  readonly cells: Uint8Array;
  constructor(regions: readonly Region[]) {
    this.minCol = Math.min(...regions.map(r => r.col)) - 1;
    this.minRow = Math.min(...regions.map(r => r.row)) - 1;
    this.width = Math.max(...regions.map(r => r.col + r.cols)) - this.minCol + 1;
    this.height = Math.max(...regions.map(r => r.row + r.rows)) - this.minRow + 1;
    this.cells = new Uint8Array(this.width * this.height);
    for (const r of regions) for (let y = r.row; y < r.row + r.rows; y++)
      this.cells.fill(1, (y - this.minRow) * this.width + r.col - this.minCol, (y - this.minRow) * this.width + r.col + r.cols - this.minCol);
  }
  at(col: number, row: number): number {
    const x = col - this.minCol, y = row - this.minRow;
    return x < 0 || y < 0 || x >= this.width || y >= this.height ? 0 : this.cells[y * this.width + x]!;
  }
}

/** DDA visits each crossed cell exactly once; t is camera depth for unnormalized camera rays. */
export function castRay(grid: FloorGrid, x: number, y: number, dx: number, dy: number, gates: readonly Gate[] = [], max = 6000, skipInitialWalls = false): RayHit {
  let col = Math.floor((x - ARENA_X) / TILE_PX), row = Math.floor((y - ARENA_Y) / TILE_PX);
  const sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1;
  const deltaX = Math.abs(TILE_PX / dx), deltaY = Math.abs(TILE_PX / dy);
  let tx = dx === 0 ? Infinity : (ARENA_X + (col + (sx > 0 ? 1 : 0)) * TILE_PX - x) / dx;
  let ty = dy === 0 ? Infinity : (ARENA_Y + (row + (sy > 0 ? 1 : 0)) * TILE_PX - y) / dy;
  let distance = 0, side = 0;
  let enteredFloor = !skipInitialWalls || !!grid.at(col, row);
  let floorEntry = 0;
  if (dx === 0 && dy === 0) return { distance: max, x, y, side, material: 0 };
  const outsideSteps = Math.max(0, grid.minCol - col, col - (grid.minCol + grid.width - 1))
    + Math.max(0, grid.minRow - row, row - (grid.minRow + grid.height - 1));
  for (let steps = 0; steps < grid.width + grid.height + outsideSteps + 2; steps++) {
    if (tx < ty) { distance = tx; tx += deltaX; col += sx; side = 0; }
    else { distance = ty; ty += deltaY; row += sy; side = 1; }
    if (distance >= max) break;
    const floor = !!grid.at(col, row);
    if (!enteredFloor) {
      if (floor) { enteredFloor = true; floorEntry = distance; }
    } else if (!floor) break;
  }
  distance = enteredFloor ? Math.min(max, Math.max(.01, distance)) : max;
  let material = 0;
  for (const gate of gates) {
    const axis = gate.vertical ? dx : dy;
    if (Math.abs(axis) < 1e-9) continue;
    const t = ((gate.vertical ? gate.x : gate.y) - (gate.vertical ? x : y)) / axis;
    const across = gate.vertical ? y + dy * t : x + dx * t;
    if (t > Math.max(.01, floorEntry) && t < distance && across >= gate.min && across <= gate.max) {
      distance = t; side = gate.vertical ? 0 : 1; material = gate.material;
    }
  }
  return { distance, x: x + dx * distance, y: y + dy * distance, side, material };
}

export class RaycastWorld {
  readonly grid = new FloorGrid(REGIONS);
  gates: Gate[] = [];
  private key = '';
  update(snap: TacticsSnapshot): void {
    const key = snap.pressurePlates.map(p => Number(p.active)).join('') + ':' + snap.dungeonPortal.unlocked;
    if (key === this.key) return;
    this.key = key; this.gates = [];
    for (const state of snap.pressurePlates) {
      if (!state.active) continue;
      const plate = PRESSURE_PLATES.find(p => p.id === state.id);
      const connection = plate && DUNGEON_CONNECTIONS[plate.connectionIndex];
      const room = plate && ROOM_REGIONS[plate.roomIndex];
      if (room && connection) this.addGate(room, connection.hall, 1);
    }
    if (!EDITOR_DUNGEON && !snap.dungeonPortal.unlocked) {
      const room = ROOM_REGIONS[DUNGEON_PORTAL.roomIndex];
      if (room) this.addGate(room, DUNGEON_PORTAL.exitRegion, 2);
    }
  }
  private addGate(room: Region, hall: Region, material: number) {
    const center = regionCentre(room), to = regionCentre(hall);
    const vertical = Math.abs(to.x - center.x) > Math.abs(to.y - center.y);
    const x = ARENA_X + (to.x > center.x ? room.col + room.cols : room.col) * TILE_PX;
    const y = ARENA_Y + (to.y > center.y ? room.row + room.rows : room.row) * TILE_PX;
    this.gates.push({ x, y, vertical, material,
      min: vertical ? ARENA_Y + hall.row * TILE_PX : ARENA_X + hall.col * TILE_PX,
      max: vertical ? ARENA_Y + (hall.row + hall.rows) * TILE_PX : ARENA_X + (hall.col + hall.cols) * TILE_PX });
  }
  cast(x: number, y: number, dx: number, dy: number, max = 6000, skipInitialWalls = false): RayHit { return castRay(this.grid, x, y, dx, dy, this.gates, max, skipInitialWalls); }
}

/** View-only wall cutaway: solid gameplay geometry remains unchanged. */
export function castCameraRay(grid: FloorGrid, x: number, y: number, dx: number, dy: number,
  gates: readonly Gate[], cutawayDepth: number, max = 6000): RayHit & { veils: RayHit[] } {
  let col = Math.floor((x - ARENA_X) / TILE_PX), row = Math.floor((y - ARENA_Y) / TILE_PX);
  const sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1;
  const stepX = Math.abs(TILE_PX / dx), stepY = Math.abs(TILE_PX / dy);
  let tx = dx === 0 ? Infinity : (ARENA_X + (col + (sx > 0 ? 1 : 0)) * TILE_PX - x) / dx;
  let ty = dy === 0 ? Infinity : (ARENA_Y + (row + (sy > 0 ? 1 : 0)) * TILE_PX - y) / dy;
  const hit = (distance: number, side: number, material = 0): RayHit => ({ distance, side, material, x: x + dx * distance, y: y + dy * distance });
  let result = hit(max, 0), wasFloor = !!grid.at(col, row), recordedSolid = false;
  const veils: RayHit[] = [];
  const steps = Math.ceil(max * (Math.abs(dx) + Math.abs(dy)) / TILE_PX) + 2;
  for (let i = 0; i < steps; i++) {
    let distance: number, side: number;
    if (tx < ty) { distance = tx; tx += stepX; col += sx; side = 0; }
    else { distance = ty; ty += stepY; row += sy; side = 1; }
    if (distance >= max) break;
    const floor = !!grid.at(col, row);
    if (wasFloor && !floor) {
      if (distance >= cutawayDepth) { result = hit(distance, side); break; }
      veils.push(hit(distance, side)); recordedSolid = true;
    } else if (!wasFloor && floor) {
      if (!recordedSolid && distance < cutawayDepth) veils.push(hit(distance, side));
      recordedSolid = false;
    }
    wasFloor = floor;
  }
  for (const gate of gates) {
    const axis = gate.vertical ? dx : dy;
    if (Math.abs(axis) < 1e-9) continue;
    const t = ((gate.vertical ? gate.x : gate.y) - (gate.vertical ? x : y)) / axis;
    const across = gate.vertical ? y + dy * t : x + dx * t;
    if (t > .01 && t < result.distance && across >= gate.min && across <= gate.max) {
      const gateHit = hit(t, gate.vertical ? 0 : 1, gate.material);
      if (t < cutawayDepth) veils.push(gateHit); else result = gateHit;
    }
  }
  return { ...result, veils: veils.filter(v => v.distance < result.distance).sort((a, b) => b.distance - a.distance) };
}
