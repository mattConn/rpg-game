/**
 * Real-time simulation on the tactics board. The player moves continuously
 * with WASD or click-to-move, enemies chase and attack on their own clock,
 * and combat is cooldown-gated rather than turn-gated.
 *
 * The board, the grid, the rooms and the corridor are unchanged — only the
 * pacing is different.
 */

import { ACTIONS } from "../../../src/shared/actions.js";
import {
  DAMAGE_NUMBER_LIFETIME,
  DAMAGE_NUMBER_SPEED,
  PROJECTILE_SPEED,
  advanceDagger,
  daggerDone,
  spawnDagger,
  type Projectile,
} from "../../../src/shared/combat.js";
import { HELLHOUND } from "../../../src/shared/enemies.js";
import {
  LOOT_CLOSE_RECT,
  LOOT_MENU_RECT,
  corpseLabel,
  corpseOf,
  hitsRect,
  type Corpse,
} from "../../../src/shared/loot.js";
import type { Point } from "../../../src/shared/movement.js";
import {
  AGGRO_RANGE,
  ARENA_ROOM,
  ARENA_X,
  ATTACK_MS,
  AUTO_RESTART_DELAY_MS,
  BOARD_REGION,
  DOOR_BOUNDARY_Y,
  FAR_REGION,
  HALL_REGION,
  HOUND_DAMAGE,
  HOUND_MAX_HEALTH,
  HOUND_STARTS,
  LOG_LINES,
  MELEE_DAMAGE,
  MELEE_RANGE,
  MIN_SEPARATION,
  MOVE_RANGE,
  PLAYER_MAX_HEALTH,
  PLAYER_MAX_MANA,
  PLAYER_START,
  RANGED_DAMAGE,
  SQUARE_PX,
  TILE_PX,
  blockedByDoor,
  canReach,
  cellAtPoint,
  cellCenter,
  clampPointToFloor,
  clampToGrid,
  distance,
  facingToward,
  inGrid,
  inRegion,
  isOver,
  stepToward,
  withinAggro,
  type Cell,
  type Phase,
  type Region,
  type TacticsInput,
  type TacticsSnapshot,
} from "../shared/tactics.js";

// ------------------------------------------------------------------ constants

const DAMAGE_COLOR_DEALT = "#ffd633";
const DAMAGE_COLOR_TAKEN = "#ff6b6b";

const MAX_CORPSES = 8;

/** Player walking speed in room pixels per second. */
const PLAYER_SPEED = 200;
/** Enemy chase speed in room pixels per second. */
const ENEMY_SPEED = 140;
/** Melee cooldown in ms. */
const MELEE_COOLDOWN_MS = 600;
/** Ranged cooldown in ms. */
const RANGED_COOLDOWN_MS = 1000;
/** How often a hellhound bites, in ms. */
const ENEMY_ATTACK_INTERVAL_MS = 1500;
/** Recovery after throwing a dagger, in ms. */
const THROW_RECOVER_MS = 220;
/** How fast an un-aggro'd hound patrols, in room pixels per second. */
const PATROL_SPEED = 50;
/** Width of the horizontal patrol beat, in room pixels (~1.5 squares). */
const PATROL_SPAN = SQUARE_PX * 1.5;

// Corridor waypoints for cross-region navigation.
const HALL_MID_COL = HALL_REGION.col + Math.floor(HALL_REGION.cols / 2);
/** Inside the board, one cell north of the hall entrance. */
const BOARD_DOORWAY = cellCenter({ col: HALL_MID_COL, row: BOARD_REGION.row + BOARD_REGION.rows - 1 });
/** Inside the far room, one cell south of the hall exit. */
const FAR_DOORWAY = cellCenter({ col: HALL_MID_COL, row: FAR_REGION.row });
/** First cell inside the hall, on the board side. */
const HALL_NORTH = cellCenter({ col: HALL_MID_COL, row: HALL_REGION.row });
/** Last cell inside the hall, on the far-room side. */
const HALL_SOUTH = cellCenter({ col: HALL_MID_COL, row: HALL_REGION.row + HALL_REGION.rows - 1 });

