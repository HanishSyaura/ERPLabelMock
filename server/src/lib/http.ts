import type { Request } from "express";
import { z } from "zod";
import { errors, type FieldIssue } from "./errors";

/** Success envelope: `{ data }`, plus `meta` for paged lists. */
export const ok = <T>(data: T, meta?: Record<string, unknown>) => (meta ? { data, meta } : { data });

export function zodIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

/** Parse request input with a zod schema or throw a 422 with field issues. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw errors.validation(zodIssues(result.error));
  return result.data;
}

export const body = <S extends z.ZodType>(req: Request, schema: S) => parse(schema, req.body ?? {});
export const query = <S extends z.ZodType>(req: Request, schema: S) => parse(schema, req.query);
export const params = <S extends z.ZodType>(req: Request, schema: S) => parse(schema, req.params);

/** Standard list query: ?page=1&pageSize=25&q=text&sort=field:asc */
export function listQuery<const F extends readonly [string, ...string[]]>(sortFields: F) {
  return z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
    q: z.string().trim().max(100).optional(),
    sort: z
      .string()
      .regex(/^[a-zA-Z]+:(asc|desc)$/)
      .optional()
      .transform((s) => {
        if (!s) return undefined;
        const [field, dir] = s.split(":") as [string, "asc" | "desc"];
        return (sortFields as readonly string[]).includes(field)
          ? { field: field as F[number], dir }
          : undefined;
      }),
  });
}

export const pageMeta = (page: number, pageSize: number, total: number) => ({
  page,
  pageSize,
  total,
  pageCount: Math.max(1, Math.ceil(total / pageSize)),
});

export const idParam = z.object({ id: z.uuid() });
