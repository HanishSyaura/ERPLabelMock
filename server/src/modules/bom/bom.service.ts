import type { Bom } from "../../generated/prisma/client";
import { errors } from "../../lib/errors";
import { nextNumber } from "../../lib/numbering";
import type { DbOrTx, Tx } from "../../lib/prisma";
import type { AuthUser, RequestContext } from "../../middleware/context";
import { recordAudit } from "../audit/audit.service";
import { cleanDescription, descriptionKey, diffLines, hasChanges, normQty, type ComponentChanges, type LineState } from "./bom.rules";

/**
 * Father Code / Son Code rules. Every write:
 *   lock the Father Code row -> check the caller's expected revision ->
 *   validate -> write a NEW immutable revision (never edit an old one) ->
 *   audit in the same transaction.
 * Artwork revisions and component revisions are independent: one never
 * changes the other.
 */

export interface Actor {
  user: AuthUser;
  ctx: RequestContext;
}

const audit = (tx: Tx, a: Actor, bom: { id: string; fatherCode: string }, action: string, extra: { previous?: unknown; next?: unknown; remarks?: string | null } = {}) =>
  recordAudit(tx, a.ctx, { module: "bom", action, entityType: "bom", entityId: bom.id, recordRef: bom.fatherCode, ...extra });

/** Lock the Father Code row for the rest of the transaction. */
async function lockBom(tx: Tx, bomId: string): Promise<Bom> {
  await tx.$queryRaw`SELECT id FROM boms WHERE id = ${bomId} FOR UPDATE`;
  const bom = await tx.bom.findUnique({ where: { id: bomId } });
  if (!bom) throw errors.notFound("Father Code");
  return bom;
}

function checkExpected(actual: number, expected: number | undefined, what: string) {
  if (expected !== undefined && expected !== actual) {
    throw errors.conflict(`The ${what} was changed by someone else (now revision ${actual}). Reload and try again.`, { currentRevision: actual });
  }
}

const requirePerm = (a: Actor, key: string, message: string) => {
  if (!a.user.permissions.has(key)) throw errors.forbidden(message);
};

/** A file the caller just uploaded and that isn't part of any revision yet. */
async function claimUpload(tx: Tx, a: Actor, fileId: string) {
  const file = await tx.storedFile.findUnique({ where: { id: fileId } });
  if (!file || file.purpose !== "ARTWORK") throw errors.validation([{ path: "fileId", message: "Upload the artwork file first" }]);
  if (file.attachedAt) throw errors.validation([{ path: "fileId", message: "This upload is already used by a revision. Upload the file again." }]);
  if (file.uploadedById !== a.user.id) throw errors.forbidden("You can only use artwork files you uploaded.");
  return file;
}

// ---------------------------------------------------------------------------
// Father Code + artwork revisions
// ---------------------------------------------------------------------------

export async function createFatherCode(tx: Tx, a: Actor, input: { fileId: string; labelDescription: string; changeNote?: string | null }, now: Date) {
  const labelDescription = cleanDescription(input.labelDescription);
  const file = await claimUpload(tx, a, input.fileId);
  const fatherCode = await nextNumber(tx, "BOM", now);
  const bom = await tx.bom.create({
    data: {
      fatherCode,
      labelDescription,
      descriptionKey: descriptionKey(labelDescription),
      currentArtworkRevNo: 1,
      createdById: a.user.id,
      updatedById: a.user.id,
    },
  });
  await tx.bomArtworkRevision.create({
    data: { bomId: bom.id, revisionNo: 1, labelDescription, fileId: file.id, changeType: "CREATED", changeNote: input.changeNote ?? null, createdById: a.user.id },
  });
  await tx.storedFile.update({ where: { id: file.id }, data: { attachedAt: now } });
  await audit(tx, a, bom, "FATHER_CODE_CREATED", {
    next: { fatherCode, labelDescription, artworkRevision: 1, artworkFile: file.originalName, sha256: file.sha256 },
  });
  return bom;
}

