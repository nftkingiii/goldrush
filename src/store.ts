import { readFileSync } from "node:fs";
import { buildSiteIndex, normalizeName, type Site, type SiteIndex } from "./match.ts";

export interface Source {
  label: string;
  title: string;
  url: string;
  licence: string;
  retrieved: string;
  fixture?: string;
}

interface RecordBase {
  id: string;
  site_no: number;
  entity: string;
  source_ref: string;
  quote: string;
}
export interface ProductionRecord extends RecordBase {
  kind: "production";
  commodity: string;
  amount: number;
  unit: "oz" | "t";
  qualifier: string | null;
  period_from: string | null;
  period_to: string | null;
  basis: "reported" | "estimated";
}
export interface ClosureRecord extends RecordBase {
  kind: "closure";
  year: number;
  reason_text: string | null;
  reason_class: "exhausted" | "flooding" | "economic" | "legal" | "unknown";
  page: string | null;
}
export interface OwnershipRecord extends RecordBase {
  kind: "ownership";
  owner: string;
  role: string;
  period_from: string | null;
  period_to: string | null;
}
export type EvidenceRecord = ProductionRecord | ClosureRecord | OwnershipRecord;

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
  records: Map<number, EvidenceRecord[]>;
  gold: GoldMonths;
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
    if (!ev.sources[r.source_ref]) throw new Error(`evidence ${r.id} cites unknown source ${r.source_ref}`);
    if (!r.quote) throw new Error(`evidence ${r.id} has no quote`);
    if (r.kind === "closure" && !REASON_CLASSES.has(r.reason_class)) throw new Error(`evidence ${r.id} has bad reason_class`);
    if (r.kind === "production" && r.unit !== "oz" && r.unit !== "t") throw new Error(`evidence ${r.id} has bad unit`);
    const list = records.get(r.site_no) ?? [];
    list.push(r);
    records.set(r.site_no, list);
  }
  const siteIndex = buildSiteIndex(sites);
  for (const siteNo of records.keys()) if (!siteIndex.byNo.has(siteNo)) throw new Error(`evidence for unknown GSQ site ${siteNo}`);

  const g = read("gold-monthly.json");
  const months = new Map<string, { usd: number; fx: number | null; fx_date: string | null }>();
  for (const m of g.months) months.set(m.m, { usd: m.usd, fx: m.fx, fx_date: m.fx_date });
  return {
    built: idx.built,
    datasets: idx.datasets,
    sites: siteIndex,
    ga,
    sources: ev.sources,
    records,
    gold: { gold: g.gold, fx: g.fx, months, first: g.months[0].m, last: g.months.at(-1).m },
  };
}
