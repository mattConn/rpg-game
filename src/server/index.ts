import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { WebSocketServer } from "ws";

import { GameSimulation } from "./game.js";
import type { InputMessage } from "../shared/protocol.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

const fastify = Fastify({ logger: true });

await fastify.register(fastifyStatic, { root: publicDir });

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
  fastify.log.info(`game available at http://localhost:${PORT}`);
} catch (error) {
  fastify.log.error(error);
  process.exit(1);
}
