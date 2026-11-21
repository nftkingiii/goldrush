import type { Site } from "./match.ts";
import { USER_AGENT } from "./sources.ts";

export const CAVEAT =
  "A tenure expiry date, or the absence of a tenure, does not establish that the ground is available; that needs legal confirmation. Native title records are as published by the NNTT on the checked date.";
export const BUFFER_M = 2000;
export const CACHE_TTL_MS = 24 * 3600 * 1000;
export const QUERY_TIMEOUT_MS = 8000;

const QLD = "https://spatial-gis.information.qld.gov.au/arcgis/rest/services";
const NNTT = "https://services2.arcgis.com/rzk7fNEt0xoEp3cX/ArcGIS/rest/services/NNTT_Custodial_AGOL/FeatureServer";

export type Category = "tenure" | "native_title" | "land_status";
type Attrs = Record<string, unknown>;

export interface LayerSpec {
  category: Category;
  record_type: string;
  source_ref: string;
  service: string;
  layer: number;
  name: string;
  oid: string;
  fields: string[];
  id: (a: Attrs) => string;
  map: (a: Attrs) => Attrs;
  /** Layer has many point features: only the count within the buffer is reported. */
  countOnly?: boolean;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() && v.trim() !== "n/a" ? v.trim() : null);
/** ArcGIS dates are epoch milliseconds. */
export const day = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString().slice(0, 10) : null);
const num = (v: unknown) => (typeof v === "number" ? v : null);

const RES = `${QLD}/Economy/CurrentQldResourceAuthorities/MapServer`;
const tenure = (layer: number, name: string): LayerSpec => ({
  category: "tenure", record_type: "tenure", source_ref: `QLD-RESAUTH-L${layer}`, service: RES, layer, name, oid: "objectid",
  fields: ["objectid", "displayname", "permittype", "permitsubtype", "permitstatus", "permitstate", "approvedate", "expirydate", "authorisedholdername", "permitname", "permitid", "permittypeabbreviation", "permitminerals", "nativetitlecategory"],
  id: (a) => `${str(a.displayname) ?? "?"} (permitid ${a.permitid})`,
  map: (a) => ({
    tenure_id: str(a.displayname), tenure_type: str(a.permittypeabbreviation), tenure_type_name: str(a.permittype), subtype: str(a.permitsubtype),
    holders: str(a.authorisedholdername) ? [str(a.authorisedholdername)] : [], holder_basis: "authorised (principal) holder name as published",
    status: str(a.permitstatus), sub_status: str(a.permitstate), grant_date: day(a.approvedate), expiry_date: day(a.expirydate),
    permit_name: str(a.permitname), minerals: str(a.permitminerals), native_title_category: str(a.nativetitlecategory), permit_id: num(a.permitid),
  }),
});

const abandoned = (layer: number, type: string, name: string, fields: string[]): LayerSpec => ({
  category: "land_status", record_type: type, source_ref: `QLD-ABANDONED-MINES-L${layer}`, service: `${QLD}/GeoscientificInformation/AbandonedMines/MapServer`, layer,
  name, oid: "objectid", fields,
  id: (a) => `${a.ams_id ?? a.program_site_id ?? "?"} (objectid ${a.objectid})`,
  map: (a) => Object.fromEntries(Object.entries(a).filter(([k]) => k !== "objectid").map(([k, v]) => [k, typeof v === "string" ? str(v) : v])),
});
const AM_FIELDS = ["objectid", "ams_id", "program_site_id", "ftr_sub", "ftr_rehab", "rehab_yr", "minocc_id"];

