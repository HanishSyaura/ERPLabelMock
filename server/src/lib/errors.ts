/**
 * Every expected failure is thrown as an AppError and rendered once by the
 * error middleware as application/problem+json. Routes never build error
 * responses themselves.
 */
export interface FieldIssue {
  path: string;
  message: string;
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: { issues?: FieldIssue[]; [key: string]: unknown },
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errors = {
  badRequest: (message: string, details?: AppError["details"]) =>
    new AppError(400, "BAD_REQUEST", message, details),
  validation: (issues: FieldIssue[]) =>
    new AppError(422, "VALIDATION_FAILED", "Some fields need attention.", { issues }),
  unauthenticated: (message = "Please sign in to continue.") =>
    new AppError(401, "UNAUTHENTICATED", message),
  forbidden: (message = "You do not have permission to do this.") =>
    new AppError(403, "FORBIDDEN", message),
  notFound: (what: string) => new AppError(404, "NOT_FOUND", `${what} was not found.`),
  conflict: (message: string, details?: AppError["details"]) =>
    new AppError(409, "CONFLICT", message, details),
  /** A business rule refused the action (e.g. quantity exceeds available WIP). */
  rule: (code: string, message: string, details?: AppError["details"]) =>
    new AppError(422, code, message, details),
  tooMany: (message = "Too many attempts. Please wait and try again.") =>
    new AppError(429, "RATE_LIMITED", message),
};
