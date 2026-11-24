import type { AppConfig } from "./config/env";
import type { PasswordHasher } from "./lib/crypto";
import type { FileStore } from "./lib/file-store";
import type { Logger } from "./lib/logger";
import type { Db } from "./lib/prisma";

/** Everything a route module needs. Built once in createApp(). */
export interface Deps {
  config: AppConfig;
  db: Db;
  hasher: PasswordHasher;
  logger: Logger;
  files: FileStore;
  /** Injectable clock (tests move time forward). */
  now: () => Date;
}