export const LAYERS: LayerSpec[] = [
  tenure(40, "Exploration permit for mineral (EPM)"),
  tenure(80, "Mineral development licence (MDL)"),
  tenure(100, "Mining claim (MC)"),
  tenure(120, "Mining lease (ML)"),
  tenure(140, "Mining lease surface area"),
  {
    category: "native_title", record_type: "determination_outcome", source_ref: "NNTT-DETERMINATION-OUTCOMES", service: NNTT, layer: 5, name: "Native Title Determination Outcomes",
    oid: "OBJECTID", fields: ["OBJECTID", "Tribunal_ID", "Name", "FC_No", "FC_Name", "Determination_Date", "Determined_Method", "Determination_Type", "Determined_Outcome", "RNTBC_Name", "Area_Sqkm", "Date_Currency", "Date_extracted"],
    id: (a) => `${a.Tribunal_ID} (OBJECTID ${a.OBJECTID})`,
    map: (a) => ({
      tribunal_id: str(a.Tribunal_ID), name: str(a.Name), federal_court_no: str(a.FC_No), determination_date: day(a.Determination_Date), method: str(a.Determined_Method),
      determination_type: str(a.Determination_Type), outcome: str(a.Determined_Outcome), body_corporate: str(a.RNTBC_Name), area_sqkm: num(a.Area_Sqkm),
      nntt_date_currency: day(a.Date_Currency), nntt_date_extracted: day(a.Date_extracted),
    }),
  },
  {
    category: "native_title", record_type: "application", source_ref: "NNTT-SCHEDULE-APPLICATIONS", service: NNTT, layer: 8, name: "Schedule of Native Title Determination Applications",
    oid: "OBJECTID", fields: ["OBJECTID", "Tribunal_ID", "Name", "FC_No", "Date_Lodged", "Status", "RT_Status", "Date_CurrentReg", "Appl_Type", "Area_Sqkm", "Date_Currency", "Date_extracted"],
    id: (a) => `${a.Tribunal_ID} (OBJECTID ${a.OBJECTID})`,
    map: (a) => ({
      tribunal_id: str(a.Tribunal_ID), name: str(a.Name), federal_court_no: str(a.FC_No), date_lodged: day(a.Date_Lodged), status: str(a.Status),
      registration_test_status: str(a.RT_Status), current_registration_date: day(a.Date_CurrentReg), application_type: str(a.Appl_Type), area_sqkm: num(a.Area_Sqkm),
      nntt_date_currency: day(a.Date_Currency), nntt_date_extracted: day(a.Date_extracted),
    }),
  },
  {
    category: "native_title", record_type: "ilua", source_ref: "NNTT-ILUA", service: NNTT, layer: 4, name: "Indigenous Land Use Agreements",
    oid: "OBJECTID", fields: ["OBJECTID", "Tribunal_ID", "Name", "Agreement_Status", "Date_Lodged", "Date_Registered", "Agreement_Type", "Applicant", "Area_Sqkm", "Date_Currency", "Date_extracted"],
    id: (a) => `${a.Tribunal_ID} (OBJECTID ${a.OBJECTID})`,
    map: (a) => ({
      tribunal_id: str(a.Tribunal_ID), name: str(a.Name), agreement_status: str(a.Agreement_Status), agreement_type: str(a.Agreement_Type), applicant: str(a.Applicant),
      date_lodged: day(a.Date_Lodged), date_registered: day(a.Date_Registered), area_sqkm: num(a.Area_Sqkm), nntt_date_currency: day(a.Date_Currency), nntt_date_extracted: day(a.Date_extracted),
    }),
  },
  {
    category: "land_status", record_type: "protected_area", source_ref: "QLD-PROTECTED-AREAS", service: `${QLD}/Environment/ParksTerrestrialProtectedAreas/MapServer`, layer: 10,
    name: "Protected areas and forests of Queensland", oid: "objectid", fields: ["objectid", "sysintcode", "estatename", "esttype", "legislated", "gazareaha", "iucncode", "curgazdate"],
    id: (a) => `${a.sysintcode ?? a.objectid}`,
    map: (a) => ({ name: str(a.estatename), estate_type: str(a.esttype), legislated: str(a.legislated), area_ha: num(a.gazareaha), iucn_code: str(a.iucncode), current_gazettal_date: day(a.curgazdate) }),
  },
  {
    category: "land_status", record_type: "heritage_place", source_ref: "QLD-HERITAGE-REGISTER", service: `${QLD}/Environment/EnvironmentallySensitiveAreasCategoryB/MapServer`, layer: 270,
    name: "Queensland heritage register", oid: "objectid", fields: ["objectid", "place_id", "placename", "status", "entrydate", "accuracy"],
    id: (a) => `place_id ${a.place_id}`,
    map: (a) => ({ name: str(a.placename), place_id: num(a.place_id), register_status: str(a.status), entry_date: day(a.entrydate), boundary_accuracy: str(a.accuracy) }),
  },
  abandoned(14, "abandoned_mine_program_site", "Abandoned mines: program sites", ["objectid", "program_site_id", "mine_name", "main_commodity", "class", "status"]),
  abandoned(85, "abandoned_mine_pit", "Abandoned mines: pit", AM_FIELDS),
  abandoned(105, "abandoned_mine_shallow_workings", "Abandoned mines: shallow workings area", AM_FIELDS),
  abandoned(110, "abandoned_mine_openings_area", "Abandoned mines: mine openings area", AM_FIELDS),
  { ...abandoned(45, "abandoned_mine_openings_count", "Abandoned mines: mine openings (points)", ["objectid"]), countOnly: true },
];

