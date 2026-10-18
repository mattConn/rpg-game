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
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { WebSocketServer } from "ws";

import { TacticsGame } from "./game.js";
import { editorDungeonSeed } from "../shared/editor-seed.js";
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
const defaultEditorDataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const editorProjectPath = process.env.EDITOR_PROJECT_PATH ?? join(defaultEditorDataDir, "editor-project.json");
const editorDataDir = dirname(editorProjectPath);
const editorProjectTempPath = `${editorProjectPath}.tmp`;

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

interface EditorProject {
  version: 1;
  activeRoom: string;
  rooms: Record<string, EditorDungeonConfig>;
}

const validEditorProject = (value: unknown): value is EditorProject => {
  if (!value || typeof value !== "object") return false;
  const project = value as Partial<EditorProject>;
  if (project.version !== 1 || !/^[0-9A-Za-z]$/.test(project.activeRoom ?? "") || !project.rooms || typeof project.rooms !== "object") return false;
  const entries = Object.entries(project.rooms);
  return entries.length > 0 && entries.every(([label, room]) => /^[0-9A-Za-z]$/.test(label)
    && room?.version === 1 && Array.isArray(room.tiles) && Array.isArray(room.entities));
};

fastify.get("/api/editor-project", async (_request, reply) => {
  try {
    const project = JSON.parse(await readFile(editorProjectPath, "utf8")) as unknown;
    if (!validEditorProject(project)) return reply.code(500).send({ error: "Saved editor project is invalid" });
    return project;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return reply.code(404).send({ error: "No editor project saved" });
    fastify.log.error(error, "could not read editor project");
    return reply.code(500).send({ error: "Could not read editor project" });
  }
});

fastify.put<{ Body: unknown }>("/api/editor-project", async (request, reply) => {
  if (!validEditorProject(request.body)) return reply.code(400).send({ error: "Invalid editor project" });
  try {
    await mkdir(editorDataDir, { recursive: true });
    await writeFile(editorProjectTempPath, `${JSON.stringify(request.body, null, 2)}\n`, "utf8");
    await rename(editorProjectTempPath, editorProjectPath);
    return { saved: true, path: editorProjectPath, rooms: Object.keys(request.body.rooms).length };
  } catch (error) {
    fastify.log.error(error, "could not save editor project");
    return reply.code(500).send({ error: "Could not save editor project" });
  }
});

fastify.post<{ Body: EditorDungeonConfig }>("/api/editor-level", async (request, reply) => {
  const level = request.body;
  if (!level || level.version !== 1 || !Array.isArray(level.tiles) || !Array.isArray(level.entities)) {
    return reply.code(400).send({ error: "Invalid editor level" });
  }
  const seed = editorDungeonSeed(level);
  const id = String(seed);
  editorLevels.set(id, level);
  return { id, seed };
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
  // A self-linked authored exit reconnects with the same seed and editor id.
  // Never reuse the completed instance in that case: its first snapshot still
  // carries nextDungeonSeed and would immediately redirect the client forever.
  const completedTransition = game?.snapshot().nextDungeonSeed !== null;
  if (!game || activeSeed !== validSeed || activeEditorLevel !== editorLevelId || completedTransition) {
    if (editorLevel) configureEditorDungeon(editorLevel);
    else configureDungeon(validSeed);
    game = new TacticsGame(Date.now(), initialHealth);
    activeSeed = validSeed;
    activeEditorLevel = editorLevel ? editorLevelId : null;
    fastify.log.info(editorLevel
      ? { editorLevelId, resetAfterTransition: completedTransition }
      : { seed: validSeed, resetAfterTransition: completedTransition }, editorLevel ? "loaded editor dungeon" : "generated dungeon");
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
