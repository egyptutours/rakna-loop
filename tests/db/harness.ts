import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { postgis } from "@electric-sql/pglite-postgis";

/**
 * Supabase-like PostgreSQL test harness (PGlite = real PostgreSQL 18 compiled to WASM,
 * with PostGIS 3.6). Applies every migration in supabase/migrations in order on top of a
 * shim that reproduces the parts of Supabase the migrations rely on:
 *  • `auth` schema, `auth.users`, `auth.uid()` (reads request.jwt.claim.sub)
 *  • roles anon / authenticated / service_role (BYPASSRLS)
 *  • Supabase's DEFAULT PRIVILEGES (ALL on tables/functions/sequences to those roles),
 *    so the tests prove that RLS and explicit REVOKEs are what actually protect data.
 *
 * Not reproduced: PostgREST, GoTrue, pg_cron, pgcrypto (only gen_random_uuid() is used,
 * which is built into PostgreSQL ≥ 13), network, real concurrent connections.
 */

const SHIM = `
create schema if not exists auth;
create schema if not exists extensions;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}'::jsonb);
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

export const MIGRATIONS_DIR = path.resolve(process.cwd(), "supabase", "migrations");

export function migrationFiles(): string[] {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
}

function adapt(sql: string): string {
  // pgcrypto is not bundled with PGlite; the schema only needs gen_random_uuid() (core since PG13).
  return sql.replace(/create extension if not exists pgcrypto;/gi, "-- (harness) pgcrypto skipped: gen_random_uuid is built in");
}

export interface Db {
  pg: PGlite;
  applied: string[];
  /** Run as an end user through the `authenticated` role (RLS on). */
  asUser<T>(uid: string, fn: () => Promise<T>): Promise<T>;
  asAnon<T>(fn: () => Promise<T>): Promise<T>;
  asService<T>(fn: () => Promise<T>): Promise<T>;
  createUser(uid: string, opts?: { role?: "driver" | "partner" | "admin"; name?: string }): Promise<void>;
}

export async function createDb(opts: { upTo?: string } = {}): Promise<Db> {
  const pg = await PGlite.create({ extensions: { postgis } });
  await pg.exec(SHIM);
  const applied: string[] = [];
  for (const f of migrationFiles()) {
    if (opts.upTo && f > opts.upTo) break;
    const sql = adapt(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"));
    try {
      await pg.exec(sql);
    } catch (e) {
      const err = e as Error & { position?: string };
      throw new Error(`Migration ${f} failed: ${err.message}${err.position ? ` (at char ${err.position})` : ""}`);
    }
    applied.push(f);
  }

  const run = async <T>(setup: string, fn: () => Promise<T>): Promise<T> => {
    await pg.exec(setup);
    try {
      return await fn();
    } finally {
      await pg.exec("reset role; select set_config('request.jwt.claim.sub', '', false);");
    }
  };

  return {
    pg,
    applied,
    asUser: (uid, fn) => run(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`, fn),
    asAnon: (fn) => run("set role anon; select set_config('request.jwt.claim.sub', '', false);", fn),
    asService: (fn) => run("set role service_role;", fn),
    async createUser(uid, o = {}) {
      await pg.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [uid, `${uid.slice(0, 8)}@test.invalid`, JSON.stringify({ display_name: o.name ?? "Test" })]);
      if (o.role && o.role !== "driver") await pg.query("update profiles set role = $2 where id = $1", [uid, o.role]);
    },
  };
}

/** Expect a promise to reject with a PostgreSQL error (optionally a specific SQLSTATE or message). */
export async function pgError(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message: string };
    return { code: err.code, message: err.message };
  }
  throw new Error("Expected a PostgreSQL error, but the statement succeeded");
}
