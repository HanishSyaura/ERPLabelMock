import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";

/** Random URL-safe token (default 32 bytes). */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** argon2id with a server-side pepper (never stored in the database). */
export function createPasswordHasher(pepper: string) {
  const peppered = (password: string) => `${password}\u0000${pepper}`;
  return {
    hash: (password: string) =>
      argon2.hash(peppered(password), { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
    verify: async (hash: string, password: string) => {
      try {
        return await argon2.verify(hash, peppered(password));
      } catch {
        return false;
      }
    },
  };
}
export type PasswordHasher = ReturnType<typeof createPasswordHasher>;

/** Password policy shared by create, reset and change. */
export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 10) problems.push("at least 10 characters");
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) problems.push("letters and numbers");
  if (password.length > 128) problems.push("at most 128 characters");
  return problems;
}
