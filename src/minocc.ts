// GSQ MINOCC 2017 (Queensland Mineral Occurrence Data, ds000004): reading the Access tables (as CSV from mdb-export)
// into a compact per-site structure, and expanding that structure into evidence records for the miner.
// Nothing here executes anything from the download; it only parses text.

export const MINOCC_KEY = "MINOCC-2017";
export const MINOCC_VERSION = "MINOCC 2017 (Queensland Mineral Occurrence Data, ds000004; digital data version April 2017)";
export const MINOCC_DATASET_URL = "https://geoscience.data.qld.gov.au/dataset/ds000004";

/** Minimal RFC 4180 reader (quoted fields, doubled quotes, embedded newlines). mdb-export writes this form. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export type Row = Record<string, string>;

/** CSV text to row objects. The MINOCC header "Sheet name (100,000)" holds an unquoted comma, so it is renamed first. */
export function readTable(csv: string): Row[] {
  const rows = parseCsv(csv.replace(/\(100,000\)/g, "(100k)"));
  const head = rows[0] ?? [];
  const out: Row[] = [];
  for (const r of rows.slice(1)) {
    if (r.length !== head.length) continue; // blank trailing line
    out.push(Object.fromEntries(head.map((h, i) => [h, r[i]!])));
  }
  return out;
}

const num = (s: string | undefined): number | null => {
  if (s === undefined || s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** mdb-export -T "%Y-%m-%d": an unknown date is written as year 1900 or day 00 ("1900-01-00"). Only the year is kept. */
export function yearOf(s: string | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((s ?? "").trim());
  if (!m || m[3] === "00" || m[2] === "00") return null;
  const y = Number(m[1]);
  return y > 1800 && y < 2100 ? y : null;
}

const unitOf = (u: string): "kg" | "t" | null => {
  const x = u.trim().toUpperCase();
  return x === "KG" ? "kg" : x === "T" ? "t" : null;
};

export interface Item { commodity: string; form: string | null; amount: number; unit: "kg" | "t"; grade: string | null }

/** Splits a Production.PRODUCTION text ("157273 KG GOLD BULLION   116175 T COPPER MATTE") into its figures. Grades ("1.08 G/T", "8 %") attach to the figure before them. */
export function parseProduction(text: string): { items: Item[]; unparsed: boolean } {
  const t = text.trim();
  const items: Item[] = [];
  // "GOLD BULLION 4.71 KG" (name first) is the one other layout the table uses.
  const lead = /^([A-Z][A-Z ()]*?)\s+(\d+(?:\.\d+)?)\s*(KG|T)$/.exec(t);
  if (lead) return { items: [{ commodity: lead[1]!.trim().split(/\s+/)[0]!.toLowerCase(), form: lead[1]!.trim().split(/\s+/).slice(1).join(" ").toLowerCase() || null, amount: Number(lead[2]), unit: unitOf(lead[3]!)!, grade: null }], unparsed: false };
  const re = /(\d+(?:\.\d+)?)\s*(KG|T|G\/T|%)(?:\s+([A-Z][A-Z ()]*?))?(?=\s+\d|\s*$)/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(t))) {
    consumed += m[0].length;
    const [, amount, unit, name] = m;
    if (unit === "G/T" || unit === "%") {
      const last = items.at(-1);
      if (last && !last.grade) last.grade = `${amount} ${unit}`;
      continue;
    }
    const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    items.push({ commodity: words[0]!.toLowerCase(), form: words.length > 1 ? words.slice(1).join(" ").toLowerCase() : null, amount: Number(amount), unit: unitOf(unit!)!, grade: null });
  }
  // A text with figures that the pattern could not read (or with no figure at all, for example a grade only) is flagged, never guessed.
  return { items, unparsed: t.length > 0 && items.length === 0 };
}

const COMMODITY_COLUMNS: [string, string, string, string][] = [
  ["AU", "gold", "AU", "Au units"], ["AG", "silver", "AG", "Ag units"], ["CU", "copper", "CU", "Cu units"], ["PB", "lead", "PB", "Pb units"],
  ["ZN", "zinc", "ZN", "Zn units"], ["CO", "cobalt", "CO", "Co units"], ["CST", "cassiterite", "CST", "Cst units"],
];

