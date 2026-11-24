import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError } from "../lib/errors";
import type { Logger } from "../lib/logger";

/** Renders every error once, as application/problem+json. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    let error: AppError;
    if (err instanceof AppError) {
      error = err;
    } else if (err?.type === "entity.parse.failed") {
      error = new AppError(400, "BAD_JSON", "The request body is not valid JSON.");
    } else if (err?.type === "entity.too.large") {
      error = new AppError(413, "TOO_LARGE", "The request is too large.");
    } else if (err?.code === "P2002") {
      // Prisma unique constraint
      const target = Array.isArray(err?.meta?.target) ? err.meta.target.join(", ") : "value";
      error = new AppError(409, "DUPLICATE", `A record with this ${target} already exists.`);
    } else if (err?.code === "P2025") {
      error = new AppError(404, "NOT_FOUND", "The record was not found.");
    } else {
      logger.error({ err, requestId: req.ctx?.requestId, path: req.path }, "unhandled error");
      error = new AppError(500, "INTERNAL", "Something went wrong on the server. The error has been logged.");
    }
    res
      .status(error.status)
      .type("application/problem+json")
      .json({
        type: `about:blank`,
        status: error.status,
        code: error.code,
        title: error.message,
        requestId: req.ctx?.requestId,
        ...(error.details ?? {}),
      });
  };
}

export const notFoundHandler: RequestHandler = (req, _res, next) =>
  next(new AppError(404, "ROUTE_NOT_FOUND", `No API route ${req.method} ${req.path}.`));
