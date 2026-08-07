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
  type RoomCoord,
} from "../shared/constants.js";
import {
  MIN_X, MAX_X, MIN_Y, MAX_Y,
  clamp,
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
  ENEMY_ATTACK_INTERVAL,
  ENEMY_ATTACK_RANGE,
  ENEMY_DAMAGE,
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

/** How far a thrown dagger will reach (7 grid squares). */
const RANGED_RANGE = 7 * CELL_SIZE;

/** Melee hit cadence (ms). */
const MELEE_INTERVAL = 600;

/** Melee damage per hit. */
const MELEE_DAMAGE = 10;

/** Ranged (dagger) damage per hit. */
const RANGED_DAMAGE = 5;

/** Delay before the single hellhound is replaced after it dies (ms). */
const RESPAWN_DELAY_MS = 3000;

/** Floating damage number lifetime in seconds. */
const DAMAGE_NUMBER_LIFETIME = 1.0;

/** How fast damage numbers rise (px/s). */
const DAMAGE_NUMBER_SPEED = 50;

/** Delay before an auto-resurrect fires (ms), measured from the moment of death. */
const AUTO_RESURRECT_DELAY_MS = 3000;

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
  /**
   * Earliest time the next attack may land, of *any* kind. Each attack charges
   * its own interval against this one shared clock, so swapping weapons can't
   * beat the cadence of the swing you just made — a 2s attack owes its full 2s
   * even if you switch to a 1s one straight after.
   */
  private nextAttackAt = 0;
  killCount = 0;
  /** Real-ms deadline for replacing the hellhound, or null when one is alive. */
  private respawnAt: number | null = null;

  // Death
  dead = false;
  autoResurrect = false;
  /** Real-ms timestamp of death, for the auto-resurrect delay. */
  private deathAt = 0;
  /** Real ms left before an auto-resurrect, or null when none is pending. */
  resurrectInMs: number | null = null;
  tombstones: Array<{ x: number; y: number; room: RoomCoord; gameElapsedMs: number; visible: boolean }> = [];

  // Clock
  gameElapsedMs = 0;

  // Movement
  moveTarget: { x: number; y: number } | null = null;
  pathCells: Array<{ col: number; row: number }> = [];

  // Damage numbers
  readonly damageNumbers: DamageNumber[] = [];

  // Input
  private readonly heldKeys = new Set<string>();

  // Timing — last tick timestamp (real ms, e.g. Date.now())
  private lastTickTime = Date.now();

  constructor() {
    // Exactly one hellhound, from the first tick onward.
    this.spawnHellhound();
  }

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

  private spawnDamageNumber(x: number, y: number, amount: number, color = "#ffd633") {
    this.damageNumbers.push({
      x,
      y,
      text: String(amount),
      color,
      age: 0,
    });
  }

  // -------------------------------------------------------- combat update

  private updateCombat(now: number, dt: number) {
    if (this.dead) return;
    const target = this.combatTarget();

    // The target died or we walked out of its room — combat is off.
    if (this.attacking && !target) {
      this.pathCells = [];
      this.endCombat();
    }

    if (this.attacking && target) {
      const distance = Math.hypot(target.x - this.me.x, target.y - this.me.y);

      if (this.activeKind() === "melee") {
        // No pursuit: engaging never moves you. Closing the distance is the
        // player's job (WASD or a ground click); we only swing at what's in
        // reach, whether that's because you walked in or it walked into you.
        if (distance <= ATTACK_RANGE && now >= this.nextAttackAt) {
          target.health -= MELEE_DAMAGE;
          target.aggro = true;
          this.spawnDamageNumber(target.x, target.y, MELEE_DAMAGE);
          this.nextAttackAt = now + MELEE_INTERVAL;
        }
      } else if (distance <= RANGED_RANGE && now >= this.nextAttackAt) {
        // Throw from where you stand, never closing the gap. Out of range you
        // simply hold the target and wait for it to come.
        this.projectiles.push(spawnDagger({ x: this.me.x, y: this.me.y }, { x: target.x, y: target.y }));
        this.nextAttackAt = now + FIRE_INTERVAL_MS;
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

  // -------------------------------------------------------- spawning

  /** The one opponent. Enters at a random room edge and wanders from there. */
  private spawnHellhound() {
    this.enemies.push(spawnEnemy(`hellhound-${this.nextEnemyId++}`, this.me.room));
    this.respawnAt = null;
  }

  // -------------------------------------------------------- movement

  private applyMovement(dt: number) {
    if (this.dead) return;
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
        this.pathCells = []; // arrived
      } else {
        x1 = this.me.x + (toX / distance) * step;
        y1 = this.me.y + (toY / distance) * step;
      }
    }

    // Slide against solid wall cells in this room, then apply the move.
    // Player is clamped to the current room boundaries (no room transitions).
    const moved = resolveMove(this.dungeon.get(this.me.room), x0, y0, x1, y1, PLAYER_RADIUS);
    this.me.x = clamp(moved.x, MIN_X, MAX_X);
    this.me.y = clamp(moved.y, MIN_Y, MAX_Y);
  }

  // -------------------------------------------------------- input handling

  handleInput(msg: InputMessage): void {
    if (msg.type === "resurrect") {
      this.resurrect();
      return;
    }

    // Toggling auto-resurrect has to work while dead — that's when you want it.
    if (msg.type === "toggleAutoResurrect") {
      this.autoResurrect = !this.autoResurrect;
      return;
    }

    if (this.dead) return;

    switch (msg.type) {
      case "keydown": {
        const key = msg.key.toLowerCase();

        // Number keys 1-5 select the matching action-bar slot.
        if (key.length === 1 && key >= "1" && key <= "5") {
          const slot = Number(key) - 1;
          if (ACTIONS[slot]) this.activeSlot = slot;
          return;
        }

        if (!"wasd".includes(key) || key.length !== 1) return;
        // Steering does not drop the target — only a double-click does.
        this.heldKeys.add(key);
        this.moveTarget = null;
        this.pathCells = [];
        break;
      }

      case "keyup": {
        this.heldKeys.delete(msg.key.toLowerCase());
        break;
      }

      case "click": {
        const point = { x: msg.x, y: msg.y };

        // Click an enemy: select it, nothing more. Double-click starts the fight.
        const clicked = enemyAtPoint(this.enemies, this.me.room, point);
        if (clicked) {
          this.targetId = clicked.id;
          return;
        }

        // Click open ground: walk there, keeping whatever we're engaged with.
        const dest = { x: clamp(point.x, MIN_X, MAX_X), y: clamp(point.y, MIN_Y, MAX_Y) };
        this.moveTarget = dest;
        this.computePathCells(this.me.x, this.me.y, dest.x, dest.y);
        break;
      }

      // Double-click an enemy: engage it with the selected weapon, or drop it
      // if it's the one we're already fighting. This is the *only* way out of
      // combat — moving no longer breaks it.
      case "dblclick": {
        const clicked = enemyAtPoint(this.enemies, this.me.room, { x: msg.x, y: msg.y });
        if (!clicked) break;
        if (this.attacking && this.targetId === clicked.id) this.disengageCombat();
        else this.engageEnemy(clicked);
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

  /** Back on your feet at the centre of the room, tombstones now visible. */
  private resurrect() {
    if (!this.dead) return;
    this.dead = false;
    this.resurrectInMs = null;
    this.stats.health = this.stats.maxHealth;
    this.me.x = WORLD_WIDTH / 2;
    this.me.y = WORLD_HEIGHT / 2;
    for (const t of this.tombstones) t.visible = true;
  }

  /**
   * Start the fight. The weapon is whatever the player has selected — the
   * gesture picks the target, never the attack. `updateCombat` then applies
   * that weapon's range rules.
   *
   * Engaging never moves you and never cancels a walk you already ordered:
   * neither weapon pursues, so movement is entirely the player's business.
   */
  private engageEnemy(enemy: Enemy) {
    this.targetId = enemy.id;
    this.attacking = true;
    this.projectiles.length = 0;
    // Deliberately does NOT clear nextAttackAt: re-engaging would otherwise be
    // a way to refund a cooldown by double-clicking off and straight back on.
  }

  // -------------------------------------------------------- tick

  tick(realNow: number): void {
    // Clamped so a long gap doesn't teleport the player.
    const dt = Math.min((realNow - this.lastTickTime) / 1000, 0.1);
    this.lastTickTime = realNow;

    // Realtime: one clock for everything, and it never stops.
    const now = realNow;
    const step = dt;

    this.resurrectInMs = null;
    if (this.dead && this.autoResurrect) {
      const remaining = AUTO_RESURRECT_DELAY_MS - (now - this.deathAt);
      if (remaining <= 0) this.resurrect();
      else this.resurrectInMs = remaining;
    }

    // Advance in-game clock.
    this.gameElapsedMs += step * 1000;

    // Put the next hellhound in the room once its predecessor's timer is up.
    if (this.respawnAt !== null && now >= this.respawnAt) {
      this.spawnHellhound();
    }

    const layer = this.dungeon.get(this.me.room);
    const target = this.combatTarget();
    const inMelee = this.attacking && target !== undefined && this.activeKind() === "melee"
      && Math.hypot(target.x - this.me.x, target.y - this.me.y) <= ATTACK_RANGE;

    // Update enemy AI — the melee target freezes, all others keep moving.
    // When dead, feed a far-off position so enemies don't detect the player.
    const aiPlayerX = this.dead ? -1e5 : this.me.x;
    const aiPlayerY = this.dead ? -1e5 : this.me.y;
    for (const e of this.enemies) {
      if (!sameRoom(e.room, this.me.room)) continue;
      // Locked in melee: it holds position rather than closing, but it is very
      // much in the fight — `updateEnemy` is the only thing that sets
      // `chasing`, so keep it hostile here or it never swings back.
      if (inMelee && e.id === this.targetId) {
        e.chasing = !this.dead;
        continue;
      }
      updateEnemy(e, aiPlayerX, aiPlayerY, step, layer);
    }

    // Enemy attacks on the player.
    if (!this.dead) {
      for (const e of this.enemies) {
        if (!sameRoom(e.room, this.me.room)) continue;
        if (!e.chasing) continue;
        const dist = Math.hypot(e.x - this.me.x, e.y - this.me.y);
        if (dist <= ENEMY_ATTACK_RANGE && now - e.lastAttackAt >= ENEMY_ATTACK_INTERVAL) {
          this.stats.health -= ENEMY_DAMAGE;
          this.spawnDamageNumber(this.me.x, this.me.y, ENEMY_DAMAGE, "#ff4444");
          e.lastAttackAt = now;
        }
      }

      // Death check.
      if (this.stats.health <= 0) {
        this.stats.health = 0;
        this.dead = true;
        this.deathAt = realNow;
        this.tombstones.push({ x: this.me.x, y: this.me.y, room: { ...this.me.room }, gameElapsedMs: this.gameElapsedMs, visible: false });
        this.disengageCombat();
        this.moveTarget = null;
        this.heldKeys.clear();
        // Enemies lose interest in the dead player.
        for (const e of this.enemies) {
          e.aggro = false;
          e.chasing = false;
        }
      }
    }

    // Combat (melee hits, dagger firing/advancing).
    this.updateCombat(now, step);

    // Player movement.
    this.applyMovement(step);

    // Remove dead enemies, count kills, and queue the replacement.
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (this.enemies[i]!.health <= 0) {
        const dead = this.enemies[i]!;
        if (dead.id === this.targetId) {
          this.targetId = null;
          this.pathCells = [];
          this.endCombat();
        }
        this.enemies.splice(i, 1);
        this.killCount++;
        this.respawnAt = now + RESPAWN_DELAY_MS;
      }
    }

    this.updateDamageNumbers(dt);
  }

  /** Rise upward, age, remove expired. */
  private updateDamageNumbers(dt: number) {
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
      moveTarget: this.moveTarget ? { x: this.moveTarget.x, y: this.moveTarget.y } : null,
      pathCells: this.pathCells.map((c) => ({ col: c.col, row: c.row })),
      gameElapsedMs: this.gameElapsedMs,
      killCount: this.killCount,
      dead: this.dead,
      autoResurrect: this.autoResurrect,
      resurrectInMs: this.resurrectInMs,
      tombstones: this.tombstones.filter((t) => t.visible).map((t) => ({ x: t.x, y: t.y, room: t.room, gameElapsedMs: t.gameElapsedMs })),
    };
  }
}
