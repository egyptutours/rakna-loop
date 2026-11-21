// One-off H3 back-fill for rows created before migration 0004 (STAGING FIRST).
//
//   node --env-file=.env.staging.local scripts/backfill-h3.mjs [--dry-run]
//
// • Uses the shared staging guard (RAKNA_TARGET=staging must be set; production refs refused).
// • Idempotent: only rows with h3_r10 IS NULL are touched; safe to re-run after a failure.
import { latLngToCell, cellToParent } from "h3-js";
import { stagingClients } from "./_staging-guard.mjs";

const { admin: db, ref } = stagingClients();
const dry = process.argv.includes("--dry-run");
console.log(`Target project: ${ref}${dry ? " (dry run)" : ""}`);

for (const table of ["departure_reports", "parking_spaces"]) {
  let total = 0;
  for (;;) {
    const { data, error } = await db.from(table).select("id, location_lat, location_lng").is("h3_r10", null).limit(500);
    if (error) throw error;
    if (!data.length) break;
    for (const row of data) {
      const r10 = latLngToCell(row.location_lat, row.location_lng, 10);
      const patch = { h3_r10: r10, h3_r9: cellToParent(r10, 9), h3_r8: cellToParent(r10, 8), h3_r7: cellToParent(r10, 7) };
      if (!dry) {
        const { error: e } = await db.from(table).update(patch).eq("id", row.id).is("h3_r10", null);
        if (e) throw e;
      }
      total++;
    }
    if (dry) break;
  }
  console.log(`${table}: ${dry ? "would update" : "updated"} ${total} row(s)`);
}
