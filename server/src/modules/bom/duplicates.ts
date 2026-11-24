import type { DbOrTx } from "../../lib/prisma";
import { descriptionKey } from "./bom.rules";

export interface DuplicateMatch {
  bomId: string;
  fatherCode: string;
  labelDescription: string;
  artworkRevision: number | null;
  current: boolean;
}

export interface DuplicateWarning {
  type: "FILE_HASH" | "FILE_NAME" | "DESCRIPTION";
  message: string;
  matches: DuplicateMatch[];
}

/**
 * Possible duplicates - warnings only, never a block (legitimate repeats
 * exist). Checks the artwork file's checksum and name against every artwork
 * revision, and the label description against current Father Codes.
 */
export async function duplicateWarnings(
  db: DbOrTx,
  input: { fileId?: string; labelDescription?: string; excludeBomId?: string },
): Promise<DuplicateWarning[]> {
  const warnings: DuplicateWarning[] = [];
  const exclude = input.excludeBomId ? { bomId: { not: input.excludeBomId } } : {};

  const toMatches = (revs: { revisionNo: number; bom: { id: string; fatherCode: string; labelDescription: string; currentArtworkRevNo: number } }[]) => {
    const seen = new Map<string, DuplicateMatch>();
    for (const r of revs) {
      const prev = seen.get(r.bom.id);
      const current = r.revisionNo === r.bom.currentArtworkRevNo;
      if (!prev || (current && !prev.current)) {
        seen.set(r.bom.id, { bomId: r.bom.id, fatherCode: r.bom.fatherCode, labelDescription: r.bom.labelDescription, artworkRevision: r.revisionNo, current });
      }
    }
    return [...seen.values()];
  };
  const revSelect = { revisionNo: true, bom: { select: { id: true, fatherCode: true, labelDescription: true, currentArtworkRevNo: true } } } as const;

  if (input.fileId) {
    const file = await db.storedFile.findUnique({ where: { id: input.fileId } });
    if (file) {
      const sameHash = await db.bomArtworkRevision.findMany({
        where: { ...exclude, file: { sha256: file.sha256 }, NOT: { fileId: file.id } },
        select: revSelect,
        take: 20,
      });
      if (sameHash.length) {
        warnings.push({ type: "FILE_HASH", message: "The same artwork file (identical content) is already used.", matches: toMatches(sameHash) });
      }
      const sameName = await db.bomArtworkRevision.findMany({
        where: { ...exclude, file: { originalName: file.originalName, sha256: { not: file.sha256 } } },
        select: revSelect,
        take: 20,
      });
      if (sameName.length) {
        warnings.push({ type: "FILE_NAME", message: `An artwork file named "${file.originalName}" is already used (different content).`, matches: toMatches(sameName) });
      }
    }
  }

  if (input.labelDescription?.trim()) {
    const key = descriptionKey(input.labelDescription);
    const same = await db.bom.findMany({
      where: { descriptionKey: key, ...(input.excludeBomId ? { id: { not: input.excludeBomId } } : {}) },
      select: { id: true, fatherCode: true, labelDescription: true, currentArtworkRevNo: true },
      take: 20,
    });
    if (same.length) {
      warnings.push({
        type: "DESCRIPTION",
        message: "A Father Code with the same label description already exists.",
        matches: same.map((b) => ({ bomId: b.id, fatherCode: b.fatherCode, labelDescription: b.labelDescription, artworkRevision: b.currentArtworkRevNo, current: true })),
      });
    }
  }
  return warnings;
}
