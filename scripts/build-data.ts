// Builds the compact snapshots the miner serves from: data/index.json (sites + GA links) and data/gold-monthly.json.
// Inputs: data/raw/*, plus the World Bank Pink Sheet workbook passed as the first argument.
//   node scripts/build-data.ts path/to/CMO-Historical-Data-Monthly.xlsx
import { readFileSync, writeFileSync } from "node:fs";
import { parseGsq, parsePinkSheetGold, parseRbaUsd, type GaDeposit } from "../src/sources.ts";
import { distanceKm, normalizeName } from "../src/match.ts";

const here = (p: string) => new URL(`../${p}`, import.meta.url);
const read = (p: string) => readFileSync(here(p), "utf8");

const minocc = JSON.parse(read("data/raw/minocc-gold.json"));
const ga = JSON.parse(read("data/raw/ga-qld-gold.json")) as { fetched: string; rows: GaDeposit[] };
const sites = parseGsq({ features: minocc.rows.map((attributes: unknown) => ({ attributes })) });

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);
const gaLinks = new Map<number, number>();
for (const s of sites) {
  const n = normalizeName(s.occur_name);
  for (const d of ga.rows) {
    if (normalizeName(d.name) === n && distanceKm(s.latitude, s.longitude, d.lat, d.lon) <= 5) gaLinks.set(s.site_no, d.eno);
  }
}

const index = {
  built: new Date().toISOString().slice(0, 10),
  datasets: {
    minocc: { name: minocc.dataset, url: minocc.source_url, licence: minocc.licence, fetched: minocc.fetched, count: sites.length },
    ga: { name: "Geoscience Australia Mineral Deposits and Mineral Resources WFS (ama:MineralDeposits), Queensland gold", url: "https://services.ga.gov.au/gis/earthresource/wfs", licence: "CC BY 4.0", fetched: ga.fetched, count: ga.rows.length },
  },
  // columns: site_no, name, locality, sheet, lat, lon, accuracy_m, mine_status, exposure, group, size, size_def, commodities, date_current, ga_eno
  columns: ["site_no", "name", "locality", "sheet", "lat", "lon", "accuracy_m", "mine_status", "exposure", "group", "size", "size_def", "commodities", "date_current", "ga_eno"],
  sites: sites.map((s) => [
    s.site_no, s.occur_name.trim(), s.site_locality, s.sheet_100_name, s.latitude, s.longitude, s.loc_accuracy, s.mine_status,
    s.exposure_type, s.group_name, s.main_occur_size, s.main_occur_size_def, s.all_commodities, iso(s.date_current), gaLinks.get(s.site_no) ?? null,
  ]),
  ga: ga.rows.map((d) => [d.eno, d.name, d.status, d.commodities, d.companies, d.lat, d.lon]),
};
writeFileSync(here("data/index.json"), JSON.stringify(index));
console.log("sites", index.sites.length, "ga links", gaLinks.size);

const xlsx = process.argv[2];
if (xlsx) {
  const gold = parsePinkSheetGold(readFileSync(xlsx));
  const fx = [...parseRbaUsd(read("data/raw/rba-f11hist-1969-2009.usd.txt")), ...parseRbaUsd(read("data/raw/rba-f11-2010-2026.usd.txt"))];
  const byMonth = new Map(fx.map((r) => [r.month, r]));
  const out = {
    built: new Date().toISOString().slice(0, 10),
    gold: {
      series: "World Bank Commodity Price Data (The Pink Sheet), Gold, monthly average, nominal US$ per troy ounce, as published (whole dollars)",
      url: "https://www.worldbank.org/en/research/commodity-markets",
      file: "CMO-Historical-Data-Monthly.xlsx (updated November 03, 2026)",
      licence: "World Bank open data terms (CC BY 4.0); attribution: The World Bank, Commodity Price Data (The Pink Sheet)",
    },
    fx: {
      series: "RBA statistical table F11 Exchange Rates, monthly, A$1 = US$, month-end observation (pre-1983-12-12 the RBA representative rate)",
      url: "https://www.rba.gov.au/statistics/historical-data.html",
      licence: "Creative Commons Attribution 4.0 International (RBA copyright notice)",
    },
    months: gold.map((g) => ({ m: g.month, usd: g.usd, fx: byMonth.get(g.month)?.usdPerAud ?? null, fx_date: byMonth.get(g.month)?.date ?? null })),
  };
  writeFileSync(here("data/gold-monthly.json"), JSON.stringify(out));
  console.log("gold months", out.months.length, "with fx", out.months.filter((m) => m.fx).length, "first", out.months[0]?.m, "last", out.months.at(-1)?.m);
}