export interface LandRow extends Attrs {
  category: Category;
  record_type: string;
  record_id: string;
  relation: "contains_site_point" | "within_buffer";
  layer: string;
  source_ref: string;
  source_url: string;
  checked_at: string;
}

export interface LayerCheck {
  category: Category;
  layer: string;
  source_ref: string;
  source_url: string;
  point_url: string;
  count_contains: number | null;
  count_within_buffer: number | null;
  error: string | null;
  truncated: boolean;
  checked_at: string;
}

export interface LandResult {
  rows: Record<Category, LandRow[]>;
  checks: LayerCheck[];
  not_found: string[];
  /** Things that are present but limited (list cut at the row cap, service record limit). */
  notes: string[];
  checked_at: string;
}

export interface LandDeps {
  fetch: typeof fetch;
  now: () => Date;
  timeoutMs?: number;
}

export function queryUrl(spec: LayerSpec, site: Pick<Site, "lat" | "lon">, withBuffer: boolean): string {
  const q = new URLSearchParams({
    f: "json", geometry: `${site.lon},${site.lat}`, geometryType: "esriGeometryPoint", inSR: "4326", spatialRel: "esriSpatialRelIntersects",
  });
  if (withBuffer) {
    q.set("distance", String(BUFFER_M));
    q.set("units", "esriSRUnit_Meter");
  }
  // returnCountOnly is not used: the service answers it with a mixed-SRID error on the points layer (seen 2026-11-21), so counts come from the features.
  q.set("outFields", spec.fields.join(","));
  q.set("returnGeometry", "false");
  return `${spec.service}/${spec.layer}/query?${q}`;
}

type Hit = { features: { attributes: Attrs }[]; count: number; truncated: boolean };

async function arcgis(deps: LandDeps, url: string): Promise<Hit | { error: string }> {
  const timeout = deps.timeoutMs ?? QUERY_TIMEOUT_MS;
  try {
    const res = await deps.fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const j = (await res.json()) as { error?: { code?: number; message?: string }; features?: { attributes: Attrs }[]; count?: number; exceededTransferLimit?: boolean };
    if (j.error) return { error: `service error ${j.error.code ?? ""} ${j.error.message ?? ""}`.trim() };
    if (typeof j.count === "number") return { features: [], count: j.count, truncated: false };
    if (!Array.isArray(j.features)) return { error: "unexpected response (no features array)" };
    return { features: j.features, count: j.features.length, truncated: Boolean(j.exceededTransferLimit) };
  } catch (e) {
    const err = e as Error;
    return { error: err.name === "TimeoutError" || err.name === "AbortError" ? `timed out after ${timeout} ms` : `request failed: ${err.message}` };
  }
}

async function pool<T>(items: (() => Promise<T>)[], size: number): Promise<T[]> {
  const out: T[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await items[i]!();
      }
    }),
  );
  return out;
}

export const MAX_ROWS_PER_LAYER = 25;

interface LayerRun {
  rows: LandRow[];
  check: LayerCheck;
}