export async function reviseArtwork(
  tx: Tx,
  a: Actor,
  bomId: string,
  input: { fileId?: string; labelDescription?: string; changeNote?: string | null; expectedArtworkRevNo?: number },
  now: Date,
) {
  const bom = await lockBom(tx, bomId);
  checkExpected(bom.currentArtworkRevNo, input.expectedArtworkRevNo, "artwork");
  const current = await tx.bomArtworkRevision.findUniqueOrThrow({
    where: { bomId_revisionNo: { bomId, revisionNo: bom.currentArtworkRevNo } },
    include: { file: true },
  });

  let newFile = null;
  if (input.fileId) {
    const file = await claimUpload(tx, a, input.fileId);
    // Re-uploading the identical file is not a change.
    if (file.sha256 !== current.file.sha256) newFile = file;
  }
  const newDescription = input.labelDescription !== undefined ? cleanDescription(input.labelDescription) : current.labelDescription;
  const descChanged = newDescription !== current.labelDescription;
  if (!newFile && !descChanged) return { bom, changed: false as const };

  if (newFile) requirePerm(a, "bom.artwork.upload", "You don't have permission to replace artwork.");
  if (descChanged) requirePerm(a, "bom.edit", "You don't have permission to change the label description.");

  const revisionNo = bom.currentArtworkRevNo + 1;
  const changeType = newFile && descChanged ? "ARTWORK_AND_DESCRIPTION" : newFile ? "ARTWORK_REPLACED" : "DESCRIPTION_CHANGED";
  await tx.bomArtworkRevision.create({
    data: {
      bomId,
      revisionNo,
      labelDescription: newDescription,
      fileId: newFile?.id ?? current.fileId,
      changeType,
      changeNote: input.changeNote ?? null,
      createdById: a.user.id,
    },
  });
  if (newFile) await tx.storedFile.update({ where: { id: newFile.id }, data: { attachedAt: now } });
  const updated = await tx.bom.update({
    where: { id: bomId },
    data: { currentArtworkRevNo: revisionNo, labelDescription: newDescription, descriptionKey: descriptionKey(newDescription), updatedById: a.user.id },
  });
  await audit(tx, a, bom, changeType === "DESCRIPTION_CHANGED" ? "LABEL_DESCRIPTION_CHANGED" : "ARTWORK_REPLACED", {
    previous: { artworkRevision: current.revisionNo, ...(newFile ? { artworkFile: current.file.originalName } : {}), ...(descChanged ? { labelDescription: current.labelDescription } : {}) },
    next: { artworkRevision: revisionNo, ...(newFile ? { artworkFile: newFile.originalName, sha256: newFile.sha256 } : {}), ...(descChanged ? { labelDescription: newDescription } : {}) },
    remarks: input.changeNote ?? null,
  });
  return { bom: updated, changed: true as const };
}