export interface Totals { q: string; ore: string; pf: number | null; pt: number | null; items: [commodity: string, code: string, amount: number, unit: "kg" | "t"][] }
export interface PeriodRow { i: number; ot: string; ore: string; pf: number | null; pt: number | null; q: string; c: string | null; items: [string, string | null, number, "kg" | "t", string | null][] }
export interface SiteData {
  name: string;
  tot?: Totals;
  allu?: Totals;
  per?: PeriodRow[];
  hist?: [seq: number, start: number | null, end: number | null, comment: string | null, life: string | null][];
  ten?: [type: string, number: number | null, holder: string][];
  exp?: [tenure: string, start: number | null, end: number | null, company: string, comment: string | null][];
  cr?: number[];
}

export interface Tables {
  Production: Row[]; MineHist: Row[]; Tenure: Row[]; Total_Ores_Prod: Row[]; Total_Alluvial_Prod: Row[]; Explorer: Row[]; "Company reports": Row[]; Location: Row[];
}

export interface BuildReport {
  gold_sites: number;
  join: { in_location_table: number; missing: number[]; same_name: number; different_name: number; checks: Record<string, string | null> };
  unparsed_production_rows: { site_no: number; text: string }[];
  counts: Record<string, number>;
}

const clean = (s: string | undefined) => (s ?? "").trim().replace(/\s+/g, " ");