const FIRST_NAMES = ["Bran", "Kael", "Mira", "Oswin", "Tamsin", "Vek", "Yara", "Dorn", "Isolde", "Rook"];
const LAST_NAMES = ["the Bold", "Ashfoot", "Quickblade", "of Thornvale", "Emberhand", "Greycloak", "the Lost"];

const pick = <T,>(values: readonly T[]): T => values[Math.floor(Math.random() * values.length)]!;

// ------------------------------------------------------------------ types

interface Actor {
  id: string;
  name: string;
  cell: Cell;
  pos: Point;
  x: number;
  y: number;
  facing: 1 | -1;
  health: number;
  maxHealth: number;
}

interface Hound extends Actor {
  glyph: string;
  color: string;
  aggro: boolean;
  nextAttackAt: number;
  patrolLeft: number;
  patrolRight: number;
  patrolDir: 1 | -1;
}

interface DamageNumber {
  id: string;
  x: number;
  y: number;
  text: string;
  color: string;
  age: number;
}

interface Thrown {
  projectile: Projectile;
  target: Point;
  enemyId: string;
  damage: number;
}

// ------------------------------------------------------------------ simulation

export class TacticsGame {
  private readonly playerName = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
  private readonly playerColor = `hsl(${Math.floor(Math.random() * 360)} 85% 65%)`;

  private player!: Actor;
  private enemies!: Hound[];
  private corpses!: Corpse[];

  private phase!: Phase;

  private targetId!: string | null;
  private activeSlot = 0;
  private log!: string[];

  private thrown!: Thrown | null;
  private damageNumbers!: DamageNumber[];
  private tombstones!: Array<{ x: number; y: number; gameElapsedMs: number }>;
  private inspectingId!: string | null;

  private strikes!: Array<{ enemyId: string; seq: number }>;
  private strikeSeq = 0;
  private doorsClosed!: [boolean, boolean];

  private deathAt!: number;
  private killCount!: number;
  private nextEnemySeq = 0;

  /** The direction WASD is pushing, as a unit vector or zero. */
  private moveDir: Point = { x: 0, y: 0 };
  /** Click-to-move destination, cleared on arrival or when WASD overrides. */
  private moveTarget: Point | null = null;

  /** Player attack cooldown. */
  private nextAttackAt = 0;
  private cooldownSlot = 0;
  private cooldownStart: number | null = null;
  private cooldownTotal = 0;

  private autoRestart = false;

  private gameElapsedMs = 0;
  private lastTick = 0;

  constructor(now: number = Date.now()) {
    this.reset(now);
  }

  // ------------------------------------------------------------------ setup

  private reset(now: number): void {
    this.player = {
      id: "player",
      name: this.playerName,
      cell: { ...PLAYER_START },
      pos: cellCenter(PLAYER_START),
      ...cellCenter(PLAYER_START),
      facing: 1,
      health: PLAYER_MAX_HEALTH,
      maxHealth: PLAYER_MAX_HEALTH,
    };

    this.enemies = HOUND_STARTS.map((cell) => {
      const center = cellCenter(cell);
      const left = clampPointToFloor({ x: center.x - PATROL_SPAN / 2, y: center.y });
      const right = clampPointToFloor({ x: center.x + PATROL_SPAN / 2, y: center.y });
      return {
        id: `hound-${this.nextEnemySeq++}`,
        ...HELLHOUND,
        cell: { ...cell },
        pos: center,
        ...center,
        facing: -1 as const,
        health: HOUND_MAX_HEALTH,
        maxHealth: HOUND_MAX_HEALTH,
        aggro: false,
        nextAttackAt: 0,
        patrolLeft: left.x,
        patrolRight: right.x,
        patrolDir: -1 as const,
      };
    });

    this.corpses = [];
    this.phase = "player";
    this.targetId = null;
    this.thrown = null;
    this.damageNumbers = [];
    this.tombstones = [];
    this.inspectingId = null;
    this.strikes = [];
    this.moveDir = { x: 0, y: 0 };
    this.moveTarget = null;
    this.nextAttackAt = 0;
    this.deathAt = 0;
    this.killCount = 0;
    this.cooldownStart = null;
    this.doorsClosed = [true, true];
    this.log = ["Two hellhounds watch you from across the vault."];
    this.lastTick = now;
  }

