import { Prisma } from "../generated/prisma/client";

/**
 * Production quantities are DECIMAL(18,4). Arithmetic uses Prisma.Decimal so
 * large label counts never lose precision; API output uses canonical strings.
 */
export type Qty = Prisma.Decimal;
type QtyValue = string | number | Prisma.Decimal;
export const D = (v: QtyValue | null | undefined) => new Prisma.Decimal(v ?? 0);
export const ZERO = D(0);
export const maxQ = (a: Qty, b: Qty) => (a.greaterThan(b) ? a : b);

/** "1250.5000" -> "1250.5" */
export const q = (v: QtyValue | null | undefined): string => {
  const s = D(v).toFixed(4);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
};

/** Accepts number or numeric string >= 0 with at most 4 decimals. */
export const isQtyInput = (v: unknown) => {
  if (v === null || v === undefined || v === "") return false;
  const s = String(v).trim();
  return /^\d{1,14}(\.\d{1,4})?$/.test(s);
};
