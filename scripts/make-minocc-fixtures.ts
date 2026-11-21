// Writes test/fixtures/minocc/<table>.csv: the rows of a few sites from the exported MINOCC CSVs, so the builder can be tested without the 267 MB database.
//   node scripts/make-minocc-fixtures.ts data/raw/qmin-csv
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../src/minocc.ts";

export const FIXTURE_SITES = [494270, 38730, 38722, 479629, 36049, 38776];
const dir = process.argv[2];
if (!dir) throw new Error("usage: make-minocc-fixtures.ts <csv-dir>");
const out = new URL("../test/fixtures/minocc/", import.meta.url);
mkdirSync(out, { recursive: true });
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
for (const t of ["Production", "MineHist", "Tenure", "Total_Ores_Prod", "Total_Alluvial_Prod", "Explorer", "Company reports", "Location"]) {
  const rows = parseCsv(readFileSync(join(dir, `${t}.csv`), "utf8").replace(/(100,000)/g, "(100k)"));
  const keep = rows.slice(1).filter((r) => r.length === rows[0]!.length && FIXTURE_SITES.includes(Number(r[0])));
  writeFileSync(new URL(`${t}.csv`, out), [rows[0]!, ...keep].map((r) => r.map(q).join(",")).join("\n") + "\n");
}