/** Builds the per-site data for the gold sites in `gold` (site_no to the name used in the GSQ index). Joins on SITE_NO. */
export function buildMinocc(t: Tables, gold: Map<number, string>): { sites: Record<string, SiteData>; report: BuildReport } {
  const sites: Record<string, SiteData> = {};
  const site = (n: number): SiteData | null => {
    if (!gold.has(n)) return null;
    return (sites[n] ??= { name: gold.get(n)! });
  };
  const noOf = (r: Row) => num(r.SITE_NO);

  const locNos = new Set(t.Location.map((r) => noOf(r)));
  const locName = new Map(t.Location.map((r) => [noOf(r), clean(r["Mine Name"]).toUpperCase()]));
  const missing = [...gold.keys()].filter((n) => !locNos.has(n));
  let same = 0;
  let diff = 0;
  for (const [n, name] of gold) if (locName.has(n)) (locName.get(n) === clean(name).toUpperCase() ? same++ : diff++);

  const unparsed: BuildReport["unparsed_production_rows"] = [];
  const ordinal = new Map<number, number>();
  const periodsBySite = new Map<number, { pf: (number | null)[]; pt: (number | null)[] }>();
  for (const r of t.Production) {
    const n = noOf(r);
    if (n === null || !gold.has(n)) continue;
    const i = (ordinal.get(n) ?? 0) + 1;
    ordinal.set(n, i);
    const pf = yearOf(r["Start Year"]);
    const pt = yearOf(r["End Year"]);
    const p = periodsBySite.get(n) ?? { pf: [], pt: [] };
    p.pf.push(pf);
    p.pt.push(pt);
    periodsBySite.set(n, p);
    const parsed = parseProduction(r.PRODUCTION ?? "");
    if (parsed.unparsed) unparsed.push({ site_no: n, text: clean(r.PRODUCTION) });
    if (!parsed.items.length && !clean(r["Ore Amount"])) continue;
    (site(n)!.per ??= []).push({
      i, ot: clean(r["Ore Type"]), ore: clean(r["Ore Amount"]), pf, pt, q: clean(r.PRODUCTION), c: clean(r.COMMENTS) || null,
      items: parsed.items.map((x) => [x.commodity, x.form, x.amount, x.unit, x.grade]),
    });
  }

  const totals = (rows: Row[], alluvial: boolean) => {
    for (const r of rows) {
      const n = noOf(r);
      if (n === null || !gold.has(n)) continue;
      const items: Totals["items"] = [];
      for (const [code, commodity, valueCol, unitCol] of COMMODITY_COLUMNS) {
        const v = num(r[valueCol]);
        const u = unitOf(r[unitCol] ?? "");
        if (v !== null && u) items.push([commodity, code, v, u]);
      }
      const ore = num(r.ORE);
      if (ore !== null && /tonnes?$/i.test(clean(r["Ore Amount"]))) items.push(["ore", "ORE", ore, "t"]);
      if (!items.length) continue;
      const p = periodsBySite.get(n);
      // The totals carry no dates. Their span is taken from the site's Production rows only when every row is dated at that end.
      const pf = !alluvial && p && p.pf.every((y) => y !== null) ? Math.min(...(p.pf as number[])) : null;
      const pt = !alluvial && p && p.pt.every((y) => y !== null) ? Math.max(...(p.pt as number[])) : null;
      const q = clean(r[alluvial ? "Commodity Total" : "Commodity total"]);
      site(n)![alluvial ? "allu" : "tot"] = { q, ore: clean(r["Ore Amount"]), pf, pt, items };
    }
  };
  totals(t.Total_Ores_Prod, false);
  totals(t.Total_Alluvial_Prod, true);

  for (const r of t.MineHist) {
    const n = noOf(r);
    const s = n === null ? null : site(n);
    if (!s) continue;
    (s.hist ??= []).push([num(r["Sequence Number"]) ?? 0, num(r["Start Year"]), num(r["End Year"]), clean(r.COMMENTS) || null, clean(r.MINE_LIFE) || null]);
  }
  for (const s of Object.values(sites)) s.hist?.sort((a, b) => a[0] - b[0]);

  for (const r of t.Tenure) {
    const n = noOf(r);
    const s = n === null ? null : site(n);
    if (!s || !clean(r["Principal Holder Name"])) continue;
    (s.ten ??= []).push([clean(r["Tenure Type"]), num(r["Tenure Number"]), clean(r["Principal Holder Name"])]);
  }
  for (const r of t.Explorer) {
    const n = noOf(r);
    const s = n === null ? null : site(n);
    if (!s || !clean(r["Company Name"])) continue;
    (s.exp ??= []).push([clean(r.TENURE), num(r.Start_Year), num(r.End_Year), clean(r["Company Name"]), clean(r.COMMENTS) || null]);
  }
  for (const r of t["Company reports"]) {
    const n = noOf(r);
    const s = n === null ? null : site(n);
    const cr = num(r["CR number"]);
    if (!s || cr === null) continue;
    (s.cr ??= []).push(cr);
  }
  for (const s of Object.values(sites)) if (s.cr) s.cr = [...new Set(s.cr)].sort((a, b) => a - b);

  const checks: Record<string, string | null> = {};
  for (const n of [494270, 38730, 38722]) checks[String(n)] = locName.get(n) ?? null;

  const all = Object.values(sites);
  const report: BuildReport = {
    gold_sites: gold.size,
    join: { in_location_table: gold.size - missing.length, missing, same_name: same, different_name: diff, checks },
    unparsed_production_rows: unparsed,
    counts: {
      sites_with_any_minocc_data: all.length,
      with_total_production: all.filter((s) => s.tot || s.allu).length,
      with_gold_total: all.filter((s) => [...(s.tot?.items ?? []), ...(s.allu?.items ?? [])].some((i) => i[1] === "AU")).length,
      with_dated_production_rows: all.filter((s) => s.per?.some((p) => p.pf !== null || p.pt !== null)).length,
      with_years_worked: all.filter((s) => s.hist?.some((h) => h[1] !== null || h[2] !== null)).length,
      with_tenure_holder: all.filter((s) => s.ten).length,
      with_exploration_company: all.filter((s) => s.exp).length,
      with_owner_or_holder: all.filter((s) => s.ten || s.exp).length,
      with_cr_numbers: all.filter((s) => s.cr).length,
    },
  };
  return { sites, report };
}

// ---- expansion into evidence records ----

