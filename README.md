# rpg-game

**The main game is now the Windows-native C++ version in
[`rpg-tactics-cpp/`](rpg-tactics-cpp/README.md).** All new game development focuses
on that version. See [AGENTS.md](AGENTS.md) for repository working guidance.

```powershell
cd rpg-tactics-cpp
./build.ps1
./run.ps1
```

You can also double-click `rpg-tactics-cpp/run.cmd`. The native game loads the
existing sprite assets and saved editor maps. Double-click
`rpg-tactics-cpp/editor.cmd` for the **native C++ level editor** (or build with
`./build.ps1 -Target editor` and run `./editor.ps1`). Both game and editor run
without a browser or Node server. The browser version remains as a reference.

## Legacy root browser game

The instructions below describe the original browser app, not the main game.

A 2D single-player browser RPG rendered on an HTML canvas, served by a small
Fastify static server. Everything runs in the browser; the server only serves
files.

## Run

```bash
npm install
npm start          # builds the client bundle and serves at http://localhost:3000
```

`npm run dev` rebuilds and restarts on server changes; `npm run watch:client`
rebuilds the client bundle on change.

## Controls

- **WASD** or **click** to move; click a room edge (arrow cursor) to change rooms.
- **1–5** or click the bottom action bar to pick an attack (sword / thrown dagger).
- **Single-click** an enemy to target it; **double-click** to attack (again to cancel).
- Drag the gold dots to move the minimap, portrait, and action bar.

## Layout

- `src/shared/` — world constants and pure movement/room logic
- `src/client/` — canvas game (rendering, input, combat, tiles, HUD, minimap)
- `src/server/` — Fastify static file server
- `public/` — `index.html`; the client bundle is built to `public/game.js`
