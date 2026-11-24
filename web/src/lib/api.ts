/**
 * The only way the UI talks to the backend. Adds the CSRF token to unsafe
 * requests, the handheld device id when set, and turns problem+json errors
 * into ApiError with field issues.
 */
export const API_BASE = "/api/v1";

export interface FieldIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: FieldIssue[] = [],
  ) {
    super(message);
  }
  /** Message for one form field, if the server flagged it. */
  field(path: string) {
    return this.issues.find((i) => i.path === path)?.message;
  }
}

export interface Paged<T> {
  data: T[];
  meta: { page: number; pageSize: number; total: number; pageCount: number; stages?: Record<string, number>; counts?: Record<string, number> };
}

let csrfToken: string | null = null;
let onUnauthenticated: (() => void) | null = null;

export const setCsrfToken = (token: string | null) => {
  csrfToken = token;
};
export const setUnauthenticatedHandler = (fn: () => void) => {
  onUnauthenticated = fn;
};

const DEVICE_KEY = "mes.deviceId";
function deviceId(): string | null {
  try {
    return localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function request<T>(method: Method, path: string, body?: unknown, raw = false): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const device = deviceId();
  if (device) headers["X-Device-Id"] = device;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Can't reach the server. Check the network connection and try again.");
  }

  const text = await res.text();
  const json = text ? safeJson(text) : null;
  if (!res.ok) {
    const problem = (json ?? {}) as { code?: string; title?: string; issues?: FieldIssue[] };
    const err = new ApiError(res.status, problem.code ?? "HTTP_" + res.status, problem.title ?? `Request failed (${res.status}).`, problem.issues ?? []);
    if (res.status === 401 && !path.startsWith("/auth/login")) onUnauthenticated?.();
    throw err;
  }
  return (raw ? json : (json as { data: T } | null)?.data) as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  /** GET a paged list: returns `{ data, meta }`. */
  list: <T>(path: string) => request<Paged<T>>("GET", path, undefined, true),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  delete: <T>(path: string) => request<T>("DELETE", path),
};

/**
 * Upload one file as a raw request body (streams on the server). Uses XHR
 * for progress reporting; same CSRF / device headers and error shape as api.*.
 */
export function uploadFile<T>(path: string, file: File, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}${path}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.setRequestHeader("Accept", "application/json");
    if (csrfToken) xhr.setRequestHeader("X-CSRF-Token", csrfToken);
    const device = deviceId();
    if (device) xhr.setRequestHeader("X-Device-Id", device);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onerror = () => reject(new ApiError(0, "NETWORK", "Upload failed. Check the network connection and try again."));
    xhr.onload = () => {
      const json = safeJson(xhr.responseText) as { data?: T; code?: string; title?: string; issues?: FieldIssue[] } | null;
      if (xhr.status >= 200 && xhr.status < 300) return resolve(json?.data as T);
      if (xhr.status === 401) onUnauthenticated?.();
      reject(new ApiError(xhr.status, json?.code ?? `HTTP_${xhr.status}`, json?.title ?? `Upload failed (${xhr.status}).`, json?.issues ?? []));
    };
    xhr.send(file);
  });
}

/** Build a query string, skipping empty values. */
export function qs(params: Record<string, string | number | boolean | undefined | null>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : "";
}
