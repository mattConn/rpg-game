# rpg-game

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
