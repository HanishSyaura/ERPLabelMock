import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { REDACT_PATHS } from "../src/lib/logger";
import { loadConfig } from "../src/config/env";

describe("logging and configuration", () => {
  it("redacts secret-bearing fields", () => {
    let out = "";
    const sink = new Writable({ write: (chunk, _e, cb) => ((out += chunk.toString()), cb()) });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: "[redacted]" } }, sink);
    log.info({ password: "p1", user: { passwordHash: "h", token: "t" }, req: { headers: { cookie: "c=1" } } }, "x");
    expect(out).not.toMatch(/p1|"h"|"t"|c=1/);
    expect(out).toContain("[redacted]");
  });

  it("refuses unsafe production settings", () => {
    const base = { DATABASE_URL: "mysql://u:p@h:3306/db", PASSWORD_PEPPER: "change-me-to-a-long-random-string-0000" };
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow(/COOKIE_SECURE|PASSWORD_PEPPER/);
    expect(() => loadConfig({ ...base, NODE_ENV: "development" })).not.toThrow();
  });
});
