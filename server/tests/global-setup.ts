import { execSync } from "node:child_process";
import "dotenv/config";

/** Applies migrations to the test database once per run. */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see server/.env.example).");
  const name = new URL(url).pathname.slice(1);
  if (!name.endsWith("_test")) throw new Error(`TEST_DATABASE_URL must point at a *_test database (got "${name}").`);
  execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: url } });
}
