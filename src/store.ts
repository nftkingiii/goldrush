import { readFileSync } from "node:fs";
import { expandSite, sourceKey, type SiteData } from "./minocc.ts";
import { buildSiteIndex, normalizeName, type Site, type SiteIndex } from "./match.ts";

export interface Source {
  label: string;
  title: string;
  url: string;
  licence: string;
  retrieved: string;
  fixture?: string;
  file_sha256?: string | null;
}

interface RecordBase {
  id: string;
  site_no: number;
  entity: string;
  source_ref: string;
  quote: string;
  /** "site_total" / "site": the record describes the whole GSQ site, so records of different sources can be compared. "period": one dated row of a source. */
  scope?: "site_total" | "site" | "period";
}
export interface ProductionRecord extends RecordBase {
  kind: "production";
  commodity: string;
  amount: number;
  unit: "oz" | "t" | "kg";
  qualifier: string | null;
  period_from: number | null;
  period_to: number | null;
  basis: "reported" | "estimated";
  /** MINOCC only */
  commodity_code?: string; form?: string | null; grade?: string | null; ore_class?: string; ore_recorded?: string | null; comment?: string | null;
}
export interface ClosureRecord extends RecordBase {
  kind: "closure";
  year: number;
  reason_text: string | null;
  reason_class: "exhausted" | "flooding" | "economic" | "legal" | "unknown";
  page: string | null;
  basis_note?: string;
  comment?: string | null;
}
export interface OwnershipRecord extends RecordBase {
  kind: "ownership";
  owner: string;
  role: string;
  period_from: number | null;
  period_to: number | null;
  tenures?: { type: string; number: number | null }[];
  comment?: string | null;
}
export interface YearsWorkedRecord extends RecordBase {
  kind: "years_worked";
  periods: { seq: number; start_year: number | null; end_year: number | null; comment: string | null; mine_life_flag: string | null }[];
}
export interface ReferenceRecord extends RecordBase {
  kind: "reference";
  cr_numbers: number[];
}
export type EvidenceRecord = ProductionRecord | ClosureRecord | OwnershipRecord | YearsWorkedRecord | ReferenceRecord;

export interface GaRow {
  eno: number;
  name: string;
  status: string | null;
  commodities: string | null;
  companies: string | null;
}

export interface Store {
  built: string;
  datasets: Record<string, { name: string; url: string; licence: string; fetched: string; count: number }>;
  sites: SiteIndex;
  ga: Map<number, GaRow>;
  sources: Record<string, Source>;
  minocc: { source: Source; coverage: Record<string, number>; join: Record<string, unknown> };
  records: Map<number, EvidenceRecord[]>;
  gold: GoldMonths;
  cpi: Cpi;
}

export interface Cpi {
  series: string;
  url: string;
  series_page: string;
  licence: string;
  fetched: string;
  months: Map<string, number>;
  first: string;
  last: string;
}

export interface GoldMonths {
  gold: { series: string; url: string; file: string; licence: string };
  fx: { series: string; url: string; licence: string };
  months: Map<string, { usd: number; fx: number | null; fx_date: string | null }>;
  first: string;
  last: string;
}

const REASON_CLASSES = new Set(["exhausted", "flooding", "economic", "legal", "unknown"]);

/** Loads the snapshots and checks them: a record without a source, quote or valid class stops the service from starting. */
export function loadStore(dir = new URL("../data/", import.meta.url)): Store {
  const read = (name: string) => JSON.parse(readFileSync(new URL(name, dir), "utf8"));
  const idx = read("index.json");
  const cols: string[] = idx.columns;
  const sites: Site[] = idx.sites.map((row: unknown[]) => {
    const o = Object.fromEntries(cols.map((c, i) => [c, row[i]])) as Record<string, never>;
    return { ...o, norm: normalizeName(String(o.name)) } as unknown as Site;
  });
  const ga = new Map<number, GaRow>();
  for (const [eno, name, status, commodities, companies] of idx.ga) ga.set(eno, { eno, name, status, commodities, companies });

  const ev = read("evidence.json");
  const records = new Map<number, EvidenceRecord[]>();
  for (const r of ev.records as EvidenceRecord[]) {
    if (!ev.sources[sourceKey(r.source_ref)]) throw new Error(`evidence ${r.id} cites unknown source ${r.source_ref}`);
    if (!r.quote) throw new Error(`evidence ${r.id} has no quote`);
    if (r.kind === "closure" && !REASON_CLASSES.has(r.reason_class)) throw new Error(`evidence ${r.id} has bad reason_class`);
    if (r.kind === "production" && r.unit !== "oz" && r.unit !== "t") throw new Error(`evidence ${r.id} has bad unit`);
    const list = records.get(r.site_no) ?? [];
    list.push(r);
    records.set(r.site_no, list);
  }
  // MINOCC 2017: derived per-site data, expanded into records of the same shapes. Kept as its own source; never merged with the curated ones.
  const mo = read("minocc.json");
  const sources: Record<string, Source> = { ...ev.sources, [mo.source.key]: mo.source };
  for (const [no, d] of Object.entries(mo.sites as Record<string, SiteData>)) {
    for (const r of expandSite(Number(no), d) as unknown as EvidenceRecord[]) {
      if (!sources[sourceKey(r.source_ref)] || !r.quote) throw new Error(`minocc ${r.id} lacks a source or quote`);
      if (r.kind === "production" && !["oz", "t", "kg"].includes(r.unit)) throw new Error(`minocc ${r.id} has bad unit`);
      const list = records.get(r.site_no) ?? [];
      list.push(r);
      records.set(r.site_no, list);
    }
  }
  const siteIndex = buildSiteIndex(sites);
  for (const siteNo of records.keys()) if (!siteIndex.byNo.has(siteNo)) throw new Error(`evidence for unknown GSQ site ${siteNo}`);

  const g = read("gold-monthly.json");
  const months = new Map<string, { usd: number; fx: number | null; fx_date: string | null }>();
  for (const m of g.months) months.set(m.m, { usd: m.usd, fx: m.fx, fx_date: m.fx_date });
  const c = read("cpi.json");
  const cpi: Cpi = { series: c.series, url: c.url, series_page: c.series_page, licence: c.licence, fetched: c.fetched, months: new Map(c.months as [string, number][]), first: c.months[0][0], last: c.months.at(-1)[0] };
  return {
    built: idx.built,
    datasets: idx.datasets,
    sites: siteIndex,
    ga,
    sources,
    minocc: { source: mo.source, coverage: mo.coverage, join: mo.join },
    records,
    gold: { gold: g.gold, fx: g.fx, months, first: g.months[0].m, last: g.months.at(-1).m },
    cpi,
  };
}
