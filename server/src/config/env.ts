import { z } from "zod";

/**
 * The only place that reads process.env. Every new variable goes here and
 * into .env.example (placeholders only).
 */
const boolish = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().startsWith("mysql://"),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    PASSWORD_PEPPER: z.string().min(32, "PASSWORD_PEPPER must be at least 32 characters"),
    SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
    SESSION_IDLE_MINUTES: z.coerce.number().positive().default(120),
    /** Sign-in attempts allowed per IP address per 5 minutes. */
    LOGIN_IP_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(30),
    COOKIE_SECURE: boolish,
    CORS_ORIGINS: z
      .string()
      .default("")
      .transform((v) =>
        v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    UPLOAD_DIR: z.string().default("./storage/uploads"),
    /** Largest artwork file accepted, in MB. */
    ARTWORK_MAX_MB: z.coerce.number().int().min(1).max(500).default(50),
    /** Dev seed only (db:seed:dev): password for the role test accounts. Refused in production. */
    DEV_ACCOUNT_PASSWORD: z.string().min(10).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    if (!env.COOKIE_SECURE) {
      ctx.addIssue({ code: "custom", path: ["COOKIE_SECURE"], message: "must be true in production" });
    }
    if (env.PASSWORD_PEPPER.startsWith("change-me")) {
      ctx.addIssue({ code: "custom", path: ["PASSWORD_PEPPER"], message: "placeholder pepper in production" });
    }
  });

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
