import "dotenv/config";
import { defineConfig } from "prisma/config";

// The datasource URL is only needed by the CLI (migrate). `prisma generate`
// works without it, so typecheck/build run on machines without a database.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: process.env.DATABASE_URL ?? "mysql://placeholder@localhost:3306/placeholder",
  },
});
