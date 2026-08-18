# rpg-tactics

A **turn-based** version of the 3D game: the same dungeon, the same models, the
same UI, on a 3x3 board.

```bash
npm install
npm start          # http://localhost:3300   (PORT to change it)
npm run dev        # same, restarting the server on change
npm run typecheck
```

The 2D game (3000) and the real-time 3D game (3200) keep their own ports, so all
three can run at once.

## The board

```
  @ .  h        the player holds the left column,
  .  .  h       the pack holds the right,
  .  .  D       and D is the door out of the room
```

**The door is a door, not a way to win.** It used to end the encounter the
moment you stood on it; now right-clicking opens it onto a corridor, and the corridor onto a
second chamber the size of this one, and all of it is ground you can walk on.
The pack comes through after you.

The board is turn-based but **not tile-based to look at**. Underneath it is a
15x15 lattice — five cells to each of those three squares — and none of it is
drawn. You walk to wherever you click within your reach for the turn rather than
hopping from square to square, so a turn-based fight moves like a fluid one.

The pack starts **asleep** — two hellhounds standing across the board looking at
you, and you at them. They wake **one at a time**, and never settle again:

- come within a square of one and it notices you;
- put a dagger in one and it notices you — *only* it. Its packmate across the
  room heard nothing and goes on watching.

An unwoken hound takes no turn at all; it stands exactly where it started. A
woken one turns to look at you wherever it is standing, which is the tell that
separates the two. From then on the turns alternate: you act, each woken hound
acts, then it is your turn again.

**A round resolves in sequence and plays out all at once.** Your action is
settled first, then each woken hound's, each reading the board the ones before it
left — and then you watch the lot of it together, your step and both of theirs in
the same beat, rather than sitting through three animations in a row.

**Reach runs sideways and across, never straight up or down** — a quarter-turn
cone opening left and right. A hellhound directly above or below you cannot bite
you and you cannot cut it, which is why the pack manoeuvres to your flanks
rather than simply walking at you. The daggers are the mirror image: anything
already inside sword reach is too close to throw at.

The floor carries one mark and nothing else: a small **white ring** under the
cursor at the spot a click would put you, dark red when that spot is beyond this
turn's reach, has something standing in it, or is not floor at all. Nothing is
drawn under the player, and nothing marks the door — the light coming through it
does that.

Two hounds biting take a third of you a round, and it takes three sword blows to
put one down. That arithmetic does not work in your favour, which is what the
door in the south wall is for: giving ground is the answer to it, and there is
somewhere to give ground *to*.

**A click is a walk to wherever you clicked, not a step.** There is no reach to
stay inside: click the far end of the corridor and you will go there, covering a
square's worth of ground per round and letting the pack act in every one of them.
A long walk is a commitment — you arrive having been bitten the whole way — and
any click, **Space** or **.** calls it off.

Nothing routes around a corner for you. Walking out of the room means walking to
the doorway first and then down the corridor — aim straight at the far end from
across the board and you will set off into the south wall, get nowhere, and be
told the way is blocked.

**The camera frames the board while you are standing on it, and follows you once
you leave it.** Drag, pan and zoom still work wherever you are; **V** puts the
view back.

**F drops you into the player's own eyes**, looking the way they are facing, and
F again lifts you back out to the overhead view you left — same yaw, same pitch,
same zoom. Down there the drag is mouse-look rather than a grab of the board, and
the wheel and the pan have nothing to do. The game underneath does not change: it
is still your turn, you still click the floor to walk and mark a hound to swing
at it, and the hound standing on your shoulder is much harder to ignore.

## Controls

| | |
|---|---|
| click anywhere on the floor | walk there, however far it is |
| click a hellhound | mark it — click it again to drop the mark |
| **1** / **2** or click a slot | choose the sword / the dagger. Costs nothing |
| **Space** | open/close a faced nearby door, otherwise swing at the mark |
| **Attack** | swing the chosen weapon at the mark |
| **.** or **Wait** | hold your ground |
| **Tab** | cycle the mark |
| double-click a body | inspect it |
| **R** | restart the encounter |
| **drag** | orbit the camera |
| **right-drag** / shift-drag | pan |
| **right-click a door** | open or close it while standing in front and facing it |
| **wheel** | zoom |
| **F** | first person — look out of your own eyes. **F** again to come back |
| **V** | reset the view (and drop out of first person) |

**Choosing an attack and making one are separate.** The bar picks up a weapon and
costs nothing — swap freely mid-turn. The two stacked buttons to the right of it
are what spend the turn:

```
  [1] [2] [ ] [ ] [ ]   (Space) Attack
                        (.)     Wait
```

**Attack spends your turn whether or not it lands.** With nothing marked, or with
the sword in hand at two columns' distance, you swing at air and the pack still
gets to answer. The Attack button and the chosen slot's border both go gold when
the blow would actually connect and white when it would only cost you the turn.

## What is actually new

Only the rules. The models, every animation rig, the snapshot playback, and the
whole 2D UI are **imported** from `rpg-3d/` and `src/` rather than copied — the
snapshot this server sends extends the real-time game's, so all of that code
reads exactly the fields it always read.

| | |
|---|---|
| `src/shared/tactics.ts` | the board, the rules, and the snapshot |
| `src/server/game.ts` | turns, the pack's AI, aggro, death |
| `src/server/index.ts` | Fastify + ws |
| `src/client/stage.ts` | the chamber, its torches, and the orbit camera |
| `src/client/chrome.ts` | turn banner, log and hint over the imported overlay |
| `src/client/main.ts` | websocket, input, picking, the frame loop |

`CLAUDE.md` in the parent directory has the design notes.
