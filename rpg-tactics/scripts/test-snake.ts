import assert from "node:assert/strict";

import { TacticsGame } from "../src/server/game.js";
import { DUNGEON_ENEMIES, configureDungeon } from "../src/shared/tactics.js";

let snakeFloors = 0;
let doubleFloors = 0;
for (let seed = 1; seed <= 10_000; seed++) {
  configureDungeon(seed);
  const snakes = DUNGEON_ENEMIES.filter((enemy) => enemy.kind === "snake").length;
  if (snakes > 0) snakeFloors++;
  if (snakes === 2) doubleFloors++;
}
assert.ok(snakeFloors / 10_000 > 0.28 && snakeFloors / 10_000 < 0.32, "snake floor roll stays near 30%");
assert.ok(doubleFloors / snakeFloors > 0.08 && doubleFloors / snakeFloors < 0.12, "double-snake roll stays near 10%");

configureDungeon(2);
const start = 10_000;
const game = new TacticsGame(start);
const internals = game as any;
const snake = internals.enemies.find((enemy: any) => enemy.kind === "snake");
assert.ok(snake, "seed 2 creates a snake encounter");
assert.equal(snake.health, 200);
assert.equal(snake.maxHealth, 200);

// Put the snake in striking distance and force the probability roll low.
snake.aggro = true;
snake.movementStartsAt = 0;
snake.roomIndex = 0;
snake.cell = { ...internals.player.cell };
snake.x = internals.player.x + 20;
snake.y = internals.player.y;
snake.pos = { x: snake.x, y: snake.y };
snake.heading = { x: 1, y: 0 };
const originalRandom = Math.random;
Math.random = () => 0;
game.tick(start + 50);
assert.equal(game.snapshot().stats.health, 100, "snake cannot damage a player behind its head");
snake.heading = { x: -1, y: 0 };
game.tick(start + 100);
Math.random = originalRandom;
assert.equal(game.snapshot().stats.health, 70, "snake attack deals 30 damage");
assert.equal(game.snapshot().poisoned, true, "snake attack can poison");
assert.equal(game.snapshot().enemies.find((enemy) => enemy.id === snake.id)?.attacking, true,
  "snake reports its stationary attack window");
const attackPosition = { x: snake.x, y: snake.y };
game.tick(start + 550);
assert.deepEqual({ x: snake.x, y: snake.y }, attackPosition, "snake stops while attacking");

// Compare one tenth-second of walking and running pursuit in the same room.
const resetPursuit = () => {
  snake.attackUntil = 0;
  snake.nextAttackAt = Infinity;
  snake.x = internals.player.x + 200;
  snake.y = internals.player.y;
  snake.pos = { x: snake.x, y: snake.y };
  snake.cell = { ...internals.player.cell };
  snake.heading = { x: -1, y: 0 };
};
resetPursuit();
internals.playerRunning = false;
const walkBefore = snake.x;
game.tick(start + 650);
const walkDistance = walkBefore - snake.x;
resetPursuit();
internals.playerRunning = true;
const runBefore = snake.x;
game.tick(start + 750);
const runDistance = runBefore - snake.x;
assert.ok(Math.abs(walkDistance - 30) < 0.01, "snake matches the 300 px/s walk speed");
assert.ok(Math.abs(runDistance - 48) < 0.01, "snake matches the 480 px/s run speed");

// Aggro never drops, and eating its corpse cures poison.
game.tick(start + 850);
assert.equal(snake.aggro, true, "snake remains aggroed while alive");
snake.health = 0;
internals.retireDead();
const corpse = internals.corpses.find((candidate: any) => candidate.kind === "snake");
assert.ok(corpse, "dead snake leaves an edible corpse");
internals.player.x = corpse.x;
internals.player.y = corpse.y;
internals.player.pos = { x: corpse.x, y: corpse.y };
internals.poisoned = true;
internals.poisonTicksRemaining = 5;
internals.nextPoisonAt = Infinity;
internals.startEating();
for (let step = 1; step <= 11; step++) game.tick(start + 850 + step * 100);
assert.equal(game.snapshot().poisoned, false, "eating a snake cures poison");

console.log("PASS: snake spawning, stats, pursuit speeds, attack lock, damage, poison, and corpse cure.");
