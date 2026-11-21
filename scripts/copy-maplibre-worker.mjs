// Copies MapLibre's web-worker bundle into /public so the browser can load it.
// MapLibre v6 resolves its worker relative to import.meta.url, which bundlers
// rewrite; serving the exact installed version from /public avoids that.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve("maplibre-gl/package.json"));
const src = path.join(pkgDir, "dist", "maplibre-gl-worker.mjs");
const destDir = path.join(process.cwd(), "public");
mkdirSync(destDir, { recursive: true });
copyFileSync(src, path.join(destDir, "maplibre-gl-worker.mjs"));
console.log("[rakna] copied maplibre-gl-worker.mjs to public/");
