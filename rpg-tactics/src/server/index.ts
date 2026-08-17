/**
 * Server for the turn-based front end.
 *
 * The same thin wrapper the other two front ends use — static files, a
 * WebSocket, and a 20 Hz broadcast — around a different simulation. The
 * simulation is different because the *rules* are; everything downstream of the
 * snapshot (the models, the animation, the whole 2D UI) is imported from the
 * real-time game rather than reimplemented.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { WebSocketServer } from "ws";

import { TacticsGame } from "./game.js";
import type { TacticsInput } from "../shared/tactics.js";

/** Its own port, so 3000 (2D) and 3200 (3D) can keep running alongside it. */
const PORT = Number(process.env.PORT ?? 3300);
const HOST = process.env.HOST ?? "0.0.0.0";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

const fastify = Fastify({ logger: true });

await fastify.register(fastifyStatic, { root: publicDir });

const game = new TacticsGame();

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
      game.handleInput(JSON.parse(String(data)) as TacticsInput);
    } catch {
      // Ignore malformed messages.
    }
  });

  ws.on("close", () => {
    fastify.log.info("client disconnected");
  });
});

setInterval(() => {
  const now = Date.now();
  game.tick(now);

  const snapshot = JSON.stringify(game.snapshot());
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(snapshot); // WebSocket.OPEN
  }
}, 50);

try {
  await fastify.listen({ port: PORT, host: HOST });
  fastify.log.info(`Turn-based game available at http://localhost:${PORT}`);
} catch (error) {
  fastify.log.error(error);
  process.exit(1);
}