/** Make an older artwork revision current again - as a NEW revision (history kept). */
export async function restoreArtwork(tx: Tx, a: Actor, bomId: string, input: { revisionNo: number; changeNote?: string | null; expectedArtworkRevNo?: number }) {
  const bom = await lockBom(tx, bomId);
  checkExpected(bom.currentArtworkRevNo, input.expectedArtworkRevNo, "artwork");
  const [source, current] = await Promise.all([
    tx.bomArtworkRevision.findUnique({ where: { bomId_revisionNo: { bomId, revisionNo: input.revisionNo } }, include: { file: true } }),
    tx.bomArtworkRevision.findUniqueOrThrow({ where: { bomId_revisionNo: { bomId, revisionNo: bom.currentArtworkRevNo } }, include: { file: true } }),
  ]);
  if (!source) throw errors.notFound(`Artwork revision ${input.revisionNo}`);
  if (source.file.sha256 === current.file.sha256 && source.labelDescription === current.labelDescription) {
    throw errors.rule("NO_CHANGE", `Revision ${input.revisionNo} has the same artwork and description as the current revision.`);
  }
  const revisionNo = bom.currentArtworkRevNo + 1;
  await tx.bomArtworkRevision.create({
    data: {
      bomId,
      revisionNo,
      labelDescription: source.labelDescription,
      fileId: source.fileId,
      changeType: "RESTORED",
      restoredFromRevisionNo: source.revisionNo,
      changeNote: input.changeNote ?? null,
      createdById: a.user.id,
    },
  });
  const updated = await tx.bom.update({
    where: { id: bomId },
    data: { currentArtworkRevNo: revisionNo, labelDescription: source.labelDescription, descriptionKey: descriptionKey(source.labelDescription), updatedById: a.user.id },
  });
  await audit(tx, a, bom, "ARTWORK_REVISION_RESTORED", {
    previous: { artworkRevision: current.revisionNo, artworkFile: current.file.originalName, labelDescription: current.labelDescription },
    next: { artworkRevision: revisionNo, restoredFrom: source.revisionNo, artworkFile: source.file.originalName, labelDescription: source.labelDescription },
    remarks: input.changeNote ?? null,
  });
  return updated;
}

