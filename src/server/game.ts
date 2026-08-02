/**
 * Server-side game simulation. Owns all mutable state and runs the game loop
 * independently of any connected client. The client is a thin render layer.
 */

import {
  CELL_SIZE,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  START_ROOM,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  sameRoom,
  type PlayerState,
} from "../shared/constants.js";
import {
  MIN_X, MAX_X, MIN_Y, MAX_Y,
  clamp,
  crossEdges,
  doorwayTarget,
  exitAtPoint,
  type Point,
} from "../shared/movement.js";
import { ACTIONS } from "../shared/actions.js";
import {
  FIRE_INTERVAL_MS,
  advanceDagger,
  daggerDone,
  spawnDagger,
  type Projectile,
} from "../shared/combat.js";
import {
  enemyAtPoint,
  spawnEnemy,
  updateEnemy,
  type Enemy,
} from "../shared/enemies.js";
import {
  Dungeon,
  segmentHitsWall,
  resolveMove,
  worldToCell,
} from "../shared/tilemap.js";
import type { GameSnapshot, InputMessage } from "../shared/protocol.js";

// ------------------------------------------------------------------ constants

/** Stop click-to-move once this close to the target (px). */
const ARRIVAL_EPSILON = 1.5;

/** How close a melee attacker walks before stopping to strike. */
const ATTACK_RANGE = 44;

/** Auto-combat only engages enemies within this distance (7 grid squares). */
const AUTO_ENGAGE_RANGE = 7 * CELL_SIZE;

/** Melee hit cadence in autoplay (ms). */
const MELEE_INTERVAL = 600;

/** Melee damage per hit. */
const MELEE_DAMAGE = 10;

/** Ranged (dagger) damage per hit. */
const RANGED_DAMAGE = 5;

/** Spawn a wave of enemies every this many ms. */
const SPAWN_INTERVAL = 3000;

/** Floating damage number lifetime in seconds. */
const DAMAGE_NUMBER_LIFETIME = 1.0;

/** How fast damage numbers rise (px/s). */
const DAMAGE_NUMBER_SPEED = 50;

/** One in-game minute = this many real ms. */
const MS_PER_GAME_MINUTE = 500;

const MAX_ENEMIES = 7;

const KILLS_PER_COOLDOWN = 50;
/** 1 game hour in real ms (60 game minutes x MS_PER_GAME_MINUTE). */
const COOLDOWN_MS = 60 * MS_PER_GAME_MINUTE;

// ------------------------------------------------------------------ types

interface DamageNumber {
  x: number;
  y: number;
  text: string;
  color: string;
  age: number;
}

// ------------------------------------------------------------------ helpers

const FIRST_NAMES = ["Bran", "Kael", "Mira", "Oswin", "Tamsin", "Vek", "Yara", "Dorn", "Isolde", "Rook"];
const LAST_NAMES = ["the Bold", "Ashfoot", "Quickblade", "of Thornvale", "Emberhand", "Greycloak", "the Lost"];

const pick = <T,>(values: readonly T[]): T => values[Math.floor(Math.random() * values.length)]!;

// ------------------------------------------------------------------ simulation

