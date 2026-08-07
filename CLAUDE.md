# CLAUDE.md

Guidance for working in this repo.

## What this is

A 2D single-player browser RPG rendered on an HTML `<canvas>`. All game logic
runs in the browser; a small Fastify server only serves static files (no
websocket, no shared state). It was forked from a sibling `multiplayer-rpg`
project by stripping the networking layer (Hocuspocus / Yjs / awareness) — hence
deps are just `fastify` + `@fastify/static`.

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

The dev server listens on `PORT` (default 3000). During this project a second
copy was often run with `PORT=3100` alongside the multiplayer one.

## Architecture

TypeScript throughout, ES modules, strict + `noUncheckedIndexedAccess`. Three
layers:

- `src/shared/` — pure, browser-agnostic logic (no DOM). Runnable under
  `tsx`/node, which is how it's tested.
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
- `src/server/index.ts` — Fastify static server. Nothing game-specific.

## Core concepts

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
  ranged dagger, 2–4 are placeholders. Active slot has a yellow border.

### Enemies + combat

The game is built around **one-on-one combat**: there is exactly one enemy alive
at any moment — a Hellhound (`♞`, orange, 30 HP). It enters at a random room edge,
wanders, and chases once the player is within `CHASE_RANGE` or it has been hit
(`aggro`, which is permanent). Kill it and `RESPAWN_DELAY_MS` (3s) later a fresh
one walks in, so there is always something to fight and never a second one. Wave
spawning, `MAX_ENEMIES`, and the kill-count cooldown that gated it are gone —
don't add a spawner back without changing this section.

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
  - **ranged** — a dagger every `FIRE_INTERVAL_MS` while within `RANGED_RANGE`
    (7 cells). Out of range you just hold the target and wait; point-blank you
    keep throwing rather than closing.
- **Double-click the engaged enemy again** → disengage and untarget. Together
  with double-clicking a *different* enemy (which just switches target), that is
  the **only** way out of combat.
- **1–5** or clicking a slot selects the weapon, before or during a fight —
  switching mid-fight switches behaviour on the next tick.

**One shared attack cooldown.** There is a single `nextAttackAt`, not a timer
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

## Conventions

- **Testing.** There is no committed test suite. Pure logic (shared/, and the
  testable client modules like `tilemap`, `combat`, `actionbar`, `minimap`,
  `hud`, `viewport`) is verified with throwaway `node:assert` scripts run via
  `npx tsx`, then deleted. When adding logic, keep it pure and importable so it
  can be checked this way, and prefer moving math out of `main.ts` into a module.
  Always run `npx tsc --noEmit` and `npm run build:client` after changes.
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
- Player name/color are randomized per page load (no persistence, no name entry).
- HUD health is live; mana is still a static placeholder. Action-bar slots 3–5
  are empty.

## Git

Remote `origin` is `git@github.com:mattConn/rpg-game.git` (push over **SSH** —
HTTPS has no stored credential in this environment). Commits are co-authored with
Claude.
