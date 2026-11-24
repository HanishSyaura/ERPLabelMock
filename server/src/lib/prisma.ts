import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../generated/prisma/client";

export type Db = PrismaClient;
/** Interactive transaction client. */
export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export function createPrisma(databaseUrl: string, poolMax: number): PrismaClient {
  const url = new URL(databaseUrl);
  const adapter = new PrismaMariaDb({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    connectionLimit: poolMax,
    // MySQL 8 default auth (caching_sha2_password) over a non-TLS local link.
    allowPublicKeyRetrieval: true,
    timezone: "Z",
  });
  return new PrismaClient({ adapter });
}