export async function setStatus(tx: Tx, a: Actor, bomId: string, status: "ACTIVE" | "INACTIVE", reason?: string | null) {
  const bom = await lockBom(tx, bomId);
  if (bom.status === status) return bom;
  const updated = await tx.bom.update({ where: { id: bomId }, data: { status, updatedById: a.user.id } });
  await audit(tx, a, bom, status === "ACTIVE" ? "FATHER_CODE_ACTIVATED" : "FATHER_CODE_DEACTIVATED", {
    previous: { status: bom.status },
    next: { status },
    remarks: reason ?? null,
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Son Codes + component revisions
// ---------------------------------------------------------------------------

/** Lines of the current component revision (empty before the first one). */
export async function currentLines(db: DbOrTx, bom: Pick<Bom, "id" | "currentComponentRevNo">): Promise<LineState[]> {
  if (bom.currentComponentRevNo === 0) return [];
  const rev = await db.bomComponentRevision.findUniqueOrThrow({
    where: { bomId_revisionNo: { bomId: bom.id, revisionNo: bom.currentComponentRevNo } },
    include: { lines: { include: { sonCode: true }, orderBy: { lineNo: "asc" } } },
  });
  return rev.lines.map((l) => ({
    sonCodeId: l.sonCodeId,
    sonCode: l.sonCode.sonCode,
    materialId: l.materialId,
    materialCode: l.materialCode,
    materialDescription: l.materialDescription,
    quantity: normQty(l.quantity),
    uom: l.uom,
    remarks: l.remarks,
  }));
}

async function writeComponentRevision(
  tx: Tx,
  a: Actor,
  bom: Bom,
  lines: LineState[],
  changes: ComponentChanges,
  changeType: string,
  changeNote: string | null | undefined,
  restoredFromRevisionNo?: number,
) {
  const revisionNo = bom.currentComponentRevNo + 1;
  const rev = await tx.bomComponentRevision.create({
    data: {
      bomId: bom.id,
      revisionNo,
      changeType,
      changes: changes as never,
      changeNote: changeNote ?? null,
      restoredFromRevisionNo: restoredFromRevisionNo ?? null,
      createdById: a.user.id,
    },
  });
  if (lines.length) {
    await tx.bomComponentLine.createMany({
      data: lines.map((l, i) => ({
        revisionId: rev.id,
        sonCodeId: l.sonCodeId,
        lineNo: i + 1,
        materialId: l.materialId,
        materialCode: l.materialCode,
        materialDescription: l.materialDescription,
        quantity: l.quantity,
        uom: l.uom,
        remarks: l.remarks,
      })),
    });
  }
  await tx.bom.update({ where: { id: bom.id }, data: { currentComponentRevNo: revisionNo, updatedById: a.user.id } });
  return revisionNo;
}

async function activeMaterials(tx: Tx, ids: string[]) {
  const materials = await tx.material.findMany({ where: { id: { in: [...new Set(ids)] } } });
  const byId = new Map(materials.map((m) => [m.id, m]));
  for (const id of ids) {
    const m = byId.get(id);
    if (!m) throw errors.validation([{ path: "materialId", message: "Material not found" }]);
    if (m.status !== "ACTIVE") throw errors.rule("MATERIAL_INACTIVE", `Material ${m.code} is inactive. Reactivate it in the material list first.`);
  }
  return byId;
}

/** Same material more than once in one BOM: allowed only when the user confirms. */
function duplicateMaterials(lines: LineState[]) {
  const byMaterial = new Map<string, LineState[]>();
  for (const l of lines) byMaterial.set(l.materialId, [...(byMaterial.get(l.materialId) ?? []), l]);
  return [...byMaterial.values()]
    .filter((ls) => ls.length > 1)
    .map((ls) => ({ materialCode: ls[0]!.materialCode, sonCodes: ls.map((l) => l.sonCode || "(new)") }));
}

function guardDuplicates(lines: LineState[], allowDuplicate: boolean | undefined, newMaterialIds: Set<string>) {
  const dups = duplicateMaterials(lines).filter((d) => lines.some((l) => l.materialCode === d.materialCode && newMaterialIds.has(l.materialId)));
  if (dups.length && !allowDuplicate) {
    throw errors.rule(
      "DUPLICATE_COMPONENT",
      `${dups.map((d) => d.materialCode).join(", ")} is already in this BOM. Confirm if the same component is really needed more than once.`,
      { duplicates: dups },
    );
  }
  return dups;
}

export interface LineInput {
  materialId: string;
  quantity?: string | number | null;
  uom?: string | null;
  remarks?: string | null;
}

export async function addSonCodes(
  tx: Tx,
  a: Actor,
  bomId: string,
  input: { lines: LineInput[]; allowDuplicate?: boolean; changeNote?: string | null; expectedComponentRevNo?: number },
) {
  const bom = await lockBom(tx, bomId);
  checkExpected(bom.currentComponentRevNo, input.expectedComponentRevNo, "component list");
  const current = await currentLines(tx, bom);
  const materials = await activeMaterials(tx, input.lines.map((l) => l.materialId));

  const fresh: LineState[] = input.lines.map((l, i) => {
    const m = materials.get(l.materialId)!;
    return {
      sonCodeId: "",
      sonCode: `${bom.fatherCode}-${String(bom.nextSonSeq + i).padStart(2, "0")}`,
      materialId: m.id,
      materialCode: m.code,
      materialDescription: m.description,
      quantity: normQty(l.quantity),
      uom: l.uom || m.uom,
      remarks: l.remarks?.trim() || null,
    };
  });
  const dups = guardDuplicates([...current, ...fresh], input.allowDuplicate, new Set(fresh.map((f) => f.materialId)));

  for (const [i, f] of fresh.entries()) {
    const son = await tx.bomSonCode.create({
      data: { bomId, sonCode: f.sonCode, seq: bom.nextSonSeq + i, materialId: f.materialId, createdById: a.user.id },
    });
    f.sonCodeId = son.id;
  }
  await tx.bom.update({ where: { id: bomId }, data: { nextSonSeq: bom.nextSonSeq + fresh.length } });
  const lines = [...current, ...fresh];
  const changes = diffLines(current, lines);
  const revisionNo = await writeComponentRevision(tx, a, bom, lines, changes, "ADDED", input.changeNote);
  await audit(tx, a, bom, "SON_CODES_ADDED", {
    previous: { componentRevision: bom.currentComponentRevNo },
    next: { componentRevision: revisionNo, added: changes.added },
    remarks: [input.changeNote, dups.length ? `Duplicate component confirmed: ${dups.map((d) => d.materialCode).join(", ")}` : null].filter(Boolean).join(" · ") || null,
  });
  return { revisionNo, sonCodes: fresh.map((f) => f.sonCode) };
}

export async function editSonCode(
  tx: Tx,
  a: Actor,
  bomId: string,
  sonCodeId: string,
  input: Partial<LineInput> & { allowDuplicate?: boolean; changeNote?: string | null; expectedComponentRevNo?: number },
) {
  const bom = await lockBom(tx, bomId);
  checkExpected(bom.currentComponentRevNo, input.expectedComponentRevNo, "component list");
  const current = await currentLines(tx, bom);
  const before = current.find((l) => l.sonCodeId === sonCodeId);
  if (!before) throw errors.rule("SON_CODE_NOT_ACTIVE", "This Son Code is not in the current component list.");

  const after: LineState = { ...before };
  if (input.materialId && input.materialId !== before.materialId) {
    const m = (await activeMaterials(tx, [input.materialId])).get(input.materialId)!;
    Object.assign(after, { materialId: m.id, materialCode: m.code, materialDescription: m.description });
    if (input.uom === undefined) after.uom = m.uom;
  }
  if (input.quantity !== undefined) after.quantity = normQty(input.quantity);
  if (input.uom !== undefined) after.uom = input.uom || null;
  if (input.remarks !== undefined) after.remarks = input.remarks?.trim() || null;

  const lines = current.map((l) => (l.sonCodeId === sonCodeId ? after : l));
  const changes = diffLines(current, lines);
  if (!hasChanges(changes)) return { revisionNo: bom.currentComponentRevNo, changed: false as const };
  if (after.materialId !== before.materialId) guardDuplicates(lines, input.allowDuplicate, new Set([after.materialId]));

  const revisionNo = await writeComponentRevision(tx, a, bom, lines, changes, "MODIFIED", input.changeNote);
  await audit(tx, a, bom, "SON_CODE_MODIFIED", {
    previous: { componentRevision: bom.currentComponentRevNo, sonCode: before.sonCode, ...changes.modified[0]!.before },
    next: { componentRevision: revisionNo, sonCode: before.sonCode, ...changes.modified[0]!.after },
    remarks: input.changeNote ?? null,
  });
  return { revisionNo, changed: true as const };
}

export async function removeSonCode(
  tx: Tx,
  a: Actor,
  bomId: string,
  sonCodeId: string,
  input: { changeNote?: string | null; expectedComponentRevNo?: number },
  now: Date,
) {
  const bom = await lockBom(tx, bomId);
  checkExpected(bom.currentComponentRevNo, input.expectedComponentRevNo, "component list");
  const current = await currentLines(tx, bom);
  const target = current.find((l) => l.sonCodeId === sonCodeId);
  if (!target) throw errors.rule("SON_CODE_NOT_ACTIVE", "This Son Code is not in the current component list.");
  const lines = current.filter((l) => l.sonCodeId !== sonCodeId);
  const changes = diffLines(current, lines);
  await tx.bomSonCode.update({ where: { id: sonCodeId }, data: { status: "REMOVED", removedAt: now, removedById: a.user.id } });
  const revisionNo = await writeComponentRevision(tx, a, bom, lines, changes, "REMOVED", input.changeNote);
  await audit(tx, a, bom, "SON_CODE_REMOVED", {
    previous: { componentRevision: bom.currentComponentRevNo, removed: changes.removed },
    next: { componentRevision: revisionNo },
    remarks: input.changeNote ?? null,
  });
  return { revisionNo };
}

/** Make an older component list current again - as a NEW revision. */
export async function restoreComponentRevision(
  tx: Tx,
  a: Actor,
  bomId: string,
  input: { revisionNo: number; changeNote?: string | null; expectedComponentRevNo?: number },
  now: Date,
) {
  const bom = await lockBom(tx, bomId);
  checkExpected(bom.currentComponentRevNo, input.expectedComponentRevNo, "component list");
  if (input.revisionNo < 1 || input.revisionNo >= bom.currentComponentRevNo) {
    throw errors.rule("INVALID_REVISION", `Choose an earlier component revision (1–${Math.max(1, bom.currentComponentRevNo - 1)}).`);
  }
  const current = await currentLines(tx, bom);
  const target = await currentLines(tx, { id: bom.id, currentComponentRevNo: input.revisionNo });
  await activeMaterials(tx, target.map((l) => l.materialId));
  const changes = diffLines(current, target);
  if (!hasChanges(changes)) throw errors.rule("NO_CHANGE", `Revision ${input.revisionNo} has the same component list as the current revision.`);

  const targetIds = new Set(target.map((l) => l.sonCodeId));
  const currentIds = new Set(current.map((l) => l.sonCodeId));
  const reactivate = target.filter((l) => !currentIds.has(l.sonCodeId)).map((l) => l.sonCodeId);
  const deactivate = current.filter((l) => !targetIds.has(l.sonCodeId)).map((l) => l.sonCodeId);
  if (reactivate.length) await tx.bomSonCode.updateMany({ where: { id: { in: reactivate } }, data: { status: "ACTIVE", removedAt: null, removedById: null } });
  if (deactivate.length) await tx.bomSonCode.updateMany({ where: { id: { in: deactivate } }, data: { status: "REMOVED", removedAt: now, removedById: a.user.id } });

  const revisionNo = await writeComponentRevision(tx, a, bom, target, changes, "RESTORED", input.changeNote, input.revisionNo);
  await audit(tx, a, bom, "COMPONENT_REVISION_RESTORED", {
    previous: { componentRevision: bom.currentComponentRevNo },
    next: { componentRevision: revisionNo, restoredFrom: input.revisionNo, ...changes },
    remarks: input.changeNote ?? null,
  });
  return { revisionNo };
}

// ---------------------------------------------------------------------------
// Production integration (used by Production Job Order in Phase 3)
// ---------------------------------------------------------------------------

/**
 * What a Production Job Order freezes when it is released: the exact Father
 * Code, artwork revision and component revision. Later BOM changes create new
 * revisions and never touch these rows.
 */
export async function productionSnapshot(db: DbOrTx, bomId: string) {
  const bom = await db.bom.findUnique({ where: { id: bomId } });
  if (!bom) throw errors.notFound("Father Code");
  if (bom.status !== "ACTIVE") throw errors.rule("BOM_INACTIVE", `Father Code ${bom.fatherCode} is inactive and can't be used for new production.`);
  const artwork = await db.bomArtworkRevision.findUniqueOrThrow({
    where: { bomId_revisionNo: { bomId, revisionNo: bom.currentArtworkRevNo } },
    include: { file: { select: { id: true, originalName: true, previewKind: true, thumbnailKey: true } } },
  });
  const component =
    bom.currentComponentRevNo > 0
      ? await db.bomComponentRevision.findUniqueOrThrow({
          where: { bomId_revisionNo: { bomId, revisionNo: bom.currentComponentRevNo } },
          include: { lines: { include: { sonCode: { select: { sonCode: true } } }, orderBy: { lineNo: "asc" } } },
        })
      : null;
  return {
    bomId: bom.id,
    fatherCode: bom.fatherCode,
    labelDescription: artwork.labelDescription,
    artworkRevision: { id: artwork.id, revisionNo: artwork.revisionNo, file: artwork.file },
    componentRevision: component
      ? {
          id: component.id,
          revisionNo: component.revisionNo,
          lines: component.lines.map((l) => ({
            sonCode: l.sonCode.sonCode,
            materialCode: l.materialCode,
            materialDescription: l.materialDescription,
            quantity: normQty(l.quantity),
            uom: l.uom,
          })),
        }
      : null,
  };
}
