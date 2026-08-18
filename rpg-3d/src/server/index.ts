/**
 * Server for the 3D front end.
 *
 * Deliberately thin: it is the 2D game's server with a different static
 * directory and port. `GameSimulation` is *imported* from the 2D project rather
 * than copied, so the rules and combat can't drift between the two clients —
 * there is exactly one implementation of them, and both renderers read the same
 * `GameSnapshot`.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { WebSocketServer } from "ws";

import { GameSimulation } from "../../../src/server/game.js";
import type { InputMessage } from "../../../src/shared/protocol.js";

/** Its own port, so the 2D game can keep running on 3000 alongside it. */
const PORT = Number(process.env.PORT ?? 3200);
const HOST = process.env.HOST ?? "0.0.0.0";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const sharedTextureDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "public", "textures");

const fastify = Fastify({ logger: true });

await fastify.register(fastifyStatic, { root: publicDir });
await fastify.register(fastifyStatic, {
  root: sharedTextureDir,
  prefix: "/shared-textures/",
  decorateReply: false,
});

// ------------------------------------------------------------ game simulation

const game = new GameSimulation();

// ------------------------------------------------------------ websocket server

// Use noServer mode so Fastify doesn't intercept the upgrade request.
const wss = new WebSocketServer({ noServer: true });

fastify.server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws) => {
  fastify.log.info("client connected");

  // Send the latest snapshot immediately so the client doesn't start blank.
  ws.send(JSON.stringify(game.snapshot()));

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(String(data)) as InputMessage;
      game.handleInput(msg);
    } catch {
      // Ignore malformed messages.
    }
  });

  ws.on("close", () => {
    fastify.log.info("client disconnected");
  });
});

// ------------------------------------------------------------ simulation loop

// 20 Hz tick — the game runs whether or not any client is connected.
setInterval(() => {
  game.tick(Date.now());

  const snapshot = JSON.stringify(game.snapshot());
  for (const client of wss.clients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(snapshot);
    }
  }
}, 50);

// ------------------------------------------------------------ start server

try {
  await fastify.listen({ port: PORT, host: HOST });
  fastify.log.info(`3D game available at http://localhost:${PORT}`);
} catch (error) {
  fastify.log.error(error);
  process.exit(1);
}