  // ------------------------------------------------------------------- tick

  tick(now: number): void {
    const dt = Math.min((now - this.lastTick) / 1000, 0.1);
    this.lastTick = now;
    this.gameElapsedMs += dt * 1000;

    if (this.phase === "dead" && this.autoRestart && now - this.deathAt >= AUTO_RESTART_DELAY_MS) {
      this.restart(now);
      return;
    }

    if (isOver(this.phase)) return;

    // Player movement — continuous, every tick.
    this.movePlayer(dt);

    // Enemy AI — woken hounds chase and attack, others patrol.
    for (const enemy of this.enemies) {
      if (enemy.aggro) {
        this.updateEnemy(enemy, dt, now);
      } else {
        this.patrolEnemy(enemy, dt);
      }
    }

    this.advanceThrown(dt);
    this.updateDamageNumbers(dt);
    this.wakeAdjacent();
    this.faceThePlayer();
    this.retireDead();

    if (this.player.health <= 0) {
      this.tombstones.push({ x: this.player.x, y: this.player.y, gameElapsedMs: this.gameElapsedMs });
      this.deathAt = now;
      this.finish("dead", "The pack pulls you down.");
      return;
    }
    if (this.enemies.length === 0) {
      this.finish("cleared", "Both hounds are down. The vault is quiet.");
    }
  }

  // --------------------------------------------------------- player movement

  /**
   * Move the player each tick. WASD (moveDir) has priority over click-to-move
   * (moveTarget). Position updates are free-form — no grid snapping.
   */
  private movePlayer(dt: number): void {
    const dirLen = Math.hypot(this.moveDir.x, this.moveDir.y);

    if (dirLen > 0.001) {
      // WASD: move in the held direction, cancelling any click target.
      this.moveTarget = null;
      const nx = this.moveDir.x / dirLen;
      const ny = this.moveDir.y / dirLen;
      const step = PLAYER_SPEED * dt;
      this.stepPlayer(nx * step, ny * step);
    } else if (this.moveTarget) {
      // Click-to-move: walk toward the target.
      const from = this.playerAt();
      const remaining = distance(from, this.moveTarget);
      if (remaining < 2) {
        this.moveTarget = null;
        return;
      }
      const step = Math.min(PLAYER_SPEED * dt, remaining);
      const nx = (this.moveTarget.x - from.x) / remaining;
      const ny = (this.moveTarget.y - from.y) / remaining;
      if (!this.stepPlayer(nx * step, ny * step)) this.moveTarget = null;
    }
  }

  /**
   * Prevent a raw position from crossing a closed door boundary. The check
   * is minimal — just stop at the boundary — because `clampPointToFloor`
   * snaps to cell centres that are already very close (half a tile) to the
   * boundary. Visual blocking is handled client-side by a ceiling occluder
   * and camera clamping.
   */
  private clampToDoors(from: Point, raw: Point): void {
    for (let i = 0; i < 2; i++) {
      if (!this.doorsClosed[i]) continue;
      const by = DOOR_BOUNDARY_Y[i]!;
      if (from.y < by && raw.y >= by) raw.y = by - 0.5;
      else if (from.y >= by && raw.y < by) raw.y = by + 0.5;
    }
  }

  /** Apply a pixel displacement to the player, clamping to the floor. Returns whether it moved. */
  private stepPlayer(dx: number, dy: number): boolean {
    const from = this.playerAt();
    const raw = { x: from.x + dx, y: from.y + dy };
    this.clampToDoors(from, raw);
    const target = clampPointToFloor(raw);
    if (distance(from, target) < 0.01) return false;

    const targetCell = clampToGrid(target);
    if (blockedByDoor(this.player.cell, targetCell, this.doorsClosed)) return false;

    this.player.facing = facingToward(from, target, this.player.facing);
    this.player.pos = { ...target };
    this.player.x = target.x;
    this.player.y = target.y;
    this.player.cell = clampToGrid(target);
    return true;
  }

