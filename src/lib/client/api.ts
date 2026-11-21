"use client";

/** Typed fetch wrapper for the app's own API routes. */
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details: unknown = null,
  ) {
    super(message);
  }
}

let authToken: string | null = null;
/** Supabase mode: the Supabase access token is sent as a Bearer token. */
export function setAuthToken(t: string | null) {
  authToken = t;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: { "Content-Type": "application/json", ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new ApiError("network", "Network error", 0);
  }
  let json: { ok: boolean; data?: T; error?: { code: string; message: string; details?: unknown } };
  try {
    json = await res.json();
  } catch {
    throw new ApiError("internal", "Invalid response", res.status);
  }
  if (!json.ok) throw new ApiError(json.error?.code ?? "internal", json.error?.message ?? "Error", res.status, json.error?.details ?? null);
  return json.data as T;
}
