import { loadConfig } from "../config/env";
import { createFileStore } from "../lib/file-store";
import { createPrisma } from "../lib/prisma";

/**
 * Daily maintenance (schedule it in production):
 * - delete sessions that ended more than 30 days ago,
 * - delete artwork uploads never attached to a revision (older than 24 h),
 *   database row and bytes. Attached files are never touched.
 */
const config = loadConfig();
const db = createPrisma(config.DATABASE_URL, 2);
const files = createFileStore(config.UPLOAD_DIR);
const now = Date.now();
try {
  const sessions = await db.session.deleteMany({
    where: { OR: [{ expiresAt: { lt: new Date(now - 30 * 86_400_000) } }, { revokedAt: { lt: new Date(now - 30 * 86_400_000) } }] },
  });
  const orphans = await db.storedFile.findMany({ where: { attachedAt: null, createdAt: { lt: new Date(now - 86_400_000) } } });
  for (const f of orphans) {
    await files.remove(f.storageKey);
    if (f.thumbnailKey) await files.remove(f.thumbnailKey);
    await db.storedFile.delete({ where: { id: f.id } });
  }
  console.log(`Housekeeping: ${sessions.count} old sessions, ${orphans.length} unattached uploads removed.`);
} finally {
  await db.$disconnect();
}
