/**
 * Server for the real-time tactical front end.
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
import {
  configureDungeon,
  configureEditorDungeon,
  PLAYER_MAX_HEALTH,
  type EditorDungeonConfig,
  type TacticsInput,
} from "../shared/tactics.js";

/** Its own port, so 3000 (2D) and 3200 (3D) can keep running alongside it. */
const PORT = Number(process.env.PORT ?? 3300);
const HOST = process.env.HOST ?? "0.0.0.0";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const sharedTextureDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "public", "textures");
const sharedModelDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "public", "models");

const fastify = Fastify({ logger: true });

await fastify.register(fastifyStatic, { root: publicDir });
await fastify.register(fastifyStatic, {
  root: sharedTextureDir,
  prefix: "/shared-textures/",
  decorateReply: false,
});
await fastify.register(fastifyStatic, {
  root: sharedModelDir,
  prefix: "/shared-models/",
  decorateReply: false,
});

let game: TacticsGame | null = null;
let activeSeed: number | null = null;
let activeEditorLevel: string | null = null;
const editorLevels = new Map<string, EditorDungeonConfig>();

fastify.post<{ Body: EditorDungeonConfig }>("/api/editor-level", async (request, reply) => {
  const level = request.body;
  if (!level || level.version !== 1 || !Array.isArray(level.tiles) || !Array.isArray(level.entities)) {
    return reply.code(400).send({ error: "Invalid editor level" });
  }
  const id = Math.random().toString(36).slice(2, 10);
  editorLevels.set(id, level);
  return { id };
});

// Use noServer mode so Fastify doesn't intercept the upgrade request.
const wss = new WebSocketServer({ noServer: true });

fastify.server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws, request) => {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const editorLevelId = requestUrl.searchParams.get("editor");
  const editorLevel = editorLevelId ? editorLevels.get(editorLevelId) : undefined;
  const rawSeed = requestUrl.searchParams.get("seed");
  const seed = Number(rawSeed);
  const validSeed = Number.isSafeInteger(seed) && seed >= 1 && seed <= 0xffffffff ? seed : 1;
  const healthProtocol = request.headers["sec-websocket-protocol"]?.split(",")
    .map((protocol) => protocol.trim())
    .find((protocol) => /^health-\d+$/.test(protocol));
  const requestedHealth = Number(healthProtocol?.slice("health-".length));
  const initialHealth = Number.isFinite(requestedHealth) && requestedHealth > 0
    ? Math.min(PLAYER_MAX_HEALTH, Math.round(requestedHealth))
    : PLAYER_MAX_HEALTH;
  if (!game || activeSeed !== validSeed || activeEditorLevel !== editorLevelId) {
    if (editorLevel) configureEditorDungeon(editorLevel);
    else configureDungeon(validSeed);
    game = new TacticsGame(Date.now(), initialHealth);
    activeSeed = validSeed;
    activeEditorLevel = editorLevel ? editorLevelId : null;
    fastify.log.info(editorLevel ? { editorLevelId } : { seed: validSeed }, editorLevel ? "loaded editor dungeon" : "generated dungeon");
  }
  fastify.log.info("client connected");

  // Send the latest snapshot immediately so the client doesn't start blank.
  ws.send(JSON.stringify(game.snapshot()));

  ws.on("message", (data) => {
    try {
      game?.handleInput(JSON.parse(String(data)) as TacticsInput);
    } catch {
      // Ignore malformed messages.
    }
  });

  ws.on("close", () => {
    fastify.log.info("client disconnected");
  });
});

setInterval(() => {
  if (!game) return;
  const now = Date.now();
  game.tick(now);

  const snapshot = JSON.stringify(game.snapshot());
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(snapshot); // WebSocket.OPEN
  }
}, 50);

try {
  await fastify.listen({ port: PORT, host: HOST });
  fastify.log.info(`Real-time tactical game available at http://localhost:${PORT}`);
} catch (error) {
  fastify.log.error(error);
  process.exit(1);
}