async function checkLayer(spec: LayerSpec, site: Site, deps: LandDeps, at: string): Promise<LayerRun> {
  const near = queryUrl(spec, site, true);
  const point = queryUrl(spec, site, false);
  const [n, p] = await Promise.all([arcgis(deps, near), arcgis(deps, point)]);
  const check: LayerCheck = {
    category: spec.category, layer: spec.name, source_ref: spec.source_ref, source_url: near, point_url: point, count_contains: null, count_within_buffer: null,
    error: null, truncated: false, checked_at: at,
  };
  if ("error" in n) return { rows: [], check: { ...check, error: n.error } };
  if ("error" in p) return { rows: [], check: { ...check, error: p.error } };
  check.count_within_buffer = n.count;
  check.count_contains = p.count;
  check.truncated = n.truncated;
  if (spec.countOnly) return { rows: [], check };
  const inside = new Set(p.features.map((f) => String(f.attributes[spec.oid])));
  const rows: LandRow[] = n.features.map((f) => {
    const contains = inside.has(String(f.attributes[spec.oid]));
    return {
      category: spec.category, record_type: spec.record_type, record_id: spec.id(f.attributes), relation: contains ? "contains_site_point" : "within_buffer",
      layer: spec.name, ...spec.map(f.attributes), source_ref: spec.source_ref, source_url: contains ? point : near, checked_at: at,
    } as LandRow;
  });
  rows.sort((a, b) => Number(b.relation === "contains_site_point") - Number(a.relation === "contains_site_point"));
  return { rows, check };
}

/** Live point queries to the official services, cached per site and layer for 24 hours. A failed layer is reported, never filled in or cached. */
export function createLand(deps: LandDeps) {
  const cache = new Map<string, { at: number; value: LayerRun }>();
  async function run(spec: LayerSpec, site: Site): Promise<LayerRun> {
    const key = `${site.site_no}:${spec.source_ref}`;
    const hit = cache.get(key);
    if (hit && deps.now().getTime() - hit.at < CACHE_TTL_MS) return hit.value;
    const value = await checkLayer(spec, site, deps, deps.now().toISOString());
    if (!value.check.error) cache.set(key, { at: deps.now().getTime(), value });
    return value;
  }
  return {
    async query(site: Site, categories: Category[]): Promise<LandResult> {
      const specs = LAYERS.filter((l) => categories.includes(l.category));
      const results = await pool(specs.map((s) => () => run(s, site)), 6);
      const rows: Record<Category, LandRow[]> = { tenure: [], native_title: [], land_status: [] };
      const checks: LayerCheck[] = [];
      const notFound: string[] = [];
      const notes: string[] = [];
      results.forEach(({ rows: r, check }, i) => {
        const spec = specs[i]!;
        checks.push(check);
        if (check.error) notFound.push(`${spec.category}: ${spec.name} not checked (${check.error}); no value is given for it`);
        const shown = r.slice(0, MAX_ROWS_PER_LAYER);
        rows[spec.category].push(...shown);
        if (r.length > shown.length) notes.push(`${spec.category}: ${spec.name} has ${r.length} records within ${BUFFER_M / 1000} km; the first ${shown.length} (those over the site point first) are listed`);
        if (check.truncated) notes.push(`${spec.category}: ${spec.name} hit the service's record limit; the list may be incomplete`);
      });
      for (const c of categories) {
        const layerChecks = checks.filter((x) => x.category === c);
        if (layerChecks.every((x) => !x.error) && !rows[c].length) {
          notFound.push(`${c}: nothing recorded over the site point or within ${BUFFER_M / 1000} km in the ${layerChecks.length} layers checked`);
        }
      }
      return { rows, checks, not_found: notFound, notes, checked_at: deps.now().toISOString() };
    },
  };
}

export type Land = ReturnType<typeof createLand>;

const CAT_LABEL: Record<Category, string> = { tenure: "Tenure", native_title: "Native title", land_status: "Land status" };

