// Rebuilds data/minocc.json (compact per-site MINOCC 2017 data for the gold sites in data/index.json) from the GSQ Access database.
//   node scripts/build-minocc.ts --mdb "path/to/MINOCC 2017.mdb"     (needs mdbtools: mdb-export on PATH, e.g. a Linux box)
//   node scripts/build-minocc.ts --csv-dir path/to/csv                (CSV files named <table>.csv written by mdb-export -T "%Y-%m-%d" -D "%Y-%m-%d")
// The .mdb and the CSVs stay out of git (see .gitignore). The database is treated as data only: it is read with mdb-export, never opened by anything that runs its content.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildMinocc, MINOCC_DATASET_URL, MINOCC_VERSION, readTable, type Tables } from "../src/minocc.ts";

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const mdb = flag("--mdb");
const csvDir = flag("--csv-dir");
if (!mdb && !csvDir) throw new Error("give --mdb <file> or --csv-dir <dir>");

const NAMES = ["Production", "MineHist", "Tenure", "Total_Ores_Prod", "Total_Alluvial_Prod", "Explorer", "Company reports", "Location"] as const;
const load = (table: string): string =>
  mdb
    ? execFileSync("mdb-export", ["-T", "%Y-%m-%d", "-D", "%Y-%m-%d", mdb, table], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
    : readFileSync(join(csvDir!, `${table}.csv`), "utf8");
const tables = Object.fromEntries(NAMES.map((n) => [n, readTable(load(n))])) as unknown as Tables;

const here = (p: string) => new URL(`../${p}`, import.meta.url);
const idx = JSON.parse(readFileSync(here("data/index.json"), "utf8")) as { sites: [number, string][] };
const gold = new Map<number, string>(idx.sites.map((r) => [r[0], String(r[1]).trim()]));

const { sites, report } = buildMinocc(tables, gold);
const sha = mdb ? createHash("sha256").update(readFileSync(mdb)).digest("hex") : (flag("--mdb-sha256") ?? null);
const out = {
  schema: 1,
  note: "Derived from the GSQ MINOCC 2017 Access database. Only gold sites of data/index.json; only the tables and fields listed in RESEARCH.md. Figures and units are as recorded (units lower-cased only). Rebuild with scripts/build-minocc.ts.",
  source: {
    key: "MINOCC-2017",
    label: "GSQ MINOCC 2017",
    title: `Queensland Mineral Occurrence Data, ${MINOCC_VERSION}`,
    url: MINOCC_DATASET_URL,
    licence: "CC BY 4.0 (as listed on the GSQ Open Data Portal / data.qld.gov.au dataset listing); (c) State of Queensland (Department of Natural Resources and Mines). The download's own PDFs state no licence.",
    retrieved: "2026-11-20",
    file_sha256: sha,
  },
  coverage: report.counts,
  join: report.join,
  sites,
};
writeFileSync(here("data/minocc.json"), JSON.stringify(out));
console.log(JSON.stringify({ ...report, unparsed_production_rows: report.unparsed_production_rows.length }, null, 1));
console.log("unparsed samples:", report.unparsed_production_rows.slice(0, 12));
