import { API_BASE_PATH, createApp } from "./app";
import { loadConfig } from "./config/env";
import { createPasswordHasher } from "./lib/crypto";
import { createFileStore } from "./lib/file-store";
import { createLogger } from "./lib/logger";
import { createPrisma } from "./lib/prisma";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, config.NODE_ENV === "development");
const db = createPrisma(config.DATABASE_URL, config.DATABASE_POOL_MAX);
const app = createApp({
  config,
  db,
  logger,
  hasher: createPasswordHasher(config.PASSWORD_PEPPER),
  files: createFileStore(config.UPLOAD_DIR),
  now: () => new Date(),
});

const server = app.listen(config.PORT, "127.0.0.1", () => {
  logger.info(`API listening on http://127.0.0.1:${config.PORT}${API_BASE_PATH}`);
});

const shutdown = async (signal: string) => {
  logger.info(`${signal} received, shutting down`);
  server.close();
  await db.$disconnect();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
