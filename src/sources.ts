/**
 * Parsers and fetchers for the open datasets the index is built from. They run when the index is rebuilt
 * (scripts/), never while answering a request. `fetch` is injected so tests replay recorded real responses.
 */
import { zipEntries } from "./zip.ts";

export const USER_AGENT = "goldrush-miner/0.1 (research; keyless reads of open Queensland and World Bank data)";

export interface GsqSite {
  site_no: number;
  occur_name: string;
  site_locality: string | null;
  sheet_100_name: string | null;
  latitude: number;
  longitude: number;
  loc_accuracy: number | null;
  mine_status: string | null;
  exposure_type: string | null;
  group_name: string | null;
  main_commodity: string | null;
  main_occur_size: string | null;
  main_occur_size_def: string | null;
  all_commodities: string | null;
  date_current: number | null;
}

export const GSQ_LAYER =
  "https://spatial-gis.information.qld.gov.au/arcgis/rest/services/GeoscientificInformation/MiningResources/MapServer/16";

export function gsqSiteUrl(siteNo: number): string {
  return `${GSQ_LAYER}/query?where=site_no%3D${siteNo}&outFields=%2A&f=json`;
}

/** Parses an ArcGIS query response; every feature must carry the fields the index needs. */
export function parseGsq(body: unknown): GsqSite[] {
  const features = (body as { features?: { attributes?: Record<string, unknown> }[] })?.features;
  if (!Array.isArray(features)) throw new Error("GSQ response has no features array");
  return features.map((f) => {
    const a = f.attributes ?? {};
    if (typeof a.site_no !== "number" || typeof a.occur_name !== "string") throw new Error("GSQ feature lacks site_no or occur_name");
    if (typeof a.latitude !== "number" || typeof a.longitude !== "number") throw new Error(`GSQ site ${a.site_no} has no coordinates`);
    return a as unknown as GsqSite;
  });
}

export async function fetchGsqSite(http: typeof fetch, siteNo: number): Promise<GsqSite | null> {
  const res = await http(gsqSiteUrl(siteNo), { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GSQ answered ${res.status}`);
  return parseGsq(await res.json())[0] ?? null;
}

export interface GaDeposit {
  eno: number;
  name: string;
  status: string | null;
  commodities: string | null;
  companies: string | null;
  lat: number;
  lon: number;
}

export const GA_WFS = "https://services.ga.gov.au/gis/earthresource/wfs";

export function gaDepositUrl(eno: number): string {
  const q = new URLSearchParams({
    service: "WFS", version: "2.0.0", request: "GetFeature", typeNames: "ama:MineralDeposits",
    outputFormat: "application/json", cql_filter: `ENO=${eno}`,
  });
  return `${GA_WFS}?${q}`;
}

export function parseGa(body: unknown): GaDeposit[] {
  const features = (body as { features?: { properties?: Record<string, unknown> }[] })?.features;
  if (!Array.isArray(features)) throw new Error("GA response has no features array");
  return features.map((f) => {
    const p = f.properties ?? {};
    if (typeof p.ENO !== "number" || typeof p.DEPOSIT_NAME !== "string") throw new Error("GA feature lacks ENO or DEPOSIT_NAME");
    return {
      eno: p.ENO,
      name: p.DEPOSIT_NAME,
      status: (p.OPERATING_STATUS as string) ?? null,
      commodities: (p.COMMODITY_NAMES as string) ?? null,
      companies: (p.COMPANIES as string) ?? null,
      lat: p.LAT_GDA94 as number,
      lon: p.LONG_GDA94 as number,
    };
  });
}

/** World Bank Pink Sheet: monthly nominal US dollars per troy ounce, from the "Monthly Prices" sheet. */
export function parsePinkSheetGold(xlsx: Buffer): { month: string; usd: number }[] {
  const files = zipEntries(xlsx);
  const sst = [...(files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""),
  );
  const wb = files.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const rels = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const sheet = wb.match(/<sheet [^>]*name="Monthly Prices"[^>]*r:id="([^"]+)"/)?.[1];
  const target = sheet && rels.match(new RegExp(`<Relationship [^>]*Id="${sheet}"[^>]*Target="([^"]+)"|<Relationship [^>]*Target="([^"]+)"[^>]*Id="${sheet}"`));
  const path = target ? `xl/${(target[1] ?? target[2])!.replace(/^\/?(xl\/)?/, "")}` : "";
  const xml = files.get(path)?.toString("utf8");
  if (!xml) throw new Error("Pink Sheet workbook has no Monthly Prices sheet");

  const cells = new Map<string, string>();
  for (const c of xml.matchAll(/<c r="([A-Z]+\d+)"([^>]*?)>(?:<v>([\s\S]*?)<\/v>)?/g)) {
    if (c[3] === undefined) continue;
    cells.set(c[1]!, /t="s"/.test(c[2]!) ? (sst[Number(c[3])] ?? "") : c[3]);
  }
  let col = "";
  for (const [ref, v] of cells) if (/^[A-Z]+5$/.test(ref) && v === "Gold") col = ref.replace(/\d+/, "");
  if (!col) throw new Error("Pink Sheet has no Gold column");
  const unit = cells.get(`${col}6`) ?? "";
  if (!/troy oz/.test(unit)) throw new Error(`Pink Sheet gold column is not per troy ounce: ${unit}`);
  const out: { month: string; usd: number }[] = [];
  for (let r = 7; ; r++) {
    const label = cells.get(`A${r}`);
    if (!label) break;
    const m = label.match(/^(\d{4})M(\d{2})$/);
    const v = Number(cells.get(`${col}${r}`));
    if (m && Number.isFinite(v) && v > 0) out.push({ month: `${m[1]}-${m[2]}`, usd: v });
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** RBA F11 month-end AUD/USD (A$1 = US$). Accepts both the Excel-serial and the dated forms stored under data/raw. */
export function parseRbaUsd(text: string): { month: string; date: string; usdPerAud: number }[] {
  const body = text.split(/\r?\n/).filter((l) => l && !l.startsWith("#")).join(",");
  const out: { month: string; date: string; usdPerAud: number }[] = [];
  for (const item of body.split(",")) {
    const [k, v] = item.split(":");
    const rate = Number(v);
    if (!k || !Number.isFinite(rate) || rate <= 0) continue;
    let date: string;
    if (/^\d+$/.test(k)) date = new Date(Date.UTC(1899, 11, 30) + Number(k) * 86_400_000).toISOString().slice(0, 10);
    else {
      const m = k.match(/^(\d{4})-([A-Za-z]{3})(\d{1,2})$/);
      const mi = m ? MONTHS.indexOf(m[2]!) : -1;
      if (!m || mi < 0) throw new Error(`unreadable RBA date ${k}`);
      date = `${m[1]}-${String(mi + 1).padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
    }
    out.push({ month: date.slice(0, 7), date, usdPerAud: rate });
  }
  return out;
}
