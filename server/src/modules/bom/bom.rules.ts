/**
 * Pure BOM rules (no database): description normalisation, quantity
 * normalisation and component-list diffs. Covered by tests/bom.test.ts.
 */

/** Trim and collapse whitespace. Whitespace-only edits are not "material" changes. */
export const cleanDescription = (s: string) => s.trim().replace(/\s+/g, " ");

/** Key for duplicate detection: cleaned + lower case. */
export const descriptionKey = (s: string) => cleanDescription(s).toLowerCase();

/** Decimal(18,4) as a canonical string ("12.5000" -> "12.5"), or null. */
export function normQty(q: string | number | null | undefined | { toString(): string }): string | null {
  if (q === null || q === undefined || q === "") return null;
  const n = Number(q.toString());
  if (!Number.isFinite(n)) return null;
  return n.toFixed(4).replace(/\.?0+$/, "");
}

export interface LineState {
  sonCodeId: string;
  sonCode: string;
  materialId: string;
  materialCode: string;
  materialDescription: string;
  quantity: string | null;
  uom: string | null;
  remarks: string | null;
}

const COMPARED = ["materialId", "quantity", "uom", "remarks"] as const;
type Compared = (typeof COMPARED)[number];

export interface LineChange {
  sonCode: string;
  materialCode: string;
  materialDescription: string;
  quantity: string | null;
  uom: string | null;
  remarks: string | null;
}

export interface ComponentChanges {
  added: LineChange[];
  modified: { sonCode: string; before: Partial<LineChange>; after: Partial<LineChange> }[];
  removed: LineChange[];
}

const view = (l: LineState): LineChange => ({
  sonCode: l.sonCode,
  materialCode: l.materialCode,
  materialDescription: l.materialDescription,
  quantity: l.quantity,
  uom: l.uom,
  remarks: l.remarks,
});

/** Fields of a line that differ (materialId is reported as code + description). */
export function lineDiff(before: LineState, after: LineState) {
  const changed = COMPARED.filter((k: Compared) => (before[k] ?? null) !== (after[k] ?? null));
  if (!changed.length) return null;
  const pick = (l: LineState): Partial<LineChange> => {
    const out: Partial<LineChange> = {};
    for (const k of changed) {
      if (k === "materialId") {
        out.materialCode = l.materialCode;
        out.materialDescription = l.materialDescription;
      } else out[k] = l[k];
    }
    return out;
  };
  return { sonCode: after.sonCode, before: pick(before), after: pick(after) };
}

/** Added / modified / removed between two component lists (matched by Son Code). */
export function diffLines(current: LineState[], next: LineState[]): ComponentChanges {
  const cur = new Map(current.map((l) => [l.sonCodeId, l]));
  const nxt = new Map(next.map((l) => [l.sonCodeId, l]));
  const changes: ComponentChanges = { added: [], modified: [], removed: [] };
  for (const l of next) {
    const before = cur.get(l.sonCodeId);
    if (!before) changes.added.push(view(l));
    else {
      const d = lineDiff(before, l);
      if (d) changes.modified.push(d);
    }
  }
  for (const l of current) if (!nxt.has(l.sonCodeId)) changes.removed.push(view(l));
  return changes;
}

export const hasChanges = (c: ComponentChanges) => c.added.length + c.modified.length + c.removed.length > 0;
