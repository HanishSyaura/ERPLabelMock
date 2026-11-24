import { z } from "zod";
import { q } from "../../lib/qty";

/** Shared zod pieces for the master data routes. */

/** Optional text; "" becomes null. */
export const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

/** Immutable master code: letters, digits and . _ - /, stored upper-case. */
export const code = (max: number, label = "code") =>
  z
    .string()
    .trim()
    .min(1, `Enter the ${label}`)
    .max(max)
    .regex(/^[A-Za-z0-9._\-/]+$/, "Letters, numbers and . _ - / only")
    .transform((v) => v.toUpperCase());

/**
 * Optional positive measurement (mm, m, micron, gsm) with at most `scale`
 * decimals and `intDigits` whole digits. "" / null = not recorded. Returned as
 * a canonical string ("80.50" -> "80.5") so audit diffs compare cleanly.
 */
export const measure = (intDigits: number, scale: number, label: string, allowZero = false) =>
  z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      if (v === null || String(v).trim() === "") return null;
      const s = String(v).trim();
      const re = new RegExp(`^\\d{1,${intDigits}}(\\.\\d{1,${scale}})?$`);
      if (!re.test(s) || (allowZero ? Number(s) < 0 : Number(s) <= 0)) {
        ctx.addIssue({ code: "custom", message: `Enter ${label}${allowZero ? "" : " greater than 0"} (max ${scale} decimals)` });
        return z.NEVER;
      }
      return q(s);
    });

/** Required positive measurement. */
export const requiredMeasure = (intDigits: number, scale: number, label: string) =>
  measure(intDigits, scale, label).transform((v, ctx) => {
    if (v === null || v === undefined) {
      ctx.addIssue({ code: "custom", message: `Enter ${label}` });
      return z.NEVER;
    }
    return v;
  });

/** Optional whole number in a range; "" / null = not recorded. */
export const wholeNumber = (min: number, max: number, label: string) =>
  z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      if (v === null || String(v).trim() === "") return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: "custom", message: `Enter ${label} between ${min} and ${max}` });
        return z.NEVER;
      }
      return n;
    });

export const statusSchema = z.object({ status: z.enum(["ACTIVE", "INACTIVE"]) });

/** Decimal columns as canonical strings for API output and audit. */
export const dec = (v: { toString(): string } | null | undefined) => (v === null || v === undefined ? null : q(v.toString()));