/** Plain-words answer for the categories asked; the rows carry the detail. */
export function describeLand(siteName: string, siteNo: number, result: LandResult, categories: Category[]): { answer: string; brief: string } {
  const km = BUFFER_M / 1000;
  const parts: string[] = [
    `${siteName} (GSQ site ${siteNo}): live point queries to the official services on ${result.checked_at.slice(0, 10)}, matching the site point (point-in-polygon) and anything within ${km} km of it; each record says which.`,
  ];
  const rel = (r: LandRow) => (r.relation === "contains_site_point" ? "over the site point" : `within ${km} km`);
  for (const c of categories) {
    const rows = result.rows[c];
    const label = CAT_LABEL[c];
    if (!rows.length) {
      parts.push(`${label}: none listed.`);
      continue;
    }
    if (c === "tenure") {
      const uniq = (l: LandRow[]) => l.filter((r, i) => l.findIndex((x) => x.tenure_id === r.tenure_id) === i);
      const over = uniq(rows.filter((r) => r.relation === "contains_site_point"));
      const fmt = (r: LandRow) =>
        `${r.tenure_id} (${(r.holders as string[]).join(", ") || "holder not stated"}; ${r.status ?? "status not stated"}${r.sub_status && r.sub_status !== "None" ? `, ${r.sub_status}` : ""}; granted ${r.grant_date ?? "?"}, expiry ${r.expiry_date ?? "?"}; ${rel(r)})`;
      const other = uniq(rows.filter((r) => r.relation !== "contains_site_point" && !over.some((o) => o.tenure_id === r.tenure_id)));
      parts.push(`${label}: ${over.length} over the site point${over.length ? `: ${over.slice(0, 6).map(fmt).join("; ")}` : ""}; ${other.length} more within ${km} km${other.length ? ` (for example ${other.slice(0, 3).map(fmt).join("; ")})` : ""}.`);
    } else if (c === "native_title") {
      const d = rows.filter((r) => r.record_type === "determination_outcome");
      const a = rows.filter((r) => r.record_type === "application");
      const i = rows.filter((r) => r.record_type === "ilua");
      const names = (l: LandRow[], f: (r: LandRow) => string) => [...new Set(l.map(f))].slice(0, 5).join("; ");
      parts.push(
        `${label}: ${d.length} determination outcome record${d.length === 1 ? "" : "s"}${d.length ? ` (${names(d, (r) => `${r.name}: ${r.outcome} (${r.determination_type}), ${rel(r)}`)})` : ""}; ${a.length} application${a.length === 1 ? "" : "s"}${a.length ? ` (${names(a, (r) => `${r.name} ${r.tribunal_id}, ${r.status}, ${r.registration_test_status ?? "registration status not stated"}, ${rel(r)}`)})` : ""}; ${i.length} ILUA${i.length === 1 ? "" : "s"}${i.length ? ` (${names(i, (r) => `${r.name} ${r.tribunal_id}, ${r.agreement_status}, ${rel(r)}`)})` : ""}.`,
      );
    } else {
      const by = (t: string) => rows.filter((r) => r.record_type === t);
      const bits: string[] = [];
      const pa = by("protected_area");
      bits.push(pa.length ? `protected area${pa.length > 1 ? "s" : ""}: ${pa.map((r) => `${r.name} (${r.estate_type}, ${rel(r)})`).join("; ")}` : "no protected area");
      const hp = by("heritage_place");
      bits.push(hp.length ? `${hp.length} Queensland Heritage Register place${hp.length > 1 ? "s" : ""} (${hp.filter((r) => r.relation === "contains_site_point").length} over the site point; e.g. ${hp.slice(0, 3).map((r) => r.name).join("; ")})` : "no heritage register place");
      const am = rows.filter((r) => r.record_type.startsWith("abandoned_mine"));
      const sites = by("abandoned_mine_program_site");
      bits.push(am.length ? `${am.length} abandoned-mines polygon record${am.length > 1 ? "s" : ""}${sites.length ? ` (program site: ${sites.map((r) => `${r.mine_name} ${r.program_site_id}, ${r.status}`).join("; ")})` : ""}` : "no abandoned-mines polygon record");
      const openings = result.checks.find((x) => x.source_ref === "QLD-ABANDONED-MINES-L45");
      if (openings && openings.count_within_buffer !== null) bits.push(`${openings.count_within_buffer} recorded mine openings within ${km} km`);
      parts.push(`${label}: ${bits.join("; ")}.`);
    }
  }
  if (result.not_found.length) parts.push(`Not found or not checked: ${result.not_found.join("; ")}.`);
  if (result.notes.length) parts.push(`Note: ${result.notes.join("; ")}.`);
  parts.push(CAVEAT);
  const n = categories.map((c) => `${result.rows[c].length} ${c.replace("_", " ")}`).join(", ");
  return { answer: parts.join(" "), brief: `${siteName}: ${n} (checked ${result.checked_at.slice(0, 10)})`.slice(0, 80) };
}
