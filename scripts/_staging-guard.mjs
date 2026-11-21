// Shared guard for scripts that touch a Supabase project.
// Supabase URLs look like https://<project-ref>.supabase.co, so "staging" cannot be
// inferred from the URL. The operator must declare the target explicitly, and may list
// production refs that these scripts will always refuse.
import { createClient } from "@supabase/supabase-js";

export function stagingClients({ needService = true } = {}) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || (needService && !service)) {
    console.error("Missing env. Put NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in .env.staging.local and run with:  node --env-file=.env.staging.local <script>");
    process.exit(1);
  }
  if (process.env.RAKNA_TARGET !== "staging") {
    console.error("Refusing to run: set RAKNA_TARGET=staging in .env.staging.local to confirm this is the STAGING project.");
    process.exit(1);
  }
  const ref = new URL(url).host.split(".")[0];
  const forbidden = (process.env.RAKNA_PRODUCTION_REFS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (forbidden.includes(ref)) {
    console.error(`Refusing to run: project ${ref} is listed in RAKNA_PRODUCTION_REFS.`);
    process.exit(1);
  }
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  return { url, ref, anon: createClient(url, anon, opts), admin: service ? createClient(url, service, opts) : null };
}