  // --------------------------------------------------------- enemy AI

  /**
   * Horizontal patrol for a hound that hasn't noticed the player yet. It walks
   * back and forth within its patrol beat, reversing at either end.
   */
  private patrolEnemy(enemy: Hound, dt: number): void {
    const pos = this.at(enemy);
    let nx = pos.x + PATROL_SPEED * dt * enemy.patrolDir;

    if (nx <= enemy.patrolLeft) {
      nx = enemy.patrolLeft;
      enemy.patrolDir = 1;
    } else if (nx >= enemy.patrolRight) {
      nx = enemy.patrolRight;
      enemy.patrolDir = -1;
    }

    const raw = { x: nx, y: pos.y };
    this.clampToDoors(pos, raw);
    const target = clampPointToFloor(raw);
    const targetCell = clampToGrid(target);
    if (blockedByDoor(enemy.cell, targetCell, this.doorsClosed)) return;
    enemy.facing = enemy.patrolDir;
    enemy.pos = { ...target };
    enemy.x = target.x;
    enemy.y = target.y;
    enemy.cell = targetCell;
  }

  /**
   * One enemy's per-tick behaviour: chase the player, bite when close enough.
   */
  private updateEnemy(enemy: Hound, dt: number, now: number): void {
    const enemyPos = this.at(enemy);
    const playerPos = this.playerAt();

    if (canReach(enemyPos, playerPos)) {
      // In melee range: attack on cooldown.
      enemy.facing = facingToward(enemyPos, playerPos, enemy.facing);
      if (now >= enemy.nextAttackAt) {
        this.strikes.push({ enemyId: enemy.id, seq: ++this.strikeSeq });
        this.player.health = Math.max(0, this.player.health - HOUND_DAMAGE);
        this.spawnDamageNumber(this.player.x, this.player.y, HOUND_DAMAGE, DAMAGE_COLOR_TAKEN);
        this.inspectingId = null;
        enemy.nextAttackAt = now + ENEMY_ATTACK_INTERVAL_MS;
      }
      return;
    }

    // Chase: move toward a position where the enemy could bite.
    const goal = this.chooseGoal(enemy);
    if (!goal) return;

    const gap = distance(enemyPos, goal);
    if (gap < 1) return;
    const step = Math.min(ENEMY_SPEED * dt, gap);
    const nx = (goal.x - enemyPos.x) / gap;
    const ny = (goal.y - enemyPos.y) / gap;

    const raw = { x: enemyPos.x + nx * step, y: enemyPos.y + ny * step };
    this.clampToDoors(enemyPos, raw);
    const target = clampPointToFloor(raw);
    const targetCell = clampToGrid(target);
    if (blockedByDoor(enemy.cell, targetCell, this.doorsClosed)) return;
    enemy.facing = facingToward(enemyPos, target, enemy.facing);
    enemy.pos = { ...target };
    enemy.x = target.x;
    enemy.y = target.y;
    enemy.cell = targetCell;
  }

  /** Which region a cell belongs to, falling back to the board. */
  private regionOfCell(cell: Cell): Region {
    if (inRegion(HALL_REGION, cell)) return HALL_REGION;
    if (inRegion(FAR_REGION, cell)) return FAR_REGION;
    return BOARD_REGION;
  }

