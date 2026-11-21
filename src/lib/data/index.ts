import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getDataMode, isDemoMode } from "../config";
import type { DomainContext } from "../domain/context";
import { DEMO_REPO_VERSION, DemoRepo, type DemoState } from "./demo-repo";
import type { Repo } from "./repo";
import { buildSeed } from "./seed";
import { SupabaseRepo } from "./supabase-repo";

/**
 * Data-adapter factory. DEMO MODE keeps state in memory (optionally persisted to
 * .data/demo-db.json in local development so it survives dev-server restarts).
 */

const DATA_FILE = path.join(process.cwd(), ".data", "demo-db.json");

function persistEnabled(): boolean {
  return process.env.RAKNA_DEMO_PERSIST !== "off" && !process.env.VERCEL && process.env.NODE_ENV !== "test";
}

function loadState(): DemoState {
  if (persistEnabled()) {
    try {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      return JSON.parse(raw) as DemoState;
    } catch {
      /* first run or unreadable file → fresh seed */
    }
  }
  return buildSeed();
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(state: DemoState) {
  if (!persistEnabled()) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(state));
    } catch (e) {
      console.error("[rakna] could not persist demo state", e);
    }
  }, 150);
}

const g = globalThis as unknown as { __raknaDemoRepo?: DemoRepo; __raknaSupabaseRepo?: SupabaseRepo };

export function getRepo(): Repo {
  if (getDataMode() === "supabase") {
    g.__raknaSupabaseRepo ??= new SupabaseRepo();
    return g.__raknaSupabaseRepo;
  }
  // In dev, hot reload keeps the old instance alive on globalThis. If it was created by an
  // older class version, rebuild it from its own state so new adapter methods exist.
  const existing = g.__raknaDemoRepo as (DemoRepo & { version?: number }) | undefined;
  if (existing && existing.version !== DEMO_REPO_VERSION) g.__raknaDemoRepo = new DemoRepo(existing.snapshot(), scheduleSave);
  g.__raknaDemoRepo ??= new DemoRepo(loadState(), scheduleSave);
  return g.__raknaDemoRepo;
}

export function getDemoRepo(): DemoRepo | null {
  return isDemoMode() ? (getRepo() as DemoRepo) : null;
}

export function resetDemoData(): void {
  const repo = getDemoRepo();
  if (!repo) throw new Error("Demo reset is only available in demo mode");
  repo.replace(buildSeed());
}

export function getContext(): DomainContext {
  return { repo: getRepo(), now: () => new Date(), allowSimulatedEvidence: isDemoMode() };
}
