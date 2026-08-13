# CLAUDE.md

Guidance for working in this repo.

## What this is

A single-player browser RPG in a dungeon, with **three front ends and two sets
of rules**. Every one of them is a thin renderer over a simulation that runs on
the server and is broadcast as a `GameSnapshot` at 20 Hz; a client sends input
and draws what comes back, and decides nothing.

| | port | renderer | rules |
|---|---|---|---|
| root (`src/`) | 3000 | 2D glyphs on a `<canvas>` | real-time |
| `rpg-3d/` | 3200 | low-poly WebGL | real-time (the *same* `GameSimulation`) |
| `rpg-tactics/` | 3300 | low-poly WebGL | **turn-based**, on a 3x3 board |

- The **real-time** game is the original: roam a 3x3 dungeon of rooms, and fight
  one hellhound at a time by engaging it and closing the distance yourself. The
  2D and 3D clients import one `GameSimulation`, so they cannot disagree.
- The **turn-based** game is a single 3x3 board with two hellhounds on it. You
  act, they act, and you win by killing them or by reaching the arch in the far
  corner. Its rules are genuinely different, so it has its own simulation — but
  it reuses everything downstream of the snapshot, because `TacticsSnapshot`
  *extends* `GameSnapshot`. See [the turn-based section](#the-turn-based-front-end-rpg-tactics).

**Nothing about the rules or the UI is implemented twice.** Models, animation
rigs, snapshot playback, the HUD, the action bar and the inspect menu are
imported across project boundaries, never copied. A change to any of them lands
everywhere by construction — which is the single most important thing to know
before editing anything in here.

Historically this was forked from a sibling `multiplayer-rpg` project by
stripping the networking layer (Hocuspocus / Yjs / awareness), then given a
server simulation and a websocket again — hence `fastify` + `@fastify/static` +
`ws`, and `three` in the two 3D projects.

## Run / build

```bash
npm install
npm start          # esbuild-bundles the client, then serves at http://localhost:3000
npm run dev        # same, but restarts the server on change (tsx watch)
npm run watch:client   # rebuild the client bundle on change
npm run typecheck  # tsc --noEmit
```

The client entry `src/client/main.ts` is bundled by esbuild to
`public/game.js` (IIFE). `public/index.html` loads that bundle. The bundle is
gitignored — `npm start`/`build:client` regenerates it.

Each server listens on `PORT`, defaulting to its own, so nothing collides.

The other two front ends are separate npm projects with their own
`node_modules`, and each is run the same way from its own directory:

```bash
cd rpg-3d      && npm install && npm start   # real-time 3D, http://localhost:3200
cd rpg-tactics && npm install && npm start   # turn-based,   http://localhost:3300
```

All three can run at once. **The root project's `typecheck` covers only `src/`**
— after touching anything under `rpg-3d/` or `rpg-tactics/`, or anything in
`src/` that they import (which is most of it), run `npx tsc --noEmit` and
`npm run build:client` **in each of the three**.

One thing to know before testing by hand: a server holds **one** simulation
shared by every client connected to it. Two browser tabs are two views of the
same game, and driving one headlessly will move the player in the other. Point
automated checks at a second port (`PORT=3301 npm start`) rather than at a
session someone is playing.

## Architecture

TypeScript throughout, ES modules, strict + `noUncheckedIndexedAccess`.

This section describes the **root project**; `rpg-3d/` and `rpg-tactics/` have
their own sections at the bottom of this file. Both import heavily from here, so
treat everything in `src/shared/` and `src/client/` as having three callers, not
one.

- `src/shared/` — pure, browser-agnostic logic (no DOM). Runnable under
  `tsx`/node, which is how it's tested. Also the boundary every front end talks
  across: `protocol.ts` (`GameSnapshot` / `InputMessage`), `actions.ts` (the
  action-bar slots), `combat.ts` (dagger flight, damage-number timing) and
  `loot.ts` (corpses, and the inspect menu's geometry) are all read by all
  three.
  - `constants.ts` — world/room size, dungeon layout, speeds, and the
    `PlayerState`/`RoomCoord`/`Direction` types. **Single source of truth for
    dimensions.**
  - `movement.ts` — pure room-boundary math: `exitAtPoint`, `doorwayTarget`,
    `crossEdges`, plus `MIN_X/MAX_X/MIN_Y/MAX_Y` and `clamp`.
- `src/client/` — everything that touches the canvas.
  - `main.ts` — the game loop, input handling, and all mutable state. Wires the
    other modules together. This is the only stateful module.
  - `viewport.ts` — `fitToViewport`: largest 4:3 canvas for the window.
  - `tilemap.ts` — the glyph grid, walls, and **collision**.
  - `minimap.ts`, `hud.ts`, `actionbar.ts` — the three draggable overlays.
  - `panel.ts` — shared chrome for those overlays (gold drag handle, backing,
    clamping). Reused by all three so they stay identical.
  - `enemies.ts` — enemy entities: targeting hit-tests and rendering (rings,
    hover name).
  - `combat.ts` — thrown-dagger projectiles and the rotatable `†` glyph shared
    with the action bar.
  - `cursors.ts` — the directional exit-arrow cursors (inline SVG data URIs).
- `src/server/` — where the real-time game actually runs.
  - `game.ts` — `GameSimulation`: all mutable state, the tick, and every rule.
    **Imported by `rpg-3d/`'s server too**, so the two real-time front ends
    cannot drift apart. The turn-based game does *not* use it — different rules
    — but copies nothing from it either.
  - `index.ts` — Fastify static server plus the websocket that broadcasts a
    snapshot every 50ms. Both other projects have a near-identical file.

## Core concepts

Everything from here down to the two front-end sections describes the
**real-time** game — the rooms, the roaming, the chase, the cooldown. The turn-based game shares the
coordinate system, the tile size, the glyph/facing conventions and the whole UI,
and shares none of the rest: it has no rooms, no pathing, no cooldown and no
chase. Where it deliberately breaks with something written below, its own
section says so.

### Coordinate system

Game logic works in fixed **room units**: `WORLD_WIDTH=1200 × WORLD_HEIGHT=900`
(4:3). The canvas is scaled to the largest 4:3 rectangle that fits the window
via a context transform set in `resizeCanvas()`; drawing code always uses room
units, so a bigger window renders sharper, not stretched. `toWorld(event)` in
`main.ts` converts mouse coordinates back to room units using the element's
measured size (so it's correct at any window size / DPI). **Never bake pixel
sizes that assume 800×600 or the window size — use the constants.**

### Rooms / dungeon

A 3×3 grid of rooms (`DUNGEON_COLS/ROWS`), each one screen. The player always
spawns in the center room (`START_ROOM = {1,1}`) at the middle of the vault.
Movement is pixel-based within a room; walking past an *open* edge steps into the
neighbor room entering from its far side (`crossEdges`), a *closed* edge (dungeon
border) is a wall. `neighborRoom` decides which edges are open. Only one room is
rendered/simulated at a time.

### Movement + collision

Pixel-based, `PLAYER_SPEED` px/s. WASD (diagonals normalized) or click-to-move
(`moveTarget`). `applyMovement` computes a target position, then
`resolveMove` (in `tilemap.ts`) slides the player's box against solid wall cells
one axis at a time (so you slide along walls), then `crossEdges` handles room
transitions. Collision is **per-cell** and **swept** (checks every cell the
leading edge crosses, so a fast/laggy step can't tunnel a wall). Only tiles
marked `solid` block; rendering is decoupled from collision.

### Tile grid

A `CELL_SIZE=30` px grid (40×30 cells) overlaid on each room, purely for
rendering + collision — it does not constrain movement. Cells are **sparse**
(only placed cells exist), so an empty room draws nothing. `Dungeon` holds one
`TileLayer` per room. Walls are placed with `fillWalls` (auto-tiled **heavy**
box-drawing glyphs `┏━┓┃┗┛` via `boxGlyphHeavy`, marked solid). `boxGlyph` (light
set) and `stampWalls` exist for decorative, non-solid glyph walls. Projectiles
test walls with `segmentHitsWall` / `isSolidAtPixel`.

The starting vault is a solid box in the center room with a 2-cell doorway on its
south side (`rectBorder(16,11,23,18, [[19,18],[20,18]])`).

### Realtime

The world always runs. `tick(realNow)` derives `dt` from wall time and every
timestamp — melee/fire cadence, enemy attack interval, respawn, auto-resurrect —
is plain real ms from the same clock. There is no freeze, no sim-clock domain,
and no time scaling anywhere; a turn-based layer and a 2× "wait" mode both
existed here briefly and were removed, so don't reintroduce a second time
domain. The server simulates whether or not a client is connected.

### Death + auto-resurrect

Dying drops a tombstone and stops the player; the world keeps running.
`resurrect()` is the single revive path, shared by the **Resurrect** button and
the timer.

The **Auto-Res** toggle sits under the HUD stats and is clickable alive or dead
(the `dead` guard in `handleInput` deliberately sits *below* the
`toggleAutoResurrect` case). When on, the player revives
`AUTO_RESURRECT_DELAY_MS` (3s) after death, and `resurrectInMs` drives a
countdown beside the label.

The delay is measured from death rather than from enabling the toggle, so
switching Auto-Res on while already dead revives you at once.

### Overlays (minimap / HUD / action bar)

All three are dragged by a gold handle at their top-left corner. `main.ts` holds
their origins in a `panels` registry `{map,hud,bar}` (origin + clamp fn) and one
drag/handle-hit system drives all of them. `clampPanelOrigin` keeps each fully
on-canvas (handle included). A mousedown on a handle sets `swallowNextClick` so
the drag doesn't also register as a game click.

- **Minimap** (top-right): 3×3 grid, current room highlighted, a dot for the
  player that moves continuously (room picks the cell, in-room position scales
  onto it).
- **HUD** (top-left): circular portrait (the player's `@` in their color), red
  health + blue mana bars, and `Name - lvl N` beneath.
- **Action bar** (bottom center): 5 squares; slots 0/1 hold the melee sword and
  ranged dagger, 2–4 are placeholders. Unselected slots have a dim border; the
  selected one is **gold when the attack would land right now and white when it
  wouldn't** (`selectedCanAttack`). That's range and target only — the cooldown
  is deliberately excluded, or the border would strobe on every swing, and the
  cooldown blind already shows it.

### Enemies + combat

The game is built around **one-on-one combat**: there is exactly one enemy alive
at any moment — a Hellhound (`♞`, orange, 30 HP). It enters just inside a random
room edge (`SPAWN_INSET`, 2 cells — flush against the border left it glued
there, since patrol is horizontal and never carries it inward the way wandering
used to), **patrols left and right**, and chases once the player is within
`CHASE_RANGE` or it has been hit (`aggro`, which is permanent). Kill it and
`RESPAWN_DELAY_MS` (3s) later a fresh one walks in, so there is always something
to fight and never a second one. Wave spawning, `MAX_ENEMIES`, and the
kill-count cooldown that gated it are gone — don't add a spawner back without
changing this section.

**Patrol** (`patrol` in `enemies.ts`) is a horizontal beat `PATROL_SPAN` (12
cells) wide, fixed at spawn by `patrolBeat` and clamped so it can never leave
the screen. Near a wall the beat *slides* inward rather than shrinking, so it
keeps its full width wherever the enemy spawns. The enemy marches at
`ENEMY_SPEED_WANDER` and reverses at either end; a wall counts as an end too, so
it turns around instead of grinding into the vault. Movement is purely
horizontal — it holds whatever line it is on, which after a chase is wherever
the chase left it. A chase that ends *off* the beat walks back to it before
resuming, and the end-of-beat clamp is skipped while returning so it isn't
dragged backwards. Random wandering (`wanderTarget`, `randomRoomPoint`) is gone.

**The gesture picks the target; the action bar picks the weapon.** Combat starts
one way and one way only — **double-click an enemy** — and ends one way only —
double-click your way out. It is fought with whatever slot is selected. Nothing
engages on the player's behalf: no proactive auto-combat, and no retaliation
either, so an enemy can stand there beating on you indefinitely while you do
nothing. That is deliberate; both were tried and removed.

- **Single-click** an enemy → select it (yellow ring). No attack, no movement.
- **Double-click** an enemy → `engageEnemy`: target + `attacking`, leaving
  `activeSlot` alone. `updateCombat` then applies that weapon's range rule:
  - **melee** — strike every `MELEE_INTERVAL` while within `ATTACK_RANGE`.
  - **ranged** — a dagger every `FIRE_INTERVAL_MS` in the band **outside
    `ATTACK_RANGE` and within `RANGED_RANGE`** (45–420px; the far limit is a
    third of the room's width). Daggers have a dead zone as well as a limit:
    anything already in sword reach is too close to throw at, so a hellhound on
    top of you shuts your daggers off until you draw the sword or back away.
    Beyond the limit you just hold the target and wait — ranged never moves you.
- **Tab** → same thing on the nearest enemy in the room, with no range limit.
  Double-click and Tab both go through `toggleEngage`, so they stay identical by
  construction — including the toggle back off. The client swallows Tab's
  auto-repeat (held down it would strobe engage/disengage) and its default, so
  focus doesn't walk off the canvas.
- **Double-click the engaged enemy again** (or press Tab again) → disengage and
  untarget. Together with double-clicking a *different* enemy (which just
  switches target), that is the **only** way out of combat.
- **1–5** or clicking a slot selects the weapon, before or during a fight —
  switching mid-fight switches behaviour on the next tick.

**One shared attack cooldown**, shown on the action bar as a blind. The square
that fired goes dark (icon included — the overlay is drawn *after* the glyph),
then its shade retracts upward over the cooldown so the square refills with
colour from the bottom. `startCooldown` captures the slot at fire time, so
switching weapons mid-cooldown leaves the sweep on the square that actually
attacked. The snapshot carries `cooldown: {slot, remainingMs, totalMs} | null`,
and the client counts `remainingMs` down from snapshot arrival — at 600ms a
snapshot-stepped blind visibly stair-steps. Only the firing slot is shaded, so
the *other* square looks ready when it isn't; that's cosmetic, the gate is
`nextAttackAt` either way.

There is a single `nextAttackAt`, not a timer
per weapon, and each attack charges *its own* interval against it: a dagger
(`FIRE_INTERVAL_MS`, 1s) owes a full second even if you switch to the sword
(`MELEE_INTERVAL`, 600ms) straight after. **You can never beat the cadence of the
attack you just made.** That's what stops weapon-swapping from being a damage
multiplier — with per-weapon timers, alternating slots let each one fire off its
own stale clock. `engageEnemy` deliberately does *not* reset it either, or
double-clicking off and back on would refund the cooldown.
- **Movement never breaks combat.** A ground click or a WASD step walks you
  wherever you asked and the engagement rides along — you keep swinging at
  anything that stays inside `ATTACK_RANGE` and keep throwing at anything inside
  `RANGED_RANGE` as you go.
- **Hover** within `NAME_REVEAL_DISTANCE` → shows its name (same rule reveals the
  player's own `(You)` label).

**Neither weapon pursues.** `engageEnemy` never writes `moveTarget` and neither
does `updateCombat` — closing the distance is entirely the player's job, with
WASD or a ground click (or by letting the hellhound come to you; it chases
inside `CHASE_RANGE`). Engaging a target 300px away and standing still is a
no-op: you stay put and it takes no damage. An earlier version auto-ran you into
`ATTACK_RANGE`, which needed a whole yielding mechanism so player movement could
win — all of that is gone; don't reintroduce a chase without reading this
paragraph.

Two range constants interact awkwardly and are worth knowing before tuning:
`ENEMY_RADIUS` (45, the click hit-box) is *larger* than `ATTACK_RANGE` (44), so
a ground click near enough to leave you in sword reach is swallowed by the
enemy's hit-box and read as "select" instead. Click-to-move alone therefore
always stops a hair short — in practice the hellhound closes that gap itself, so
the fight still starts, but WASD is the reliable way in.
- **Right-click has no meaning.** The canvas `contextmenu` handler only suppresses
  the browser menu.

The double-click is the browser's own `dblclick` event. The leading `click`s that
precede it only select a target, so letting them through first is harmless —
this is why the client needs no debounce. An earlier model bound the weapon to
the gesture (click = ranged, double-click = melee) and *did* need one, to stop a
dagger flying before the melee charge; don't reintroduce it.

Enemy attacks are gated on `e.chasing`, which is only ever assigned inside
`updateEnemy` — and `tick` skips `updateEnemy` for the enemy you're meleeing so
it holds position instead of shoving you. `tick` therefore sets `chasing` itself
in that branch, or a hellhound engaged at point-blank would never swing back.

### Corpses + the inspect menu

A killed enemy leaves a **body**, not a hole: the kill sweep moves it out of
`enemies` and into `corpses` (`shared/loot.ts`), where it keeps its glyph,
colour, position and facing — and its **id**, which is what an open inspect menu
points at. Dying still **clears `targetId`**: a kill leaves you holding nothing,
and the body has to be clicked afresh to select it. Living and dead are separate arrays, so
AI, enemy attacks, `nearestEnemy` (Tab) and `combatTarget` see only the living by
construction, with no `if (dead)` guard sprinkled through the tick. Corpses never
collided with anything (nothing but tiles ever did), so you walk straight
through them. `drawCorpse` renders the glyph at `CORPSE_ALPHA` — fading against
the black room reads as darkened without a second palette per enemy type — and
draws no health bar.

Bodies are permanent, but capped at `MAX_CORPSES` (32, oldest dropped): a kill
every few seconds would otherwise grow the snapshot forever.

**The same two gestures mean different things on the dead.** Single-click
selects a corpse (living win a tie — a body can lie under one); double-click
**inspects** it instead of engaging, opening a centred grey panel titled
`"<name> (dead)"`, which is exactly what hovering the body shows (`corpseLabel`
is the single source for both). Hellhounds carry nothing, so the panel says
`(empty)`.

The menu's geometry lives in `shared/loot.ts` because **the server owns the
menu**, same as everything else — the client only draws `snapshot.inspect`, so
both sides need the rectangles. It closes on:

- the ✕ in the title bar, or any click *outside* the panel — and that click does
  nothing else, so dismissing never also walks you somewhere;
- a click *inside* the panel does nothing at all (swallowed);
- **any other input** — movement, engaging, a weapon swap, resurrect. That's one
  guard at the top of `handleInput` rather than a line per case; mouse messages
  are excluded there because they need to tell ✕ / inside / outside apart.

It also closes on things that happen *to* the player rather than because of
them: **taking a hit** and **dying**, both in `tick`. A panel parked over the
middle of the room otherwise hides the hellhound chewing on you, and it is the
one dismissal the player can't trigger themselves. Input alone was not enough —
the menu closes when the world acts on you too.

## Conventions

- **Testing.** There is no committed test suite. Pure logic (shared/, and the
  testable client modules like `tilemap`, `combat`, `actionbar`, `minimap`,
  `hud`, `viewport`) is verified with throwaway `node:assert` scripts run via
  `npx tsx`, then deleted. When adding logic, keep it pure and importable so it
  can be checked this way, and prefer moving math out of `main.ts` into a module.
  Both simulations run headless too, so drive `GameSimulation` / `TacticsGame`
  directly with a fake clock rather than testing through a browser. Always run
  `npx tsc --noEmit` and `npm run build:client`, **in all three projects**, after
  changes.
  - When a throwaway test passes first time on a bug you meant to catch,
    *revert the fix and check it fails.* Two of the bugs fixed here — the
    damage-number jitter especially — had obvious-looking probes that were
    measuring the wrong quantity and passed against the broken code.
- **Glyph facing.** The player and enemies carry a `facing` (+1 right, −1 left)
  on the snapshot, set from the sign of their actual horizontal travel. The
  glyphs (`♞`, `@`) are drawn facing left, so `drawFacingGlyph` **mirrors when
  facing right** (`scale(-1, 1)` about the glyph's own centre — it relies on
  `textAlign = "center"`). Facing is *held* through vertical-only movement and
  while standing still, so it never flickers; only a horizontal move changes it,
  which is why up-and-right reads as right.
- **Glyphs.** Rendered with the system `monospace` font. BMP, single-cell,
  grid-safe glyphs only (no emoji / wide chars). Box-drawing/heavy-box glyphs can
  show faint seams between cells in some system fonts — bundling a webfont is the
  intended fix when walls need to be pixel-perfect (not yet done).
- **Comments** explain *why*, matching the existing terse style. Match
  surrounding naming/idiom.

## Known limitations / next steps

- **No pathfinding.** Click-to-move and WASD travel in a straight line and stop
  at walls — nothing routes around the vault. The player spawns *inside* it, so
  to reach the hellhound you leave via the south doorway first. (This bites when
  writing tests too: stage the player on open floor, e.g. `(200, 800)`, or they
  walk into a wall.)
- Collision is cell-based (full 30px cell) while wall glyphs are thinner lines,
  so the player stops a few px shy of visually touching a wall.
- Player name/color are randomized per simulation (no persistence, no name
  entry). True of all three front ends.
- HUD health is live; mana is still a static placeholder. Action-bar slots 3–5
  are empty. Also true of all three.
- The turn-based game has its own list at the end of its section.

## The 3D front end (`rpg-3d/`)

A second, **low-poly 3D client** for the same game, in its own npm project with
its own `node_modules` (it adds `three`), served on **port 3200** so it can run
alongside the 2D one. `cd rpg-3d && npm install && npm start`.

**It is a renderer, not a fork.** `rpg-3d/src/server/index.ts` imports
`GameSimulation` from `../../../src/server/game.js`, and the 3D client imports
`hud.ts`, `actionbar.ts`, `lootmenu.ts`, `interpolation.ts` and `viewport.ts`
from `src/client/`. There is exactly one implementation of the rules and one of
the UI; both front ends read the same `GameSnapshot` and send the same
`InputMessage`. **Never copy simulation or UI code into `rpg-3d/` — import it.**
A rule change in `src/` must land in both clients by construction.

- **Two stacked canvases**, sharing one 4:3 letterbox: WebGL underneath, the 2D
  UI on top. The overlay still draws in 1200x900 room units, so the HUD, action
  bar, clock and inspect menu are the same code at the same coordinates. The
  overlay canvas must stay **transparent** — an opaque backing hides the world.
- **Scale.** One 30px tile = one 3D unit, so the arena is 40x30 and a human is
  1.9 tall. Room x -> scene x, room **y -> scene z**; the ground is y = 0.
- **Models are built facing +X** (the snapshot's `facing: 1`) and turned with
  `yawFor`. Limbs hang from pivot groups and swing about **Z**. Everything is
  primitives in `models.ts` — there are no asset files.
- **Screen space is not room space**, and two rules keep that from leaking into
  the game: a click is resolved to a *room point* before it is sent (an entity
  under the cursor sends its own position, so the server's `enemyAtPoint` decides
  with the radius it always used), and the UI is hit-tested on the overlay. The
  inspect menu is the exception that proves it — `lootMenuPoint` translates a
  screen click into the room point that makes the server reach the same verdict
  (✕ / inside / outside), because the panel is drawn in overlay space while
  clicks arrive in room space.
- **The camera yaw is fixed** — a 3/4 view that follows the player, zoom on the
  wheel. It is deliberately not orbitable: WASD is world-relative on the server,
  so a turnable camera would quietly change what "w" means. The eye is clamped
  inside the east/west/north walls (masonry would get in front of the player) but
  may trail past the **south wall, which is built as a low parapet** for exactly
  that reason.
- **Animation is derived, never sent.** The protocol carries state, so a swing is
  "the shared cooldown was recharged", a wound is "that enemy has less health",
  and a bite is "the player's health dropped". Those comparisons run on *raw*
  snapshots in `onSnapshot` — the interpolated ones smear the step away.
- The player's randomised colour is on the **cloak**; the tunic is always brown.
- Same testing convention as the 2D game: `three`'s scene graph runs headless, so
  models and rigs are checked with a throwaway `node:assert` script under `tsx`,
  then deleted. Run `npx tsc --noEmit` and `npm run build:client` **in
  `rpg-3d/`** — the root project's typecheck does not cover it.
- **Damage numbers carry an `id`, and every client pairs them by it** — never by
  array position. The list is not stable: one expires out of the middle while a
  newer one lives on, and an index then interpolates a survivor against a
  *different* number. Because two bites on the player spawn at the same point,
  the tell isn't the position but the **age**, which drives both the fade and the
  screen-space rise: it jumped by up to 0.8s of a 1.4s lifetime, roughly 17px up
  the screen, every frame two numbers overlapped. That is the jitter.
- **Damage numbers** float at `DAMAGE_NUMBER_HEIGHT` (2.5 units) over the room
  point they spawned at, which has to clear the *tallest* thing one can belong
  to — the 1.9-unit player — or a bite reads as a label on their chest. They are
  drawn with a dark outline and held at full alpha for most of their life:
  unoutlined 15px text that starts fading immediately was, measurably, almost
  invisible over lit stone. `DAMAGE_NUMBER_LIFETIME` / `_SPEED` live in
  `src/shared/combat.ts` because a server ages and retires them while a client
  fades and places them — they were duplicated in four files and had to agree.
- Two of its client modules exist to be shared with the turn-based front end
  rather than for its own sake, and neither should grow a dependency on this
  game's rules: `playback.ts` (`interpolateSnapshot`, generic over anything
  extending `GameSnapshot`) and `applyCues` in `entities.ts`, which is the whole
  "protocol carries state, not events" derivation in one function.

## The turn-based front end (`rpg-tactics/`)

A **third** client, again its own npm project, served on **port 3300**.
`cd rpg-tactics && npm install && npm start`. Same dungeon, same models, same UI
— but the game is a 3x3 board and the rules are a board game's.

The whole game, in one picture:

```
  @ .  h        player opens on (0,0), the pack holds the right column,
  .  .  h       and the arch out of the vault is the bottom-right square.
  .  .  X       Reach X and you are gone.
```

Turns alternate: you take one action, then every *woken* hellhound takes one,
then it is your turn again. Your action is a **step** (one square, any of the
eight directions — click a lit tile), an **attack**, or a **wait**. There is no
free movement and no real-time input at all.

| | |
|---|---|
| click a lit square | step onto it |
| click a hellhound | mark it; click it again to unmark |
| **1** / **2**, or a bar square | choose sword / dagger. **Costs nothing** |
| **Space**, or the Attack button | swing the chosen weapon at the mark |
| **.**, or the Wait button | hold your ground |
| **Tab** / **Esc** | cycle the mark / drop it |
| double-click a body | inspect it |
| **R** | restart the encounter |
| drag / right-drag / wheel / **V** | orbit / pan / zoom / reset the view |

The three constants worth holding in your head while reading the rest: a
hellhound has 24 HP and hits for 7, the player has 100 and hits for 8 (sword) or
5 (dagger). Two hounds biting take roughly a third of you per round and a hound
takes three sword blows to kill, so standing and trading with both loses. That
arithmetic is the reason the arch exists.

**It is the 3D client's renderer with different rules under it.** The models,
every animation rig, `applyCues`, `interpolateSnapshot` and the entire 2D overlay
are imported from `rpg-3d/` and `src/client/`; only `src/shared/tactics.ts`
(board + rules) and `src/server/game.ts` (turns) are new. **Never copy a model,
a rig or a piece of UI in here — import it.**

The mechanism that makes that possible is one line: `TacticsSnapshot` **extends
`GameSnapshot`**. Everything downstream reads the fields it always read; the
turn-based additions (`phase`, `round`, `playerCell`, `legalMoves`, `escapeCell`,
`aggro`, `log`, `hint`) ride along untouched. Adding a required field to
`GameSnapshot` means filling it in here too.

- **Positions stay in room pixels.** A square is `TILE_PX = 90` (three 3D units,
  against a 1.9-unit human and a 1.5-unit hellhound — close enough that adjacent
  figures nearly touch, which is what a 3x3 board needs to read as a fight
  rather than as three acres of flagstone). The board is centred in the 1200x900
  room and everything reports `ARENA_ROOM`. Keeping room pixels as the unit is
  what leaves the imported models, HUD and damage-number projection unscaled —
  the 3D bridge still just divides by 30.
  - `stage.ts` derives the board extent, the camera's framing and the fog as
    **multiples of `BOARD_W`**, not in fixed units, so resizing a square carries
    the whole scene with it. Hard-coded distances there would quietly leave the
    view halfway across the dungeon the first time `TILE_PX` changed.
- **Real time only animates; it never decides.** A turn is committed the instant
  it is asked for — the actor's *cell* changes immediately — and `busyUntil` then
  holds the board still while the slide or the swing plays out. Death and escape
  are the deliberate exceptions, resolved after the animation, so a hellhound
  dies at the end of the blow that killed it.
- **Reach is horizontal and diagonal, never vertical** (`canMelee`: `|dcol| === 1
  && |drow| <= 1`). It is symmetric, so it gates the bite exactly as it gates the
  sword, and `chooseHoundStep` plans the approach with the same function — which
  is why the pack moves into the column *beside* you rather than straight at you.
  Daggers keep the real-time dead zone: in sword reach is too close to throw.
- **Aggro is per-hound, and permanent.** A hellhound wakes when the player comes
  within a square of it (`isAdjacent`, checked every tick, so it fires whichever
  side closed the gap) or when a thrown dagger finds it — **only** it; the other
  one goes on watching. The enemy queue is built from woken hounds alone, so an
  unprovoked one takes no turn at all and stands exactly where it started.
  `isAdjacent` is deliberately wider than `canMelee`: something directly above
  you is close enough to notice you but has to step aside before it can bite.
  `snapshot.aggro` is only "has anything started"; per-hound state is on
  `enemies[].aggro`.
  - **Waking costs no turn** — a hound roused this round moves or bites this
    round. That is an ordering constraint, not a rule: `endPlayerTurn` fixes the
    queue for the round the instant the action is committed, so **anything that
    wakes a hound must do so before then**. `move` updates the player's cell
    before committing (so `wakeAdjacent` inside `endPlayerTurn` sees it), and a
    thrown dagger wakes its target **at the throw**, not on impact — waking on
    impact is a beat later, mid-flight, by which time the queue is already
    fixed and the hound stands there for a turn.
- **A woken hound looks at you.** `faceThePlayer` turns it every tick while it is
  standing still, and the client passes a `facePointFor` resolver into
  `syncEnemies` so the 3D model turns properly rather than just flipping ±X. Mid
  step it faces its travel direction — a wolf holding its head on you while
  crossing the board strafes.
- **Every hound that bites animates its own bite.** `snapshot.strike` carries
  `{ enemyId, seq }` — the last blow landed, with a counter that ticks per blow —
  and the client lunges that id whenever `seq` changes. `applyCues` takes an
  optional `biterOf` resolver for exactly this; without one it falls back to the
  real-time game's *guess*, the nearest enemy that is hunting you. That guess is
  fine when one hellhound is chasing you across a room and wrong on a board
  where two flank you and both strike in a round: it hands the animation to
  whichever is a few pixels closer, twice, while the other bites you without
  moving. It stays state rather than an event, so a repeated snapshot can't
  double-play it, and `strikeSeq` deliberately survives a restart — rolling back
  to 1 would replay a bite that never happened.
  That turn, its lit eyes and its head-down hunting posture are the *whole* tell
  that a hound has woken — there is deliberately **no marker on the floor for
  aggro**. A ring under woken hounds was tried and removed: the floor already
  carries the legal-move tiles, the escape square and the target ring, and a
  fourth thing competing for it read as clutter rather than as information.
- **Stepping onto `ESCAPE_CELL` does not hand over the turn** — you are through
  the arch before they can answer. Every other action ends the turn.
- **Choosing an attack and making one are separate acts.** The bar's squares and
  1–5 only put a weapon in your hand and cost nothing; the turn is committed by
  the stacked **Attack** / **Wait** buttons to the right of the bar, or by
  **Space** / **`.`**. That split is in the protocol too — `slot` selects,
  `attack` and `wait` commit — because one of those ends your turn and the other
  doesn't, and a weapon swap must never be an accidental swing.
  - **Attack always spends the turn**, landing or not: with nothing marked, or
    with the sword out at two columns, you swing at air and the pack still
    answers. Committing is the decision; connecting is the consequence.
  - The cooldown blind is repurposed as "waiting for your turn". It is set only
    by attacks, never by a step, because `applyCues` derives the player's swing
    from a fresh cooldown and a step would otherwise swing at nothing.
  - `drawActionBar` prints the selecting key `(1)`–`(5)` in each square's corner.
    That is in the **shared** bar, so it shows in all three front ends — 1–5
    select the slot everywhere, so the label is true everywhere.
- **Clicking the mark drops it.** One gesture both ways; clicking a *different*
  hellhound switches rather than toggling.
- **The camera orbits here, and that is safe here.** The real-time client pins
  its yaw because WASD is world-relative; this game has no directional input at
  all, so there is nothing a rotation can break. Drag orbits, right/shift-drag
  pans, wheel zooms, V resets. A drag past `DRAG_THRESHOLD` swallows the click
  that follows, or looking around would also order a step.
- **No hurt flash.** The tactics client passes `hurt: 0` into the shared
  `drawOverlay` rather than tracking it. The real-time game needs the red
  vignette because from behind the shoulder a bite is easy to miss; here the
  whole board is on screen and the log names what hit you, so it only got in the
  way of reading the board.
- **The grid is built into the floor** as nine raised flagstones — the opposite
  call to the real-time room, where drawing the tile grid would advertise a
  structure that pixel-based movement doesn't have. Here the grid *is* the game.
- Same testing convention again: the rules are pure and the simulation runs
  headless, so drive `TacticsGame` with a throwaway `node:assert` script under
  `tsx` and delete it. Typecheck and build **in `rpg-tactics/`**.

### Known limitations (turn-based)

- **No pathfinding is needed and none exists** — every move is one square, so
  reachability is just `neighbors()` minus occupied squares. If the board ever
  grows past 3x3 this is the first thing that breaks.
- **The escape square can be stood on by a hellhound**, which makes it an
  illegal move until the hound steps off or dies. That is deliberate tension,
  but it means a run can be walled off for a turn or two with no warning in the
  UI beyond the tile not lighting up.
- Mana, the level number and the game clock are inherited from the real-time
  HUD and mean nothing here.
- Corpses are capped at `MAX_CORPSES` (8) and never decay, but only two
  hellhounds ever exist, so the cap is unreachable in practice.

## Git

Remote `origin` is `git@github.com:mattConn/rpg-game.git` (push over **SSH** —
HTTPS has no stored credential in this environment). Commits are co-authored with
Claude.
