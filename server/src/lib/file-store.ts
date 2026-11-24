import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import sharp from "sharp";
import { errors } from "./errors";

/**
 * Local file storage: random keys under UPLOAD_DIR, never the user's file
 * name. Metadata lives in `stored_files`; this module only handles bytes.
 */
export interface StoredBytes {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  head: Buffer;
}

export interface ArtworkType {
  extension: string;
  mimeType: string;
  previewKind: "image" | "pdf" | "none";
  /** Thumbnail can be generated server-side (sharp). */
  thumbnail: boolean;
}

export const ARTWORK_EXTENSIONS = ["pdf", "ai", "eps", "svg", "png", "jpg", "jpeg"] as const;

const startsWith = (buf: Buffer, bytes: number[]) => bytes.every((b, i) => buf[i] === b);
const ascii = (buf: Buffer, n: number) => buf.subarray(0, n).toString("latin1");

/**
 * Decide the artwork type from the extension AND the file's first bytes.
 * Returns null when they don't match (e.g. an .exe renamed to .pdf).
 */
export function detectArtworkType(fileName: string, head: Buffer): ArtworkType | null {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  const isPdf = ascii(head, 5) === "%PDF-";
  const isPostScript = ascii(head, 10) === "%!PS-Adobe";
  const isDosEps = startsWith(head, [0xc5, 0xd0, 0xd3, 0xc6]);
  switch (ext) {
    case "png":
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        ? { extension: "png", mimeType: "image/png", previewKind: "image", thumbnail: true }
        : null;
    case "jpg":
    case "jpeg":
      return startsWith(head, [0xff, 0xd8, 0xff]) ? { extension: ext, mimeType: "image/jpeg", previewKind: "image", thumbnail: true } : null;
    case "pdf":
      return isPdf ? { extension: "pdf", mimeType: "application/pdf", previewKind: "pdf", thumbnail: false } : null;
    case "ai":
      // Illustrator 9+ files are PDF-compatible; older ones are PostScript.
      if (isPdf) return { extension: "ai", mimeType: "application/pdf", previewKind: "pdf", thumbnail: false };
      return isPostScript ? { extension: "ai", mimeType: "application/postscript", previewKind: "none", thumbnail: false } : null;
    case "eps":
      return isPostScript || isDosEps ? { extension: "eps", mimeType: "application/postscript", previewKind: "none", thumbnail: false } : null;
    case "svg": {
      const text = head.toString("utf8").replace(/^﻿/, "");
      if (!/<svg[\s>]/i.test(text)) return null;
      // No DTD entities (entity expansion attacks).
      if (/<!ENTITY/i.test(text)) return null;
      return { extension: "svg", mimeType: "image/svg+xml", previewKind: "image", thumbnail: true };
    }
    default:
      return null;
  }
}

export function createFileStore(uploadDir: string) {
  const root = path.resolve(uploadDir);
  const pathOf = (key: string) => {
    if (!/^[a-z]+\/[A-Za-z0-9_-]+(\.thumb\.png)?$/.test(key)) throw new Error("invalid storage key");
    return path.join(root, key);
  };

  return {
    root,
    pathOf,

    /**
     * Stream a request body to disk under `folder/<random>`, hashing as it
     * goes and aborting past `maxBytes`. Returns the first 8 KB for type checks.
     */
    async saveStream(source: Readable, folder: string, maxBytes: number): Promise<StoredBytes> {
      await mkdir(path.join(root, folder), { recursive: true });
      const storageKey = `${folder}/${randomBytes(18).toString("base64url")}`;
      const finalPath = pathOf(storageKey);
      const tmpPath = `${finalPath}.part`;
      const hash = createHash("sha256");
      let size = 0;
      const headChunks: Buffer[] = [];
      let headLen = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (size > maxBytes) return cb(errors.rule("FILE_TOO_LARGE", `The file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`));
          if (headLen < 8192) {
            headChunks.push(chunk.subarray(0, 8192 - headLen));
            headLen += Math.min(chunk.length, 8192 - headLen);
          }
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      try {
        await pipeline(source, meter, createWriteStream(tmpPath));
        if (size === 0) throw errors.badRequest("The file is empty.");
        await rename(tmpPath, finalPath);
      } catch (e) {
        await rm(tmpPath, { force: true });
        throw e;
      }
      return { storageKey, sha256: hash.digest("hex"), sizeBytes: size, head: Buffer.concat(headChunks) };
    },

    /** 320 px PNG thumbnail next to the original. Returns null if the image can't be read. */
    async makeThumbnail(storageKey: string): Promise<string | null> {
      const thumbKey = `${storageKey}.thumb.png`;
      try {
        await sharp(pathOf(storageKey), { limitInputPixels: 268_402_689, density: 96 })
          .rotate()
          .resize(320, 320, { fit: "inside", withoutEnlargement: true })
          .flatten({ background: "#ffffff" })
          .png()
          .toFile(pathOf(thumbKey));
        return thumbKey;
      } catch {
        return null;
      }
    },

    async remove(storageKey: string) {
      await rm(pathOf(storageKey), { force: true });
    },

    async exists(storageKey: string) {
      try {
        return (await stat(pathOf(storageKey))).isFile();
      } catch {
        return false;
      }
    },

    read: (storageKey: string) => readFile(pathOf(storageKey)),
  };
}
export type FileStore = ReturnType<typeof createFileStore>;
