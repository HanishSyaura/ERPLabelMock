import pino from "pino";

/**
 * Never log request bodies, passwords, tokens, cookies or connection strings.
 * Add any new secret-bearing field name here (tests/logger.test.ts).
 */
export const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  "password",
  "newPassword",
  "currentPassword",
  "passwordHash",
  "token",
  "csrfToken",
  "databaseUrl",
  "*.password",
  "*.newPassword",
  "*.currentPassword",
  "*.passwordHash",
  "*.token",
  "*.csrfToken",
];

export function createLogger(level: string, pretty: boolean) {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true, singleLine: true } } } : {}),
  });
}
export type Logger = ReturnType<typeof createLogger>;
