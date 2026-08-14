/**
 * The turn-based simulation. Same shape of thing as `src/server/game.ts` — it
 * owns every piece of mutable state, runs whether or not a client is attached,
 * and hands out snapshots — but the rules are a board game rather than a
 * real-time one.
 *
 * **Real time only animates; it never decides.** A turn is committed the instant
 * the player asks for it, and `busyUntil` then holds the board still for as long
 * as the step or the swing takes to play out. Nothing that happens during that
 * window can change the outcome, so the clock is free to be a clock: it slides
 * models between squares and paces the pack's turns so you can see them coming.
 *
 * The one place that costs something is death and escape, which are resolved
 * *after* the animation rather than at the moment the number changed — a
 * hellhound dies at the end of the blow that killed it, not at the start.
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
  ATTACK_MS,
  AUTO_RESTART_DELAY_MS,
  ENEMY_ACTION_MS,
  ESCAPE_CELL,
  ESCAPE_RADIUS,
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
  STEP_MS,
  THROW_RECOVER_MS,
  TURN_GAP_MS,
  approachPoints,
  canReach,
  cellAtPoint,
  cellCenter,
  clampToGrid,
  distance,
  facingToward,
  inGrid,
  isOver,
  sameCell,
  stepToward,
  withinAggro,
  withinMove,
  type Cell,
  type Phase,
  type TacticsInput,
  type TacticsSnapshot,
} from "../shared/tactics.js";

// ------------------------------------------------------------------ constants

const DAMAGE_COLOR_DEALT = "#ffd633";
const DAMAGE_COLOR_TAKEN = "#ff6b6b";

/** Bodies are permanent, but there are only ever two of them. */
const MAX_CORPSES = 8;

const FIRST_NAMES = ["Bran", "Kael", "Mira", "Oswin", "Tamsin", "Vek", "Yara", "Dorn", "Isolde", "Rook"];
const LAST_NAMES = ["the Bold", "Ashfoot", "Quickblade", "of Thornvale", "Emberhand", "Greycloak", "the Lost"];

const pick = <T,>(values: readonly T[]): T => values[Math.floor(Math.random() * values.length)]!;

// ------------------------------------------------------------------ types

/**
 * A slide between two squares. The *cell* is updated the moment the move is
 * committed; this only carries the model from one square's centre to the next,
 * so what you see is always catching up to what has already been decided.
 */
interface Slide {
  from: Point;
  to: Point;
  startAt: number;
  endAt: number;
}

interface Actor {
  id: string;
  name: string;
  cell: Cell;
  /** Room pixels — where the model actually is, mid-slide. */
  x: number;
  y: number;
  facing: 1 | -1;
  health: number;
  maxHealth: number;
  slide: Slide | null;
}

interface Hound extends Actor {
  glyph: string;
  color: string;
  /**
   * Awake and hunting *you*, individually. A hound wakes when you come within a
   * square of it or when a dagger finds it, and never settles again. Until then
   * it doesn't take turns at all — it stands where it started and watches.
   */
  aggro: boolean;
}

interface DamageNumber {
  /** Stable across snapshots, so the client can pair one up to interpolate it. */
  id: string;
  x: number;
  y: number;
  text: string;
  color: string;
  age: number;
}

