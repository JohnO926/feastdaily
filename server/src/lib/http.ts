import { z } from "zod";

/** Error with an HTTP status and a stable machine-readable code. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public details?: unknown,
  ) {
    super(message ?? code);
  }
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, {
    ...init,
    headers: { "cache-control": "no-store", ...(init.headers ?? {}) },
  });
}

/** Error envelope: { error: { code, message, details? } }. Never echoes DB rows. */
export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json(
      { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } },
      { status: err.status },
    );
  }
  console.error("[api] unhandled error", err);
  return json({ error: { code: "internal", message: "Internal server error" } }, { status: 500 });
}

export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
  }
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new HttpError(400, "invalid_request", "Request validation failed", z.treeifyError(r.error));
  }
  return r.data;
}

/** Wraps a route handler so thrown HttpErrors become JSON error responses. */
export function handler<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/** Constant-time string comparison for shared secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length || ea.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

export function requireSecret(req: Request, secret: string, code = "unauthorized"): void {
  const token = bearer(req);
  if (!secret || !token || !safeEqual(token, secret)) throw new HttpError(401, code, "Unauthorized");
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
