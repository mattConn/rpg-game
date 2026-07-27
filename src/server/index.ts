import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

// Single-player: the server only serves the game's static files. There is no
// websocket and no shared state — the whole game runs in the browser.
const fastify = Fastify({ logger: true });

await fastify.register(fastifyStatic, { root: publicDir });

try {
  await fastify.listen({ port: PORT, host: HOST });
  fastify.log.info(`game available at http://localhost:${PORT}`);
} catch (error) {
  fastify.log.error(error);
  process.exit(1);
}
