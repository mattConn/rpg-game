# rpg-3d

A low-poly 3D front end for the RPG in the parent directory. Same game — same
rules, same combat, same UI — drawn with WebGL instead of glyphs on a canvas.

```bash
npm install
npm start          # http://localhost:3200   (PORT to change it)
npm run dev        # same, restarting the server on change
npm run typecheck
```

The 2D game keeps its own port (3000), so both can run at once.

## What is actually different

Only the drawing. `src/server/index.ts` imports `GameSimulation` from the 2D
project rather than copying it, and the UI overlay imports the 2D client's HUD,
action bar and inspect menu. There is one implementation of the rules and one of
the UI; this project adds a camera, some models, and the arithmetic to get
between screen space and the room.

- **Player** — a human in a brown tunic, with a blade in the right fist that
  follows the selected action-bar slot. The randomised player colour is on the
  cloak.
- **Hellhounds** — wolves: charcoal fur, ember eyes and throat. They patrol,
  break into a run when they chase, lunge when they bite, and fall on their side
  where they die.
- Everything is built from primitives at load time. There are no asset files.

## Controls

Exactly the 2D game's, plus one addition:

| | |
|---|---|
| WASD / click ground | move (world-relative, no pathfinding) |
| click enemy | select |
| double-click enemy / Tab | engage or disengage |
| double-click a body | inspect it |
| 1–5 or click a slot | choose the weapon |
| **mouse wheel** | zoom (new — the camera angle itself is fixed) |

## Layout

| | |
|---|---|
| `src/client/world.ts` | room pixels <-> 3D units, yaw and colour helpers |
| `src/client/models.ts` | every model, built from primitives |
| `src/client/scene.ts` | renderer, lights, room, camera rig, ground markers |
| `src/client/entities.ts` | one rig per snapshot entity, and their animation |
| `src/client/overlay.ts` | the 2D UI, plus labels projected out of the world |
| `src/client/main.ts` | websocket, input, picking, the frame loop |
| `src/server/index.ts` | Fastify + ws, wrapping the 2D simulation |

`CLAUDE.md` in the parent directory has the design notes — the camera, the
click-to-room-point rule, and why the near wall is a parapet.