const title = (s: string) => s.toLowerCase().replace(/(^|[\s(-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
const ref = (table: string, siteNo: number, row?: number) => `${MINOCC_KEY}:${table}:${siteNo}${row === undefined ? "" : `:${row}`}`;

/** The key into Store.sources for any record reference ("MINOCC-2017:Production:494270:2" -> "MINOCC-2017"). */
export const sourceKey = (sourceRef: string) => sourceRef.split(":")[0]!;

export function expandSite(siteNo: number, d: SiteData): Record<string, unknown>[] {
  const entity = title(d.name);
  const out: Record<string, unknown>[] = [];
  const base = (id: string, kind: string, source_ref: string, quote: string) => ({ id, kind, site_no: siteNo, entity, source_ref, quote });

  for (const [key, tot, cls] of [["Total_Ores_Prod", d.tot, "ore (hard rock, dumps, tailings and other)"], ["Total_Alluvial_Prod", d.allu, "alluvial"]] as const) {
    if (!tot) continue;
    for (const [commodity, code, amount, unit] of tot.items) {
      out.push({
        ...base(`minocc-${key}-${siteNo}-${code}`, "production", ref(key, siteNo), `${key}: ${tot.q}${tot.ore ? ` (Ore Amount ${tot.ore})` : ""}`),
        scope: "site_total", commodity, commodity_code: code, amount, unit, qualifier: null, period_from: tot.pf, period_to: tot.pt, basis: "reported", ore_class: cls,
      });
    }
  }
  for (const p of d.per ?? []) {
    p.items.forEach(([commodity, form, amount, unit, grade], k) => {
      out.push({
        ...base(`minocc-Production-${siteNo}-${p.i}-${k + 1}`, "production", ref("Production", siteNo, p.i), `Production: ${p.q || "(no figure)"}${p.ore ? ` (Ore Amount ${p.ore}; Ore Type ${p.ot})` : ""}`),
        scope: "period", commodity, form, amount, unit, grade, qualifier: null, period_from: p.pf, period_to: p.pt, basis: "reported", ore_class: p.ot, ore_recorded: p.ore || null, comment: p.c,
      });
    });
  }
  if (d.hist?.length) {
    const periods = d.hist.map(([seq, start, end, comment, life]) => ({ seq, start_year: start, end_year: end, comment, mine_life_flag: life }));
    const text = d.hist.map(([seq, s, e, c]) => `#${seq}: ${s ?? "?"}-${e ?? "?"}${c ? ` ${c}` : ""}`).join(" | ");
    out.push({ ...base(`minocc-MineHist-${siteNo}`, "years_worked", ref("MineHist", siteNo), `MineHist: ${text}`), scope: "site", periods });
    const ends = d.hist.map((h) => h[2]).filter((y): y is number => y !== null);
    if (ends.length) {
      const year = Math.max(...ends);
      const row = d.hist.find((h) => h[2] === year)!;
      out.push({
        ...base(`minocc-MineHist-${siteNo}-last-end`, "closure", ref("MineHist", siteNo, row[0]), `MineHist #${row[0]}: Start Year ${row[1] ?? "(blank)"}, End Year ${year}${row[3] ? `, ${row[3]}` : ""}`),
        scope: "site", year, reason_text: null, reason_class: "unknown", page: null, basis_note: "latest End Year recorded in the MineHist table (end of the last recorded period of working)", comment: row[3],
      });
    }
  }
  const holders = new Map<string, { type: string; number: number | null }[]>();
  for (const [type, number, holder] of d.ten ?? []) holders.set(holder, [...(holders.get(holder) ?? []), { type, number }]);
  for (const [holder, tenures] of holders) {
    const list = tenures.map((x) => `${x.type.toLowerCase()} ${x.number ?? "(no number)"}`).join(", ");
    out.push({
      ...base(`minocc-Tenure-${siteNo}-${holder.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, "ownership", ref("Tenure", siteNo), `Tenure: Principal Holder Name ${holder}; ${tenures.map((x) => `${x.type} ${x.number ?? ""}`.trim()).join(", ")}`),
      owner: title(holder), role: `principal holder of ${list} (MINOCC Tenure table, as at the 2017 release; no dates recorded)`, period_from: null, period_to: null, tenures,
    });
  }
  (d.exp ?? []).forEach(([tenure, start, end, company, comment], k) => {
    out.push({
      ...base(`minocc-Explorer-${siteNo}-${k + 1}`, "ownership", ref("Explorer", siteNo, k + 1), `Explorer: ${tenure}, Start_Year ${start ?? "(blank)"}, End_Year ${end ?? "(blank)"}, Company Name ${company}${comment ? `, ${comment}` : ""}`),
      owner: title(company), role: `exploration tenure ${tenure} (MINOCC Explorer table)`, period_from: start, period_to: end, comment,
    });
  });
  if (d.cr?.length) out.push({ ...base(`minocc-CR-${siteNo}`, "reference", ref("Company reports", siteNo), `Company reports: ${d.cr.map((n) => `CR ${n}`).join(", ")}`), cr_numbers: d.cr });
  return out;
}