  /**
   * When enemy and player are in different regions, return the next waypoint
   * on the path through the corridor that connects them. From a wide room
   * the enemy first walks to the doorway (staying on floor the whole way),
   * then steps across into the hall once it is close enough.
   */
  private nextWaypoint(enemy: Hound): Point | null {
    const from = this.at(enemy);
    const enemyRegion = this.regionOfCell(enemy.cell);
    const playerRegion = this.regionOfCell(this.player.cell);

    if (enemyRegion === BOARD_REGION) {
      if (this.doorsClosed[0]) return null;
      if (distance(from, BOARD_DOORWAY) > TILE_PX) return BOARD_DOORWAY;
      return HALL_NORTH;
    }

    if (enemyRegion === FAR_REGION) {
      if (this.doorsClosed[1]) return null;
      if (distance(from, FAR_DOORWAY) > TILE_PX) return FAR_DOORWAY;
      return HALL_SOUTH;
    }

    // In the hall: head toward whichever end leads to the player.
    if (playerRegion === BOARD_REGION) {
      if (this.doorsClosed[0]) return null;
      return BOARD_DOORWAY;
    }
    if (this.doorsClosed[1]) return null;
    return FAR_DOORWAY;
  }

  /**
   * Pick a point the enemy wants to reach — somewhere it could bite from, on
   * the side it is already approaching from so two hounds flank naturally.
   *
   * When the enemy and player are in different regions the goal is a corridor
   * doorway rather than a combat position, so the hound navigates through
   * the corridor before trying to flank.
   *
   * canReach requires dx >= dy (a horizontal cone), so the goal must have
   * enough horizontal offset. If the hound is coming from nearly straight
   * above or below the player, nudge the approach to the nearest side of the
   * cone so it doesn't stand there unable to bite.
   */
  private chooseGoal(enemy: Hound): Point | null {
    const from = this.at(enemy);
    const player = this.playerAt();

    // Different region: navigate through the corridor doorways first.
    const enemyRegion = this.regionOfCell(enemy.cell);
    const playerRegion = this.regionOfCell(this.player.cell);
    if (enemyRegion !== playerRegion) {
      return this.nextWaypoint(enemy);
    }

    // Same region: head for a position within the canReach cone.
    const toEnemy = distance(player, from);
    if (toEnemy < 1) return null;
    let dirX = (from.x - player.x) / toEnemy;
    let dirY = (from.y - player.y) / toEnemy;

    if (Math.abs(dirX) < Math.abs(dirY)) {
      dirX = Math.sign(dirX || 1) * Math.abs(dirY);
      const len = Math.hypot(dirX, dirY);
      dirX /= len;
      dirY /= len;
    }

    return {
      x: player.x + dirX * (MELEE_RANGE * 0.7),
      y: player.y + dirY * (MELEE_RANGE * 0.7),
    };
  }

  // --------------------------------------------------------- shared tick helpers

  private wakeAdjacent(): void {
    const player = this.playerAt();
    for (const enemy of this.enemies) {
      if (enemy.aggro) continue;
      if (withinAggro(this.at(enemy), player)) this.wake(enemy);
    }
  }

  private faceThePlayer(): void {
    for (const enemy of this.enemies) {
      if (!enemy.aggro) continue;
      // Only face the player when standing still (not mid-chase, handled in updateEnemy).
    }
  }

  private advanceThrown(dt: number): void {
    const thrown = this.thrown;
    if (!thrown) return;

    advanceDagger(thrown.projectile, dt);
    if (!daggerDone(thrown.projectile, thrown.target)) return;

    this.thrown = null;
    const enemy = this.enemies.find((e) => e.id === thrown.enemyId);
    if (!enemy) return;
    this.wound(enemy, thrown.damage);
  }

