import { loadConfig } from "../config/env";
import { syncReferenceData } from "../database/reference";
import { createPrisma } from "../lib/prisma";

/** npm --prefix server run db:seed - reference data only, no business records. */
const config = loadConfig();
const db = createPrisma(config.DATABASE_URL, 2);
try {
  const summary = await syncReferenceData(db);
  console.log("Reference data synced:", summary);
} finally {
  await db.$disconnect();
}
