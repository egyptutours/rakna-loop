import "server-only";
import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { DomainError, isDomainError } from "../domain/errors";
import { ConfigurationError } from "../config";

/** Wrap an API route: consistent JSON errors, no stack traces or secrets leaked. */
export function route<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return async (...args: A) => {
    try {
      const data = await fn(...args);
      return NextResponse.json({ ok: true, data }, { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      if (isDomainError(e)) {
        return NextResponse.json({ ok: false, error: { code: e.code, message: e.message, details: e.details ?? null } }, { status: e.status });
      }
      if (e instanceof ZodError) {
        return NextResponse.json({ ok: false, error: { code: "validation", message: "Invalid request", details: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } }, { status: 400 });
      }
      if (e instanceof ConfigurationError) {
        console.error("[rakna] configuration error:", e.message);
        return NextResponse.json({ ok: false, error: { code: "not_configured", message: "Service is not configured" } }, { status: 503 });
      }
      // Postgres unique violation from a concurrent request → a conflict, not a 500.
      if ((e as { code?: string })?.code === "23505") {
        return NextResponse.json({ ok: false, error: { code: "conflict", message: "That action conflicts with the current state" } }, { status: 409 });
      }
      // Log server-side only; database/driver messages may contain internal details.
      console.error("[rakna] unhandled API error", e);
      return NextResponse.json({ ok: false, error: { code: "internal", message: "Something went wrong" } }, { status: 500 });
    }
  };
}

export async function body<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new DomainError("validation", "Body must be JSON");
  }
  return schema.parse(json);
}
