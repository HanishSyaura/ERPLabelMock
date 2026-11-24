import type { Tx } from "./prisma";
import { errors } from "./errors";

/**
 * Next document number for a sequence (e.g. BOM -> "BOM-000123",
 * yearly PJO -> "PJO-2026-0001"). Call inside the transaction that creates
 * the record: the row lock serialises concurrent creators.
 */
export async function nextNumber(tx: Tx, key: string, now: Date): Promise<string> {
  const rows = await tx.$queryRaw<{ prefix: string; padding: number; next_value: number; yearly: number; year: number | null }[]>`
    SELECT prefix, padding, next_value, yearly, year FROM number_sequences WHERE \`key\` = ${key} FOR UPDATE`;
  const seq = rows[0];
  if (!seq) throw errors.badRequest(`Number sequence "${key}" is not configured.`);
  const year = now.getUTCFullYear();
  let value = Number(seq.next_value);
  if (seq.yearly && seq.year !== year) value = 1;
  await tx.numberSequence.update({ where: { key }, data: { nextValue: value + 1, year: seq.yearly ? year : null } });
  const num = String(value).padStart(Number(seq.padding), "0");
  return seq.yearly ? `${seq.prefix}-${year}-${num}` : `${seq.prefix}-${num}`;
}

/** Sequences the system ships with (inserted by the seed when missing). */
export const NUMBER_SEQUENCES = [
  { key: "BOM", prefix: "BOM", padding: 6, yearly: false },
  { key: "PJO", prefix: "PJO", padding: 5, yearly: true },
  { key: "JO", prefix: "JO", padding: 5, yearly: true },
  { key: "MRS", prefix: "MRS", padding: 5, yearly: true },
  { key: "WIP", prefix: "WIP", padding: 7, yearly: true },
  { key: "SES", prefix: "S", padding: 6, yearly: true },
  { key: "BRK", prefix: "BD", padding: 5, yearly: true },
  { key: "ISS", prefix: "ISS", padding: 6, yearly: true },
  { key: "MAI", prefix: "MAI", padding: 5, yearly: true },
  { key: "MRR", prefix: "MRR", padding: 5, yearly: true },
  { key: "MRJ", prefix: "MRJ", padding: 5, yearly: true },
  { key: "SCR", prefix: "SCR", padding: 5, yearly: true },
  { key: "IQC", prefix: "IQC", padding: 5, yearly: true },
  { key: "OQC", prefix: "OQC", padding: 5, yearly: true },
  { key: "LBL", prefix: "LBL", padding: 7, yearly: true },
] as const;