/** A dagger in flight, with the blow it is carrying. */
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
  private round!: number;

  /** No new turn may begin before this — the window an animation plays in. */
  private busyUntil!: number;
  /** Hellhound ids still owed a turn this round. */
  private queue!: string[];

  private targetId!: string | null;
  private activeSlot = 0;
  private log!: string[];

  private thrown!: Thrown | null;
  private damageNumbers!: DamageNumber[];
  private tombstones!: Array<{ x: number; y: number; gameElapsedMs: number }>;
  private inspectingId!: string | null;

  /**
   * The last blow a hellhound landed, for the client's lunge. The counter is
   * *not* reset between encounters: a client that saw seq 5 and then sees a
   * fresh 1 would replay a bite that never happened.
   */
  private strike!: { enemyId: string; seq: number } | null;
  private strikeSeq = 0;

  /** Set when the player steps onto the arch; resolved once the step finishes. */
  private pendingEscape!: boolean;
  private deathAt!: number;
  private killCount!: number;
  private nextEnemySeq = 0;

  /**
   * The action-bar blind, repurposed. There is no cooldown in a turn-based game
   * — the square darkens when you attack and refills as your turn comes back
   * round, which is the same information the sweep always carried: *not yet*.
   */
  private cooldownSlot = 0;
  private cooldownStart: number | null = null;
  private cooldownTotal = 0;

  /** Reuses the HUD's Auto-Res toggle: restart the encounter after a death. */
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
      ...cellCenter(PLAYER_START),
      // Facing the pack across the board — as they are facing you.
      facing: 1,
      health: PLAYER_MAX_HEALTH,
      maxHealth: PLAYER_MAX_HEALTH,
      slide: null,
    };

    this.enemies = HOUND_STARTS.map((cell) => ({
      id: `hound-${this.nextEnemySeq++}`,
      ...HELLHOUND,
      cell: { ...cell },
      ...cellCenter(cell),
      facing: -1,
      health: HOUND_MAX_HEALTH,
      maxHealth: HOUND_MAX_HEALTH,
      slide: null,
      aggro: false,
    }));

    this.corpses = [];
    this.phase = "player";
    this.round = 1;
    this.busyUntil = 0;
    this.queue = [];
    this.targetId = null;
    this.thrown = null;
    this.damageNumbers = [];
    this.tombstones = [];
    this.inspectingId = null;
    this.strike = null;
    this.pendingEscape = false;
    this.deathAt = 0;
    this.killCount = 0;
    this.cooldownStart = null;
    this.log = ["Two hellhounds watch you from across the vault."];
    this.lastTick = now;
  }

  // ------------------------------------------------------------------- tick

  tick(now: number): void {
    const dt = Math.min((now - this.lastTick) / 1000, 0.1);
    this.lastTick = now;
    this.gameElapsedMs += dt * 1000;

    this.advanceSlides(now);
    this.advanceThrown(dt);
    this.updateDamageNumbers(dt);
    this.wakeAdjacent();
    this.faceThePlayer();

    if (this.phase === "dead" && this.autoRestart && now - this.deathAt >= AUTO_RESTART_DELAY_MS) {
      this.restart(now);
      return;
    }

    // Everything below is turn machinery, and a finished encounter has no turns.
    if (isOver(this.phase)) return;
    if (now < this.busyUntil) return;

    this.retireDead();

    if (this.pendingEscape) {
      this.pendingEscape = false;
      this.finish("escaped", "You slip through the arch. The howling falls behind you.");
      return;
    }
    if (this.player.health <= 0) {
      this.tombstones.push({ x: this.player.x, y: this.player.y, gameElapsedMs: this.gameElapsedMs });
      this.deathAt = now;
      this.finish("dead", "The pack pulls you down.");
      return;
    }
    if (this.enemies.length === 0) {
      this.finish("cleared", "Both hounds are down. The vault is quiet.");
      return;
    }

    if (this.phase !== "enemy") return;

    const next = this.queue.shift();
    if (next === undefined) {
      this.beginPlayerTurn();
      return;
    }
    this.takeEnemyTurn(next, now);
  }

  /** Carry every mid-move model from one square's centre toward the next. */
  private advanceSlides(now: number): void {
    for (const actor of [this.player, ...this.enemies]) {
      const slide = actor.slide;
      if (!slide) continue;
      const span = slide.endAt - slide.startAt;
      const t = span > 0 ? Math.min(1, Math.max(0, (now - slide.startAt) / span)) : 1;
      actor.x = slide.from.x + (slide.to.x - slide.from.x) * t;
      actor.y = slide.from.y + (slide.to.y - slide.from.y) * t;
      if (t >= 1) actor.slide = null;
    }
  }

  /**
   * Anything you are standing next to notices you. Run every tick rather than
   * at the end of a move, so it is true of *any* way the gap closed — your step
   * toward it, or its step toward you.
   */
  private wakeAdjacent(): void {
    const player = this.playerAt();
    for (const enemy of this.enemies) {
      if (enemy.aggro) continue;
      if (withinAggro(this.at(enemy), player)) this.wake(enemy);
    }
  }

  /**
   * A hound that is hunting you looks at you. Only while it is standing still:
   * mid-step it faces the way it is travelling, or a hound crossing the board
   * would strafe sideways with its head turned.
   */
  private faceThePlayer(): void {
    for (const enemy of this.enemies) {
      if (!enemy.aggro || enemy.slide) continue;
      enemy.facing = facingToward(this.at(enemy), this.playerAt(), enemy.facing);
    }
  }

  private advanceThrown(dt: number): void {
    const thrown = this.thrown;
    if (!thrown) return;

    advanceDagger(thrown.projectile, dt);
    if (!daggerDone(thrown.projectile, thrown.target)) return;

    this.thrown = null;
    const enemy = this.enemies.find((e) => e.id === thrown.enemyId);
    if (!enemy) return; // it died to something else mid-flight
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

  /** Move anything at zero health onto the floor as a body. */
  private retireDead(): void {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i]!;
      if (enemy.health > 0) continue;

      // As in the real-time game, dying clears the target: a kill leaves you
      // holding nothing, and the body has to be clicked afresh.
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
      this.queue = this.queue.filter((id) => id !== enemy.id);
      this.killCount++;
      this.say(`The ${enemy.name.toLowerCase()} falls.`);
    }
  }

  private finish(phase: Phase, line: string): void {
    this.phase = phase;
    this.queue = [];
    this.cooldownStart = null;
    this.inspectingId = null;
    this.say(line);
  }

  // ------------------------------------------------------------ enemy turns

  private takeEnemyTurn(id: string, now: number): void {
    const enemy = this.enemies.find((e) => e.id === id);
    if (!enemy) return; // killed before its turn came round

    if (canReach(this.at(enemy), this.playerAt())) {
      enemy.facing = facingToward(this.at(enemy), this.playerAt(), enemy.facing);
      // Name the striker outright. Every hound that bites this round gets its
      // own lunge because the client is told which one, not left to work it out.
      this.strike = { enemyId: enemy.id, seq: ++this.strikeSeq };
      this.player.health = Math.max(0, this.player.health - HOUND_DAMAGE);
      this.spawnDamageNumber(this.player.x, this.player.y, HOUND_DAMAGE, DAMAGE_COLOR_TAKEN);
      // A panel parked over the middle of the board hides the thing biting you.
      this.inspectingId = null;
      this.say(`The ${enemy.name.toLowerCase()} tears into you for ${HOUND_DAMAGE}.`);
      this.busyUntil = now + ATTACK_MS + TURN_GAP_MS;
      return;
    }

    const destination = this.chooseHoundDestination(enemy);
    if (!destination) {
      this.say(`The ${enemy.name.toLowerCase()} circles, hemmed in.`);
      this.busyUntil = now + TURN_GAP_MS;
      return;
    }

    enemy.facing = facingToward(this.at(enemy), cellCenter(destination), enemy.facing);
    const travel = this.walkTo(enemy, destination, now);
    this.say(`The ${enemy.name.toLowerCase()} closes.`);
    this.busyUntil = now + travel + TURN_GAP_MS;
  }

  /**
   * Where a hellhound walks. It aims for a spot it could *bite* from — one of
   * the ring of points around the player that its own reach rule allows, which
   * is why the pack comes at you from the sides rather than from directly above
   * or below — and covers as much of the way there as a turn allows.
   *
   * Picking the approach point nearest to *itself* is what makes two hounds
   * flank instead of queueing: whichever side each is already on is the side it
   * commits to, and the separation check keeps the second one off the first
   * one's spot.
   *
   * Returns null when it is already as close as it can usefully get.
   */
  private chooseHoundDestination(enemy: Hound): Cell | null {
    const from = this.at(enemy);
    const player = this.playerAt();

    const spots = approachPoints(player)
      .filter((spot) => this.isClear(spot, enemy.id))
      .sort((a, b) => distance(from, a) - distance(from, b));

    const goal = spots[0];
    if (!goal) return null;

    // As far along as this turn allows, then snapped to the nearest cell that
    // isn't inside someone. Walking *through* another body is fine — nothing
    // but the walls has ever collided in this game — but stopping in one isn't.
    const wanted = stepToward(from, goal, MOVE_RANGE);
    const landing = this.nearestClearCell(wanted, enemy.id);
    if (!landing) return null;
    return sameCell(landing, enemy.cell) ? null : landing;
  }

  /** Nothing living is standing here. Bodies never blocked anything. */
  private isClear(point: Point, ignoreId?: string): boolean {
    if (this.player.id !== ignoreId && distance(point, this.playerAt()) < MIN_SEPARATION) return false;
    return !this.enemies.some(
      (e) => e.id !== ignoreId && distance(point, this.at(e)) < MIN_SEPARATION,
    );
  }

  /**
   * The closest cell to a point that nobody is standing in, searched outward.
   * A fine grid means the fallback is usually half a pace away, so being nudged
   * off an occupied spot is not something the player can feel.
   */
  private nearestClearCell(point: Point, ignoreId?: string): Cell | null {
    const start = clampToGrid(point);
    for (let radius = 0; radius <= 6; radius++) {
      let best: Cell | null = null;
      let bestGap = Infinity;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== radius) continue;
          const cell = { col: start.col + dc, row: start.row + dr };
          if (!inGrid(cell)) continue;
          if (!this.isClear(cellCenter(cell), ignoreId)) continue;
          const gap = distance(point, cellCenter(cell));
          if (gap < bestGap) { bestGap = gap; best = cell; }
        }
      }
      if (best) return best;
    }
    return null;
  }

  // ----------------------------------------------------------- player turns

  private beginPlayerTurn(): void {
    this.phase = "player";
    this.round++;
    this.cooldownStart = null;
  }

  /**
   * Hand the board over. The queue is fixed here rather than walked live, so a
   * hound that dies mid-round simply drops out of it — and a hound that has not
   * woken never joins it, which is how an unaggroed pack stands and watches.
   *
   * `blindSlot` is the action-bar square to darken, and is null for a step or a
   * pass. That isn't cosmetic restraint: the 3D client derives the player's
   * swing from a *fresh cooldown*, so darkening a square for a move would swing
   * the sword at nothing.
   */
  private endPlayerTurn(now: number, actionMs: number, blindSlot: number | null): void {
    // Only the woken take turns, so a hound you have not disturbed simply isn't
    // in the round at all.
    this.wakeAdjacent();
    this.queue = this.enemies.filter((e) => e.aggro).map((e) => e.id);
    this.phase = "enemy";

    if (blindSlot === null) {
      this.cooldownStart = null;
      return;
    }

    // The blind's length is known exactly: this action, then one turn each for
    // whoever is in the queue.
    this.cooldownSlot = blindSlot;
    this.cooldownStart = now;
    this.cooldownTotal = actionMs + this.queue.length * (ENEMY_ACTION_MS + TURN_GAP_MS);
  }

  private canAct(now: number): boolean {
    return this.phase === "player" && now >= this.busyUntil;
  }

  /**
   * Whether the player may walk to a cell: on the board, inside this turn's
   * allowance, and not inside somebody. With no grid drawn, the disc the client
   * paints is this predicate made visible, so the two must agree exactly — which
   * is why the radius lives in `shared/` and both sides read it.
   */
  private canWalkTo(cell: Cell, now: number): boolean {
    if (!this.canAct(now)) return false;
    if (!inGrid(cell)) return false;
    const to = cellCenter(cell);
    if (!withinMove(this.playerAt(), to)) return false;
    return this.isClear(to, this.player.id);
  }

  private move(cell: Cell, now: number): void {
    this.player.facing = facingToward(this.playerAt(), cellCenter(cell), this.player.facing);
    const travel = this.walkTo(this.player, cell, now);

    if (distance(cellCenter(cell), cellCenter(ESCAPE_CELL)) <= ESCAPE_RADIUS) {
      // No turn is handed over: you are through the arch before they can answer.
      this.pendingEscape = true;
      this.busyUntil = now + travel;
      this.say("You break for the arch.");
      return;
    }

    this.busyUntil = now + travel + TURN_GAP_MS;
    this.endPlayerTurn(now, travel + TURN_GAP_MS, null);
  }

  private wait(now: number): void {
    this.say("You hold your ground.");
    this.busyUntil = now + TURN_GAP_MS;
    this.endPlayerTurn(now, TURN_GAP_MS, null);
  }

  /**
   * Put a weapon in your hand. That is *all* it does — choosing an attack and
   * making one are two separate acts here, so the number keys and the bar's
   * squares can be pressed freely at any point in a turn without spending it.
   */
  private selectSlot(index: number): void {
    if (!ACTIONS[index]) return;
    this.activeSlot = index;
  }

  /**
   * Swing the selected weapon at the mark. **This always spends the turn** —
   * with nothing marked, or with the wrong weapon in hand for the distance, you
   * swing at air and the pack still gets to answer. Committing to an attack is
   * the decision; whether it lands is the consequence.
   */
  private attack(now: number): void {
    if (!this.canAct(now)) return;

    const action = ACTIONS[this.activeSlot];
    const target = this.livingTarget();
    const reach = target ? canReach(this.playerAt(), this.at(target)) : false;
    if (target) this.player.facing = facingToward(this.playerAt(), this.at(target), this.player.facing);

    const spend = (actionMs: number) => {
      this.busyUntil = now + actionMs;
      this.endPlayerTurn(now, actionMs, this.activeSlot);
    };

    if (!action || !target) {
      this.say(target ? "You have nothing to swing." : "You swing at nothing.");
      spend(ATTACK_MS + TURN_GAP_MS);
      return;
    }

    if (action.kind === "melee") {
      if (!reach) {
        this.say(`Your blade falls short of the ${target.name.toLowerCase()}.`);
        spend(ATTACK_MS + TURN_GAP_MS);
        return;
      }
      this.wound(target, MELEE_DAMAGE);
      this.wake(target);
      this.say(`You cut the ${target.name.toLowerCase()} for ${MELEE_DAMAGE}.`);
      spend(ATTACK_MS + TURN_GAP_MS);
      return;
    }

    // Daggers keep the real-time game's dead zone: anything already inside
    // sword reach is too close to throw at.
    if (reach) {
      this.say(`The ${target.name.toLowerCase()} is too close to throw at.`);
      spend(ATTACK_MS + TURN_GAP_MS);
      return;
    }

    // Woken the moment the dagger leaves the hand, not when it lands. `spend`
    // fixes the round's queue immediately, so a hound roused on impact — a beat
    // later, mid-flight — would already have missed the round it was roused in
    // and stand there for a turn. Waking here is what lets it answer at once.
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
    spend(flightMs + THROW_RECOVER_MS + TURN_GAP_MS);
  }

  private wound(enemy: Hound, amount: number): void {
    enemy.health = Math.max(0, enemy.health - amount);
    this.spawnDamageNumber(enemy.x, enemy.y, amount, DAMAGE_COLOR_DEALT);
  }

  /**
   * Wake one hellhound, for good. There is no calming down and no calling to the
   * others: a dagger in one hound's flank is that hound's business, and its
   * packmate across the room goes on watching until you come within a square of
   * it or put something in it too.
   */
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

    // One guard, as in the real-time game: any input at all dismisses the
    // inspect menu, except the mouse messages, which have to tell ✕ from inside
    // from outside first.
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
      case "wait":
        if (this.canAct(now)) this.wait(now);
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

  private onKey(key: string, code: string, now: number): void {
    if (code === "Tab") {
      this.cycleTarget();
      return;
    }
    // The number keys only choose a weapon. Space commits the attack and "."
    // passes the turn — the two keys that cost you something are the two that
    // aren't next to each other on the keyboard by accident.
    if (key >= "1" && key <= "5" && key.length === 1) {
      this.selectSlot(Number(key) - 1);
      return;
    }
    if (key === " ") {
      this.attack(now);
      return;
    }
    if (key === ".") {
      if (this.canAct(now)) this.wait(now);
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
      else if (hitsRect(LOOT_MENU_RECT, point)) return; // swallowed
      else this.inspectingId = null; // outside dismisses, and does nothing else
      return;
    }

    // A finished encounter takes any click as "again" — except a death, which
    // has the HUD's own Resurrect button and shouldn't restart by accident.
    if (isOver(this.phase)) {
      if (this.phase !== "dead") this.restart(now);
      return;
    }

    const enemy = this.enemyNear(point);
    if (enemy) {
      // Clicking the mark drops it. One gesture both ways, so there is always a
      // way to end up holding nothing without hunting for a second one.
      this.targetId = this.targetId === enemy.id ? null : enemy.id;
      return;
    }

    // Walking somewhere beats selecting what is lying there: a body underfoot
    // must never cost you the move. Double-click is how you get at a corpse.
    //
    const cell = cellAtPoint(point);
    if (cell && this.canWalkTo(cell, now)) {
      this.move(cell, now);
      return;
    }

    const corpse = this.corpseNear(point);
    if (corpse) this.targetId = corpse.id;
  }

  /** Pick radius around a body — the same half-body the separation rule uses. */
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
    if (this.inspectingId) return; // the leading click already handled the panel

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

  /**
   * Commit a walk and start playing it out. Returns how long it will take.
   *
   * The duration is proportional to the ground covered rather than fixed, so a
   * half-pace adjustment doesn't take as long as a full stride. On the old
   * board every move was exactly one square and a constant looked fine; now that
   * you can stop anywhere, a constant would make short moves crawl.
   */
  private walkTo(actor: Actor, cell: Cell, now: number): number {
    const to = cellCenter(cell);
    const travelled = distance({ x: actor.x, y: actor.y }, to);
    const ms = Math.max(120, STEP_MS * (travelled / MOVE_RANGE));

    actor.cell = { ...cell };
    actor.slide = { from: { x: actor.x, y: actor.y }, to, startAt: now, endAt: now + ms };
    return ms;
  }

  /** An actor's committed position — where the rules say it is, mid-walk or not. */
  private at(actor: Actor): Point {
    return cellCenter(actor.cell);
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

  /** Whether the selected weapon would connect right now — the bar's gold border. */
  private selectedCanAttack(now: number): boolean {
    if (!this.canAct(now)) return false;
    const target = this.livingTarget();
    if (!target) return false;
    const reach = canReach(this.playerAt(), this.at(target));
    return ACTIONS[this.activeSlot]?.kind === "melee" ? reach : !reach;
  }

  /** The single line telling the player what the board is waiting for. */
  private hint(now: number): string {
    switch (this.phase) {
      case "escaped":
        return "Escaped. Click anywhere to face them again.";
      case "cleared":
        return "The pack is dead. Click anywhere to go again.";
      case "dead":
        return "Killed. Resurrect on the HUD, or press R.";
      case "enemy":
        return "The pack moves.";
      default:
        break;
    }
    if (!this.canAct(now)) return "…";

    const target = this.livingTarget();
    if (!target) {
      return this.anyAwake()
        ? "Click a hellhound to mark it, or anywhere in the ring to move."
        : "Nothing has noticed you. Mark one and throw, or walk into their reach.";
    }
    if (canReach(this.playerAt(), this.at(target))) {
      return "In reach — 1 for the sword, Space to swing. Too close to throw.";
    }
    return "Out of reach — 2 for a dagger, Space to throw. Or step closer.";
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
        // `chasing` is what drops a wolf's head and lights its eyes in the 3D
        // rig; here that posture is simply "awake".
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
      // Drives the enemy portrait and the red target ring: a *living* mark is
      // one you are fighting, a body is merely one you are looking at.
      attacking: target !== null,
      activeSlot: this.activeSlot,
      cooldown,
      selectedCanAttack: this.selectedCanAttack(now),
      // The destination ring, shown only while the step is still playing out.
      moveTarget: this.player.slide ? { ...this.player.slide.to } : null,
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

      // ------------------------------------------------------ turn-based only
      phase: this.phase,
      round: this.round,
      // With nothing drawn on the floor, this disc is the only thing telling the
      // player where they may go — so it is the rule itself, sent over.
      moveRange: this.canAct(now) ? MOVE_RANGE : 0,
      moveFrom: this.playerAt(),
      escapePoint: cellCenter(ESCAPE_CELL),
      escapeRadius: ESCAPE_RADIUS,
      meleeRange: MELEE_RANGE,
      aggro: this.anyAwake(),
      strike: this.strike ? { ...this.strike } : null,
      log: this.log.slice(-LOG_LINES),
      hint: this.hint(now),
    };
  }
}
