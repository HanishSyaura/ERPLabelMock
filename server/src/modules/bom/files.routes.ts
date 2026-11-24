import path from "node:path";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Deps } from "../../deps";
import { errors } from "../../lib/errors";
import { detectArtworkType, ARTWORK_EXTENSIONS } from "../../lib/file-store";
import { idParam, ok, params, query } from "../../lib/http";
import { requireAnyPermission, requirePermission } from "../../middleware/auth";
import { requireUser } from "../../middleware/context";
import { duplicateWarnings } from "./duplicates";

/**
 * Artwork files. Upload = one raw request per file (Content-Type
 * application/octet-stream, file name in X-File-Name, URL-encoded), so large
 * files stream to disk instead of being buffered. The upload is not part of
 * any BOM until a create / replace request attaches it.
 */
export function bomFileRoutes(deps: Deps) {
  const r = Router();
  const { db, files, config } = deps;

  r.post("/", requireAnyPermission("bom.create", "bom.artwork.upload", "bom.material.manage"), async (req, res) => {
    const user = requireUser(req);
    const rawName = req.header("x-file-name");
    let fileName = "";
    try {
      fileName = rawName ? decodeURIComponent(rawName) : "";
    } catch {
      fileName = "";
    }
    fileName = path.basename(fileName).replace(/[\u0000-\u001f]/g, "").slice(0, 255);
    const ext = path.extname(fileName).slice(1).toLowerCase();
    const maxBytes = config.ARTWORK_MAX_MB * 1024 * 1024;
    if (!fileName || !(ARTWORK_EXTENSIONS as readonly string[]).includes(ext)) {
      await drain(req, maxBytes);
      throw errors.rule("UNSUPPORTED_FILE", `Upload a ${ARTWORK_EXTENSIONS.filter((e) => e !== "jpeg").map((e) => e.toUpperCase()).join(", ")} file.`);
    }
    const declared = Number(req.header("content-length") ?? 0);
    if (declared > maxBytes) {
      await drain(req, maxBytes);
      throw errors.rule("FILE_TOO_LARGE", `The file is larger than the ${config.ARTWORK_MAX_MB} MB limit.`);
    }

    let saved;
    try {
      saved = await files.saveStream(req, "artwork", maxBytes);
    } catch (e) {
      await drain(req, maxBytes);
      throw e;
    }
    const type = detectArtworkType(fileName, saved.head);
    if (!type) {
      await files.remove(saved.storageKey);
      throw errors.rule("FILE_CONTENT_MISMATCH", `The file content is not a valid ${ext.toUpperCase()} file.`);
    }
    const thumbnailKey = type.thumbnail ? await files.makeThumbnail(saved.storageKey) : null;
    if (type.thumbnail && !thumbnailKey && type.previewKind === "image") {
      await files.remove(saved.storageKey);
      throw errors.rule("FILE_UNREADABLE", "The image could not be read. Check that the file is not damaged.");
    }
    const file = await db.storedFile.create({
      data: {
        purpose: "ARTWORK",
        originalName: fileName,
        extension: type.extension,
        mimeType: type.mimeType,
        sizeBytes: saved.sizeBytes,
        sha256: saved.sha256,
        storageKey: saved.storageKey,
        thumbnailKey,
        previewKind: type.previewKind,
        uploadedById: user.id,
      },
    });
    const warnings = await duplicateWarnings(db, { fileId: file.id });
    res.status(201).json(ok({ file: fileView(file), warnings }));
  });

  /** Original file (inline preview or ?download=1). */
  r.get("/:id/content", requirePermission("bom.view"), async (req, res) => {
    const file = await visibleFile(req);
    const { download } = query(req, z.object({ download: z.enum(["0", "1"]).optional() }));
    const inline = download !== "1" && file.previewKind !== "none";
    sendStored(res, files.pathOf(file.storageKey), file.mimeType, file.originalName, inline, file.extension === "svg");
  });

  r.get("/:id/thumbnail", requirePermission("bom.view"), async (req, res) => {
    const file = await visibleFile(req);
    if (!file.thumbnailKey) throw errors.notFound("Thumbnail");
    res.setHeader("Cache-Control", "private, max-age=86400, immutable");
    sendStored(res, files.pathOf(file.thumbnailKey), "image/png", `${file.originalName}.png`, true, false);
  });

  /** Attached files are visible to anyone with bom.view; unattached uploads only to the uploader. */
  async function visibleFile(req: Request) {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const file = await db.storedFile.findUnique({ where: { id } });
    if (!file || (!file.attachedAt && file.uploadedById !== user.id)) throw errors.notFound("File");
    return file;
  }

  return r;
}

/**
 * Read and discard the rest of a refused upload so the client receives the
 * error response instead of a connection reset. Gives up (closes the socket)
 * past 4x the size limit or after 30 s.
 */
function drain(req: Request, maxBytes: number) {
  return new Promise<void>((resolve) => {
    if (req.readableEnded || req.destroyed) return resolve();
    let seen = 0;
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      req.destroy();
      done();
    }, 30_000);
    req.on("data", (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > maxBytes * 4) {
        req.destroy();
        done();
      }
    });
    req.on("end", done);
    req.on("error", done);
    req.on("close", done);
    req.resume();
  });
}

function sendStored(
  res: Response,
  absPath: string,
  mimeType: string,
  name: string,
  inline: boolean,
  sandbox: boolean,
) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  res.setHeader("Content-Type", mimeType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  // SVG can carry scripts: opened directly it runs in a locked-down sandbox.
  if (sandbox) res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  res.sendFile(absPath, { headers: { "Content-Type": mimeType } });
}

export const fileView = (f: { id: string; originalName: string; extension: string; mimeType: string; sizeBytes: number; sha256: string; previewKind: string; thumbnailKey: string | null; createdAt: Date }) => ({
  id: f.id,
  originalName: f.originalName,
  extension: f.extension,
  mimeType: f.mimeType,
  sizeBytes: f.sizeBytes,
  sha256: f.sha256,
  previewKind: f.previewKind,
  hasThumbnail: !!f.thumbnailKey,
  uploadedAt: f.createdAt,
});