export class GameSimulation {
  // Player
  readonly me: PlayerState = {
    x: WORLD_WIDTH / 2,
    y: WORLD_HEIGHT / 2,
    color: `hsl(${Math.floor(Math.random() * 360)} 85% 65%)`,
    name: `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
    room: { ...START_ROOM },
  };

  readonly stats = {
    level: 1,
    health: 100,
    maxHealth: 100,
    mana: 100,
    maxMana: 100,
  };

  // Dungeon
  readonly dungeon = new Dungeon();

  // Enemies & combat
  readonly enemies: Enemy[] = [];
  private nextEnemyId = 1;
  targetId: string | null = null;
  attacking = false;
  activeSlot = 0;
  readonly projectiles: Projectile[] = [];
  private lastFireAt = 0;
  private lastMeleeAt = 0;
  private lastSpawnAt = 0;
  killCount = 0;
  cooldownUntil = 0;

  // Clock
  gameElapsedMs = 0;

  // Movement
  moveTarget: { x: number; y: number } | null = null;

  // Autoplay
  autoMode = true;
  private manualMoveTarget: Point | null = null;
  private manualTarget = false;
  pathCells: Array<{ col: number; row: number }> = [];

  // Damage numbers
  readonly damageNumbers: DamageNumber[] = [];

  // Input
  private readonly heldKeys = new Set<string>();

  // Timing — last tick timestamp (real ms, e.g. Date.now())
  private lastTickTime = Date.now();

  // -------------------------------------------------------- helpers

  private activeKind() {
    return ACTIONS[this.activeSlot]?.kind ?? "melee";
  }

  private combatTarget(): Enemy | undefined {
    if (!this.targetId) return undefined;
    return this.enemies.find((e) => e.id === this.targetId && sameRoom(e.room, this.me.room));
  }

  private endCombat() {
    this.attacking = false;
    this.projectiles.length = 0;
  }

  private disengageCombat() {
    this.targetId = null;
    this.manualTarget = false;
    this.endCombat();
  }

  private computePathCells(fromX: number, fromY: number, toX: number, toY: number) {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const dist = Math.hypot(dx, dy);
    const steps = Math.ceil(dist / CELL_SIZE);
    const visited = new Set<number>();
    this.pathCells = [];
    for (let i = 0; i <= steps; i++) {
      const t = steps > 0 ? i / steps : 0;
      const { col, row } = worldToCell(fromX + dx * t, fromY + dy * t);
      const key = row * 1000 + col;
      if (!visited.has(key)) {
        visited.add(key);
        this.pathCells.push({ col, row });
      }
    }
  }

  private spawnDamageNumber(x: number, y: number, amount: number) {
    this.damageNumbers.push({
      x,
      y,
      text: String(amount),
      color: "#ffd633",
      age: 0,
    });
  }

  // -------------------------------------------------------- combat update

  private updateCombat(now: number, dt: number) {
    const target = this.combatTarget();

    // The target died or we walked out of its room — combat is off.
    if (this.attacking && !target) {
      this.manualTarget = false;
      this.pathCells = [];
      this.endCombat();
    }

    if (this.attacking && target) {
      const dx = target.x - this.me.x;
      const dy = target.y - this.me.y;
      const distance = Math.hypot(dx, dy) || 1;

      if (this.activeKind() === "melee") {
        // Walk to just within striking range, then hold.
        this.moveTarget =
          distance > ATTACK_RANGE
            ? { x: target.x - (dx / distance) * ATTACK_RANGE, y: target.y - (dy / distance) * ATTACK_RANGE }
            : null;

        // Melee damage on interval when in range.
        if (distance <= ATTACK_RANGE && now - this.lastMeleeAt >= MELEE_INTERVAL) {
          target.health -= MELEE_DAMAGE;
          target.aggro = true;
          this.spawnDamageNumber(target.x, target.y, MELEE_DAMAGE);
          this.lastMeleeAt = now;
        }
      } else if (now - this.lastFireAt >= FIRE_INTERVAL_MS) {
        // Ranged: loose a dagger at the enemy on a fixed cadence.
        this.projectiles.push(spawnDagger({ x: this.me.x, y: this.me.y }, { x: target.x, y: target.y }));
        this.lastFireAt = now;
      }
    }

    // Advance daggers; retire any that reach the enemy, hit a wall, or leave the room.
    const goal = target ? { x: target.x, y: target.y } : { x: -1e4, y: -1e4 };
    const layer = this.dungeon.get(this.me.room);
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i]!;
      const px = p.x;
      const py = p.y;
      advanceDagger(p, dt);

      const hitWall = segmentHitsWall(layer, px, py, p.x, p.y);
      const reached = daggerDone(p, goal);

      if (hitWall || reached) {
        // Deal ranged damage when a dagger reaches the target (not when it hits a wall).
        if (reached && !hitWall && target) {
          target.health -= RANGED_DAMAGE;
          target.aggro = true;
          this.spawnDamageNumber(target.x, target.y, RANGED_DAMAGE);
        }
        this.projectiles.splice(i, 1);
      }
    }
  }

  // -------------------------------------------------------- autoplay update

  private updateAutoplay(now: number) {
    // Don't override player-chosen targets or manual movement.
    if (this.manualTarget || this.manualMoveTarget) return;

    // Find closest enemy in the current room within engage range.
    let closest: Enemy | null = null;
    let closestDist = Infinity;

    for (const e of this.enemies) {
      if (!sameRoom(e.room, this.me.room)) continue;
      const d = Math.hypot(e.x - this.me.x, e.y - this.me.y);
      if (d < closestDist && d <= AUTO_ENGAGE_RANGE) {
        closest = e;
        closestDist = d;
      }
    }

    if (!closest) {
      // Nothing in range — idle.
      if (this.attacking) this.endCombat();
      this.targetId = null;
      this.moveTarget = null;
      return;
    }

    this.targetId = closest.id;
    this.attacking = true;

    if (closestDist <= ATTACK_RANGE) {
      // In melee range — use sword.
      this.activeSlot = 0;
    } else {
      // Out of melee range — use daggers.
      this.activeSlot = 1;
    }

    // Walk toward closest enemy so melee can connect.
    const dx = closest.x - this.me.x;
    const dy = closest.y - this.me.y;
    const dist = Math.hypot(dx, dy) || 1;
    this.moveTarget =
      closestDist > ATTACK_RANGE
        ? { x: closest.x - (dx / dist) * ATTACK_RANGE, y: closest.y - (dy / dist) * ATTACK_RANGE }
        : null;
  }

  // -------------------------------------------------------- spawning

  private spawnWave() {
    if (this.enemies.length >= MAX_ENEMIES) return;
    const count = Math.min(1 + Math.floor(Math.random() * 2), MAX_ENEMIES - this.enemies.length);
    for (let i = 0; i < count; i++) {
      this.enemies.push(spawnEnemy(`hellhound-${this.nextEnemyId++}`, this.me.room));
    }
  }

  // -------------------------------------------------------- movement

  private applyMovement(dt: number) {
    const x0 = this.me.x;
    const y0 = this.me.y;
    let x1 = this.me.x;
    let y1 = this.me.y;

    let dx = 0;
    let dy = 0;

    if (this.heldKeys.has("w")) dy -= 1;
    if (this.heldKeys.has("s")) dy += 1;
    if (this.heldKeys.has("a")) dx -= 1;
    if (this.heldKeys.has("d")) dx += 1;

    if (dx !== 0 || dy !== 0) {
      // Normalise so diagonals aren't faster than the cardinal directions.
      const length = Math.hypot(dx, dy);
      x1 = this.me.x + (dx / length) * PLAYER_SPEED * dt;
      y1 = this.me.y + (dy / length) * PLAYER_SPEED * dt;
    } else if (this.moveTarget) {
      const toX = this.moveTarget.x - this.me.x;
      const toY = this.moveTarget.y - this.me.y;
      const distance = Math.hypot(toX, toY);
      const step = PLAYER_SPEED * dt;

      if (distance <= Math.max(step, ARRIVAL_EPSILON)) {
        x1 = this.moveTarget.x;
        y1 = this.moveTarget.y;
        this.moveTarget = null;
        this.manualMoveTarget = null;
        this.pathCells = []; // arrived — auto-combat can resume
      } else {
        x1 = this.me.x + (toX / distance) * step;
        y1 = this.me.y + (toY / distance) * step;
      }
    }

    // Slide against solid wall cells in this room, then apply the move.
    const moved = resolveMove(this.dungeon.get(this.me.room), x0, y0, x1, y1, PLAYER_RADIUS);
    this.me.x = moved.x;
    this.me.y = moved.y;

    // Running past an open edge steps into the next room; a closed edge is a wall.
    const crossed = crossEdges(this.me.room, this.me.x, this.me.y);
    this.me.room = crossed.room;
    this.me.x = crossed.x;
    this.me.y = crossed.y;

    // The old destination was in the room you just left.
    if (crossed.exited) {
      this.moveTarget = null;
      this.manualMoveTarget = null;
      this.pathCells = [];
    }
  }

  // -------------------------------------------------------- input handling

  handleInput(msg: InputMessage): void {
    switch (msg.type) {
      case "keydown": {
        const key = msg.key.toLowerCase();

        // Space toggles auto-movement.
        if (msg.code === "Space") {
          this.autoMode = !this.autoMode;
          if (!this.autoMode) {
            this.disengageCombat();
            this.moveTarget = null;
          }
          return;
        }

        // Number keys 1-5 select the matching action-bar slot.
        if (key.length === 1 && key >= "1" && key <= "5") {
          const slot = Number(key) - 1;
          if (ACTIONS[slot]) this.activeSlot = slot;
          return;
        }

        if (!"wasd".includes(key) || key.length !== 1) return;
        this.heldKeys.add(key);
        this.moveTarget = null;
        this.manualMoveTarget = null;
        this.pathCells = [];
        this.disengageCombat();
        break;
      }

      case "keyup": {
        this.heldKeys.delete(msg.key.toLowerCase());
        break;
      }

      case "click": {
        const point = { x: msg.x, y: msg.y };

        // Left-click on an enemy: engage in melee combat.
        const clicked = enemyAtPoint(this.enemies, this.me.room, point);
        if (clicked) {
          this.engageEnemy(clicked, "melee");
          return;
        }

        // Left-click on ground: disengage, walk there.
        this.disengageCombat();
        this.manualTarget = false;
        const exit = exitAtPoint(this.me.room, point);
        const dest = exit
          ? doorwayTarget(exit, point)
          : { x: clamp(point.x, MIN_X, MAX_X), y: clamp(point.y, MIN_Y, MAX_Y) };
        this.moveTarget = dest;
        this.manualMoveTarget = dest;
        this.computePathCells(this.me.x, this.me.y, dest.x, dest.y);
        break;
      }

      case "rightclick": {
        const point = { x: msg.x, y: msg.y };
        const clicked = enemyAtPoint(this.enemies, this.me.room, point);
        if (clicked) {
          this.engageEnemy(clicked, "ranged");
        }
        break;
      }

      case "slot": {
        if (ACTIONS[msg.index]) {
          this.activeSlot = msg.index;
        }
        break;
      }
    }
  }

  private engageEnemy(enemy: Enemy, kind: "melee" | "ranged") {
    this.manualTarget = true;
    this.manualMoveTarget = null;
    this.pathCells = [];
    this.targetId = enemy.id;
    this.attacking = true;
    this.activeSlot = kind === "melee" ? 0 : 1;
    this.projectiles.length = 0;
    this.lastFireAt = 0;
    this.lastMeleeAt = 0;

    // Show path to enemy's current position.
    this.computePathCells(this.me.x, this.me.y, enemy.x, enemy.y);
  }

  // -------------------------------------------------------- tick

  tick(now: number): void {
    // Clamped so a long gap doesn't teleport the player.
    const dt = Math.min((now - this.lastTickTime) / 1000, 0.1);
    this.lastTickTime = now;

    // Advance in-game clock.
    this.gameElapsedMs += dt * 1000;

    // Spawn enemies on interval, unless on cooldown.
    if (now >= this.cooldownUntil && now - this.lastSpawnAt >= SPAWN_INTERVAL) {
      this.spawnWave();
      this.lastSpawnAt = now;
    }

    const layer = this.dungeon.get(this.me.room);
    const target = this.combatTarget();
    const inMelee = this.attacking && target !== undefined && this.activeKind() === "melee"
      && Math.hypot(target.x - this.me.x, target.y - this.me.y) <= ATTACK_RANGE;

    // Update enemy AI — the melee target freezes, all others keep moving.
    for (const e of this.enemies) {
      if (!sameRoom(e.room, this.me.room)) continue;
      if (inMelee && e.id === this.targetId) continue; // locked in melee
      updateEnemy(e, this.me.x, this.me.y, dt, layer);
    }

    // Auto-targeting and weapon selection only when autoMode is on.
    if (this.autoMode) {
      this.updateAutoplay(now);
    }

    // Combat (melee hits, dagger firing/advancing).
    this.updateCombat(now, dt);

    // Player movement.
    this.applyMovement(dt);

    // Remove dead enemies and count kills.
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (this.enemies[i]!.health <= 0) {
        const dead = this.enemies[i]!;
        if (dead.id === this.targetId) {
          this.targetId = null;
          this.manualTarget = false;
          this.pathCells = [];
          this.endCombat();
        }
        this.enemies.splice(i, 1);
        this.killCount++;
        if (this.killCount >= KILLS_PER_COOLDOWN) {
          this.killCount = 0;
          this.cooldownUntil = now + COOLDOWN_MS;
        }
      }
    }

    // Update damage numbers (rise upward, age, remove expired).
    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      const dn = this.damageNumbers[i]!;
      dn.y -= DAMAGE_NUMBER_SPEED * dt;
      dn.age += dt;
      if (dn.age >= DAMAGE_NUMBER_LIFETIME) {
        this.damageNumbers.splice(i, 1);
      }
    }
  }

  // -------------------------------------------------------- snapshot

  snapshot(): GameSnapshot {
    return {
      player: {
        x: this.me.x,
        y: this.me.y,
        color: this.me.color,
        name: this.me.name,
        room: this.me.room,
      },
      stats: { ...this.stats },
      enemies: this.enemies.map((e) => ({
        id: e.id,
        name: e.name,
        glyph: e.glyph,
        color: e.color,
        room: e.room,
        x: e.x,
        y: e.y,
        health: e.health,
        maxHealth: e.maxHealth,
        chasing: e.chasing,
        aggro: e.aggro,
      })),
      projectiles: this.projectiles.map((p) => ({
        x: p.x,
        y: p.y,
        vx: p.vx,
        vy: p.vy,
      })),
      damageNumbers: this.damageNumbers.map((dn) => ({
        x: dn.x,
        y: dn.y,
        text: dn.text,
        color: dn.color,
        age: dn.age,
      })),
      targetId: this.targetId,
      attacking: this.attacking,
      activeSlot: this.activeSlot,
      autoMode: this.autoMode,
      moveTarget: this.moveTarget ? { x: this.moveTarget.x, y: this.moveTarget.y } : null,
      pathCells: this.pathCells.map((c) => ({ col: c.col, row: c.row })),
      gameElapsedMs: this.gameElapsedMs,
      killCount: this.killCount,
      cooldownUntil: this.cooldownUntil,
    };
  }
}
