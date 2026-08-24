# RPG Tactics — native C++ port

Standalone, single-process port of `rpg-tactics`. The simulation and renderer
run in the same executable; there is no server, WebSocket, JavaScript, or browser.

## Requirements

- clang with C++20 support
- SDL2
- SDL2_image
- Assimp 6 (native glTF asset loading)
- OpenGL (the Makefile currently targets macOS' OpenGL framework)

## Build and run

```sh
cd rpg-tactics-cpp
make
make run
```

To verify SDL/OpenGL initialization and render three frames without leaving the
game open, run `make smoke`.

## Controls

- `WASD` — move relative to the camera
- `Shift` — run
- Left or right mouse drag — orbit camera
- Left click — melee attack
- `E` — eat a nearby corpse
- `H` — toggle enemy hitboxes
- `Esc` — quit

## Current port boundary

This is a native gameplay/rendering port using the browser game's gray-wolf and
bat glTF assets. It preserves the dungeon layout, local realtime combat, health
values, enemy behavior, corpse eating, HUD, particles, camera, fog, and textured
stone environment. The Assimp-backed model layer currently renders the imported
bind pose; skeletal clip playback is the remaining model-fidelity boundary.