  private updateDamageNumbers(dt: number): void {
    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      const dn = this.damageNumbers[i]!;
      dn.y -= DAMAGE_NUMBER_SPEED * dt;
      dn.age += dt;
      if (dn.age >= DAMAGE_NUMBER_LIFETIME) this.damageNumbers.splice(i, 1);
    }
  }

  private retireDead(): void {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i]!;
      if (enemy.health > 0) continue;

      if (this.targetId === enemy.id) this.targetId = null;

      this.corpses.push(corpseOf({
        id: enemy.id,
        name: enemy.name,
        glyph: enemy.glyph,
        color: enemy.color,
        room: { ...ARENA_ROOM },
        x: enemy.x,
        y: enemy.y,
        facing: enemy.facing,
      }));
      if (this.corpses.length > MAX_CORPSES) this.corpses.shift();

      this.enemies.splice(i, 1);
      this.killCount++;
      this.say(`The ${enemy.name.toLowerCase()} falls.`);
    }
  }

  private finish(phase: Phase, line: string): void {
    this.phase = phase;
    this.moveTarget = null;
    this.moveDir = { x: 0, y: 0 };
    this.cooldownStart = null;
    this.inspectingId = null;
    this.say(line);
  }

  // ----------------------------------------------------------- combat

  private selectSlot(index: number): void {
    if (!ACTIONS[index]) return;
    this.activeSlot = index;
  }

  /**
   * Swing the selected weapon at the mark. Gated by a cooldown rather than
   * by a turn — the player can keep moving while waiting for the next swing.
   */
  private attack(now: number): void {
    if (isOver(this.phase)) return;
    if (now < this.nextAttackAt) return;

    const action = ACTIONS[this.activeSlot];
    const target = this.livingTarget();
    const reach = target ? canReach(this.playerAt(), this.at(target)) : false;
    if (target) this.player.facing = facingToward(this.playerAt(), this.at(target), this.player.facing);

    if (!action || !target) {
      return; // No target or no weapon — just do nothing.
    }

    if (action.kind === "melee") {
      if (!reach) return; // Out of range — wait until closer.
      this.wound(target, MELEE_DAMAGE);
      this.wake(target);
      this.say(`You cut the ${target.name.toLowerCase()} for ${MELEE_DAMAGE}.`);
      this.startCooldown(now, MELEE_COOLDOWN_MS);
      return;
    }

    // Ranged: dead zone inside melee reach.
    if (reach) return;

    this.wake(target);

    const from = { x: this.player.x, y: this.player.y };
    const to = this.at(target);
    this.thrown = {
      projectile: spawnDagger(from, to),
      target: to,
      enemyId: target.id,
      damage: RANGED_DAMAGE,
    };
    this.say(`You throw a dagger at the ${target.name.toLowerCase()}.`);

    const flightMs = (Math.hypot(to.x - from.x, to.y - from.y) / PROJECTILE_SPEED) * 1000;
    this.startCooldown(now, flightMs + THROW_RECOVER_MS + RANGED_COOLDOWN_MS);
  }

  private startCooldown(now: number, totalMs: number): void {
    this.nextAttackAt = now + totalMs;
    this.cooldownSlot = this.activeSlot;
    this.cooldownStart = now;
    this.cooldownTotal = totalMs;
  }

  private wound(enemy: Hound, amount: number): void {
    enemy.health = Math.max(0, enemy.health - amount);
    this.spawnDamageNumber(enemy.x, enemy.y, amount, DAMAGE_COLOR_DEALT);
  }

  private wake(enemy: Hound): void {
    if (enemy.aggro) return;
    enemy.aggro = true;
    this.say(`The ${enemy.name.toLowerCase()} fixes on you.`);
  }

  // ------------------------------------------------------------------ input

  handleInput(msg: TacticsInput, now: number = Date.now()): void {
    if (msg.type === "restart") {
      this.restart(now);
      return;
    }

    if (this.inspectingId && msg.type !== "click" && msg.type !== "dblclick") {
      this.inspectingId = null;
    }

    switch (msg.type) {
      case "keydown":
        this.onKey(msg.key, msg.code, now);
        break;
      case "click":
        this.onClick({ x: msg.x, y: msg.y }, now);
        break;
      case "dblclick":
        this.onDoubleClick({ x: msg.x, y: msg.y });
        break;
      case "slot":
        this.selectSlot(msg.index);
        break;
      case "attack":
        this.attack(now);
        break;
      case "move":
        this.setMoveDir(msg.dx, msg.dy);
        break;
      case "toggleDoor":
        if (msg.index === 0 || msg.index === 1) {
          this.doorsClosed[msg.index] = !this.doorsClosed[msg.index];
        }
        break;
      case "resurrect":
        this.restart(now);
        break;
      case "toggleAutoResurrect":
        this.autoRestart = !this.autoRestart;
        break;
      default:
        break;
    }
  }

  /** Set or clear the movement direction from WASD. */
  private setMoveDir(dx: number, dy: number): void {
    this.moveDir = { x: dx, y: dy };
  }

  private onKey(key: string, code: string, now: number): void {
    if (code === "Tab") {
      this.cycleTarget();
      return;
    }
    if (key >= "1" && key <= "5" && key.length === 1) {
      this.selectSlot(Number(key) - 1);
      return;
    }
    if (key === " ") {
      this.attack(now);
      return;
    }
    if (key === "r") {
      this.restart(now);
      return;
    }
    if (key === "escape") this.targetId = null;
  }

  private onClick(point: Point, now: number): void {
    if (this.inspectingId) {
      if (hitsRect(LOOT_CLOSE_RECT, point)) this.inspectingId = null;
      else if (hitsRect(LOOT_MENU_RECT, point)) return;
      else this.inspectingId = null;
      return;
    }

    if (isOver(this.phase)) {
      if (this.phase !== "dead") this.restart(now);
      return;
    }

    const enemy = this.enemyNear(point);
    if (enemy) {
      this.targetId = this.targetId === enemy.id ? null : enemy.id;
      return;
    }

    // Click-to-move: walk to the clicked point (no grid snapping).
    const cell = cellAtPoint(point);
    if (cell && inGrid(cell)) {
      this.moveTarget = { ...point };
      return;
    }

    const corpse = this.corpseNear(point);
    if (corpse) this.targetId = corpse.id;
  }

  private enemyNear(point: Point): Hound | null {
    let best: Hound | null = null;
    let bestGap = MIN_SEPARATION;
    for (const enemy of this.enemies) {
      const gap = distance(point, this.at(enemy));
      if (gap < bestGap) { bestGap = gap; best = enemy; }
    }
    return best;
  }

  private corpseNear(point: Point): Corpse | null {
    let best: Corpse | null = null;
    let bestGap = MIN_SEPARATION;
    for (const corpse of this.corpses) {
      const gap = distance(point, { x: corpse.x, y: corpse.y });
      if (gap < bestGap) { bestGap = gap; best = corpse; }
    }
    return best;
  }

  private onDoubleClick(point: Point): void {
    if (this.inspectingId) return;

    const enemy = this.enemyNear(point);
    if (enemy) {
      this.targetId = enemy.id;
      return;
    }

    const corpse = this.corpseNear(point);
    if (corpse) {
      this.targetId = corpse.id;
      this.inspectingId = corpse.id;
    }
  }

  private cycleTarget(): void {
    if (this.enemies.length === 0) return;
    const at = this.enemies.findIndex((e) => e.id === this.targetId);
    this.targetId = this.enemies[(at + 1) % this.enemies.length]!.id;
  }

  private restart(now: number): void {
    this.reset(now);
    this.say("You square up again.");
  }

  // ---------------------------------------------------------------- helpers

  private at(actor: Actor): Point {
    return actor.pos;
  }

  private playerAt(): Point {
    return this.at(this.player);
  }

  private livingTarget(): Hound | null {
    return this.enemies.find((e) => e.id === this.targetId) ?? null;
  }

  private nextDamageNumberId = 0;

  private spawnDamageNumber(x: number, y: number, amount: number, color: string): void {
    this.damageNumbers.push({
      id: `dn-${this.nextDamageNumberId++}`,
      x, y, text: String(amount), color, age: 0,
    });
  }

  private say(line: string): void {
    this.log.push(line);
    if (this.log.length > LOG_LINES * 3) this.log.splice(0, this.log.length - LOG_LINES * 3);
  }

  private selectedCanAttack(now: number): boolean {
    if (now < this.nextAttackAt) return false;
    const target = this.livingTarget();
    if (!target) return false;
    const reach = canReach(this.playerAt(), this.at(target));
    return ACTIONS[this.activeSlot]?.kind === "melee" ? reach : !reach;
  }

  private hint(): string {
    switch (this.phase) {
      case "cleared":
        return "The pack is dead. Click anywhere to go again.";
      case "dead":
        return "Killed. Resurrect on the HUD, or press R.";
      default:
        break;
    }

    const target = this.livingTarget();
    if (!target) {
      return this.anyAwake()
        ? "Click a hellhound to mark it, or WASD to move."
        : "Nothing has noticed you yet. Mark one and throw, or walk closer.";
    }
    if (canReach(this.playerAt(), this.at(target))) {
      return "In reach — 1 for the sword, Space to swing.";
    }
    return "Out of reach — 2 for a dagger, Space to throw. Or move closer.";
  }

  private anyAwake(): boolean {
    return this.enemies.some((e) => e.aggro);
  }

  // --------------------------------------------------------------- snapshot

  snapshot(now: number = Date.now()): TacticsSnapshot {
    const inspected = this.corpses.find((c) => c.id === this.inspectingId) ?? null;
    const target = this.livingTarget();
    const dead = this.phase === "dead";

    const cooldown = this.cooldownStart === null || this.cooldownTotal <= 0
      ? null
      : {
          slot: this.cooldownSlot,
          remainingMs: Math.max(0, this.cooldownStart + this.cooldownTotal - now),
          totalMs: this.cooldownTotal,
        };

    return {
      player: {
        x: this.player.x,
        y: this.player.y,
        color: this.playerColor,
        name: this.playerName,
        room: { ...ARENA_ROOM },
        facing: this.player.facing,
      },
      stats: {
        level: 1,
        health: this.player.health,
        maxHealth: this.player.maxHealth,
        mana: PLAYER_MAX_MANA,
        maxMana: PLAYER_MAX_MANA,
      },
      enemies: this.enemies.map((e) => ({
        id: e.id,
        name: e.name,
        glyph: e.glyph,
        color: e.color,
        room: { ...ARENA_ROOM },
        x: e.x,
        y: e.y,
        health: e.health,
        maxHealth: e.maxHealth,
        chasing: e.aggro,
        aggro: e.aggro,
        facing: e.facing,
      })),
      corpses: this.corpses.map((c) => ({
        id: c.id,
        name: c.name,
        glyph: c.glyph,
        color: c.color,
        room: c.room,
        x: c.x,
        y: c.y,
        facing: c.facing,
      })),
      inspect: inspected
        ? {
            corpseId: inspected.id,
            title: corpseLabel(inspected),
            loot: inspected.loot.map((item) => ({ name: item.name })),
          }
        : null,
      projectiles: this.thrown ? [{ ...this.thrown.projectile }] : [],
      damageNumbers: this.damageNumbers.map((dn) => ({ ...dn })),
      targetId: this.targetId,
      attacking: target !== null,
      activeSlot: this.activeSlot,
      cooldown,
      selectedCanAttack: this.selectedCanAttack(now),
      moveTarget: this.moveTarget ? { ...this.moveTarget } : null,
      pathCells: [],
      gameElapsedMs: this.gameElapsedMs,
      killCount: this.killCount,
      dead,
      autoResurrect: this.autoRestart,
      resurrectInMs:
        dead && this.autoRestart
          ? Math.max(0, AUTO_RESTART_DELAY_MS - (now - this.deathAt))
          : null,
      tombstones: this.tombstones.map((t) => ({
        x: t.x,
        y: t.y,
        room: { ...ARENA_ROOM },
        gameElapsedMs: t.gameElapsedMs,
      })),

      // Kept for TacticsSnapshot compatibility.
      phase: this.phase,
      round: 0,
      moveRange: isOver(this.phase) ? 0 : MOVE_RANGE,
      moveFrom: this.playerAt(),
      meleeRange: MELEE_RANGE,
      aggro: this.anyAwake(),
      strikes: this.strikes.map((s) => ({ ...s })),
      log: this.log.slice(-LOG_LINES),
      hint: this.hint(),
      doorsClosed: [...this.doorsClosed],
    };
  }
}
