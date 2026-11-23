/**
 * "What might remain today" intelligence for a site: later exploration, modern reported resources, access and infrastructure,
 * and environmental records. Same row conventions as land.ts (source_ref, source_url = exact query URL, record_id, relation,
 * checked_at); a source that cannot establish something comes back under not_found with the reason, never a guess.
 */
import { arcgis, checkLayer, day, num, pool, qldDay, queryUrl, str, BUFFER_M, CACHE_TTL_MS, MAX_ROWS_PER_LAYER, QLD, type Attrs, type Land, type LandDeps, type LandRow, type LayerCheck, type LayerSpec } from "./land.ts";
import { distanceKm, type Site } from "./match.ts";
import { GA_WFS, USER_AGENT } from "./sources.ts";

export type RemCategory = "exploration" | "resources" | "access" | "environment";
export const REM_CATEGORIES: RemCategory[] = ["exploration", "resources", "access", "environment"];

export const REMAINING_CAVEAT =
  "These records show what has been drilled, reported, mapped or registered near the site. They are not an estimate of gold remaining and say nothing about whether any deposit is economic; that needs a geologist. Modern reported resources are kept apart from historical production.";
export const RESOURCE_LABEL = "modern reported resource (JORC/as published), not historical production and not a claim about what remains";
export const ACCESS_LABEL = "straight-line distance, not route distance";
export const CAVEATS: Record<RemCategory, string> = {
  exploration: "A borehole or company report near the site is evidence that exploration took place, not of what it found: no assay or result is given here. Boreholes are those on the Geological Survey of Queensland mineral boreholes layer; many have no drill date recorded.",
  resources: `Each figure is ${RESOURCE_LABEL}. Tonnes, grade and category are as published by Geoscience Australia from company reports; contained metal is derived here as tonnes times grade and is not a published figure.`,
  access: `All distances are ${ACCESS_LABEL}; they say nothing about road condition, legal access or the cost of connecting power.`,
  environment: "A register or abandoned-mines record is not an assessment of liability, contamination or rehabilitation cost. Contaminated-land and environmental-management registers were not available as keyless spatial layers and are not checked.",
};

const BORE = `${QLD}/GeoscientificInformation/Boreholes/MapServer`;
const REPORT_INDEX = `${QLD}/GeoscientificInformation/ReportIndex/MapServer/0`;
const GA_REST = "https://services.ga.gov.au/gis/rest/services/Electricity_Infrastructure/MapServer/2";
const GEOSCAPE = "https://services-ap1.arcgis.com/ypkPEy1AmwPKGNNv/arcgis/rest/services";

export const MAX_CR_ROWS = 25;
/** Radii (km) tried in turn for the nearest town, road and power line; the first radius with any feature wins. */
export const SEARCH_RADII_KM = [5, 20, 50, 150, 400];

const boreSpec: LayerSpec = {
  category: "exploration", record_type: "borehole", source_ref: "QLD-BOREHOLES-L6", service: BORE, layer: 6, name: "Boreholes Mineral", oid: "objectid",
  fields: ["objectid", "bore_no", "borehole_pid", "bore_name", "operator_name", "bore_type", "bore_subtype", "result", "status", "rig_release_date", "total_depth_driller", "total_depth_logger", "tenure_type", "tenure_no", "company_report_no", "company_report_link", "qdex_data_link", "latitude", "longitude"],
  id: (a) => `${a.borehole_pid ?? "?"} (bore_no ${a.bore_no})`, map: () => ({}),
};

const eaSpec: LayerSpec = {
  category: "environment", record_type: "environmental_authority", source_ref: "QLD-ENVIRONMENTAL-AUTHORITIES-L140", service: `${QLD}/Boundaries/AdminBoundariesFramework/MapServer`, layer: 140,
  name: "Environmental authority locations", oid: "objectid",
  fields: ["objectid", "permit_ref_no", "permit_version", "permit_type", "status", "grant_date", "primary_holder", "era", "era_category", "permit_link", "site"],
  id: (a) => `${a.permit_ref_no} (objectid ${a.objectid})`,
  map: (a) => ({ permit_ref_no: str(a.permit_ref_no), permit_version: num(a.permit_version), permit_type: str(a.permit_type), status: str(a.status), grant_date: qldDay(a.grant_date), holder: str(a.primary_holder), activity: str(a.era), activity_category: str(a.era_category), register_link: str(a.permit_link), location: str(a.site) }),
};
const tailingsSpec: LayerSpec = {
  category: "environment", record_type: "abandoned_mine_tailings", source_ref: "QLD-ABANDONED-MINES-L90", service: `${QLD}/GeoscientificInformation/AbandonedMines/MapServer`, layer: 90,
  name: "Abandoned mines: tailings", oid: "objectid", fields: ["objectid", "ams_id", "program_site_id", "ftr_sub", "ftr_rehab", "rehab_yr", "minocc_id"],
  id: (a) => `${a.ams_id ?? a.program_site_id ?? "?"} (objectid ${a.objectid})`,
  map: (a) => Object.fromEntries(Object.entries(a).filter(([k]) => k !== "objectid").map(([k, v]) => [k, typeof v === "string" ? str(v) : v])),
};

export interface RemRow extends Attrs {
  category: RemCategory;
  record_type: string;
  record_id: string;
  relation: string;
  source_ref: string;
  source_url: string;
  checked_at: string;
}

export interface RemainingResult {
  rows: Record<RemCategory, RemRow[]>;
  checks: LayerCheck[];
  not_found: string[];
  notes: string[];
  checked_at: string;
}

interface Part {
  rows: RemRow[];
  checks: LayerCheck[];
  not_found: string[];
  notes: string[];
  /** A part with an error is not cached. */
  failed: boolean;
}

const emptyPart = (): Part => ({ rows: [], checks: [], not_found: [], notes: [], failed: false });
const mkCheck = (category: RemCategory, layer: string, source_ref: string, url: string, at: string, over: Partial<LayerCheck> = {}): LayerCheck => ({
  category, layer, source_ref, source_url: url, point_url: url, count_contains: null, count_within_buffer: null, error: null, truncated: false, checked_at: at, ...over,
});

const km = (m: number) => Math.round((m / 1000) * 10) / 10;

// ---------- geometry: nearest feature, straight line ----------

type Pt = [number, number];
/** Distance in km from the site to a point or polyline, planar on a local projection around the site (error well under 1 % at these ranges). */
export function minDistanceKm(site: Pick<Site, "lat" | "lon">, g: { x?: number; y?: number; paths?: number[][][] } | undefined): number | null {
  if (!g) return null;
  const R = 6371.0088;
  const k = Math.PI / 180;
  const cos = Math.cos(site.lat * k);
  const proj = (p: Pt): Pt => [R * cos * (p[0] - site.lon) * k, R * (p[1] - site.lat) * k];
  const dSeg = (a: Pt, b: Pt) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / l2));
    return Math.hypot(a[0] + t * dx, a[1] + t * dy);
  };
  if (typeof g.x === "number" && typeof g.y === "number") return distanceKm(site.lat, site.lon, g.y, g.x);
  let best = Infinity;
  for (const path of g.paths ?? []) {
    const pr = path.map((p) => proj([p[0]!, p[1]!]));
    if (pr.length === 1) best = Math.min(best, Math.hypot(pr[0]![0], pr[0]![1]));
    for (let i = 1; i < pr.length; i++) best = Math.min(best, dSeg(pr[i - 1]!, pr[i]!));
  }
  return Number.isFinite(best) ? best : null;
}

interface NearestSpec {
  record_type: string;
  source_ref: string;
  layer_name: string;
  url: string;
  where?: string;
  fields: string[];
  map: (a: Attrs) => Attrs;
  id: (a: Attrs) => string;
}

export function nearestUrl(spec: NearestSpec, site: Pick<Site, "lat" | "lon">, radiusKm: number): string {
  const q = new URLSearchParams({
    f: "json", geometry: `${site.lon},${site.lat}`, geometryType: "esriGeometryPoint", inSR: "4326", spatialRel: "esriSpatialRelIntersects",
    distance: String(radiusKm * 1000), units: "esriSRUnit_Meter", outFields: spec.fields.join(","), returnGeometry: "true", outSR: "4326",
  });
  if (spec.where) q.set("where", spec.where);
  return `${spec.url}/query?${q}`;
}

const lower = (a: Attrs): Attrs => Object.fromEntries(Object.entries(a).map(([k, v]) => [k.toLowerCase(), v]));

const NEAREST: NearestSpec[] = [
  {
    record_type: "nearest_town", source_ref: "GEOSCAPE-TOWN-POINTS", layer_name: "Town Points (Geoscape Administrative Boundaries, via the Digital Atlas of Australia)", url: `${GEOSCAPE}/Town_Point/FeatureServer/0`,
    where: "date_retired IS NULL", fields: ["town_pid", "town_name", "population", "town_class", "state"],
    id: (a) => `town_pid ${a.town_pid}`, map: (a) => ({ name: str(a.town_name), population: num(a.population), town_class: num(a.town_class), state_code: num(a.state), population_note: "population as published on the layer; its reference year is not stated there" }),
  },
  {
    record_type: "nearest_town_1000_plus", source_ref: "GEOSCAPE-TOWN-POINTS", layer_name: "Town Points (Geoscape Administrative Boundaries, via the Digital Atlas of Australia), population 1,000 or more", url: `${GEOSCAPE}/Town_Point/FeatureServer/0`,
    where: "date_retired IS NULL AND population >= 1000", fields: ["town_pid", "town_name", "population", "town_class", "state"],
    id: (a) => `town_pid ${a.town_pid}`, map: (a) => ({ name: str(a.town_name), population: num(a.population), town_class: num(a.town_class), state_code: num(a.state), population_note: "population as published on the layer; its reference year is not stated there" }),
  },
  {
    record_type: "nearest_major_road", source_ref: "GEOSCAPE-MAJOR-ROADS", layer_name: "Major Roads (Geoscape Roads, via the Digital Atlas of Australia)", url: `${GEOSCAPE}/MajorRoads/FeatureServer/0`,
    fields: ["road_id", "full_street_name", "national_route", "state_route", "hierarchy", "surface", "status", "jurisdiction_control", "state"],
    id: (a) => `road_id ${a.road_id}`,
    map: (a) => ({ name: str(a.full_street_name), national_route: str(a.national_route), state_route: str(a.state_route), hierarchy: str(a.hierarchy), surface: str(a.surface), status: str(a.status), jurisdiction: str(a.jurisdiction_control), state: str(a.state) }),
  },
  {
    record_type: "nearest_power_line", source_ref: "GA-ELECTRICITY-INFRASTRUCTURE-L2", layer_name: "Power Lines (Geoscience Australia Electricity Infrastructure), operational", url: GA_REST,
    where: "STATUS='Operational'", fields: ["OBJECTID", "FEATURE_NAME", "FEATURE_SUBTYPE", "CAPACITY_KV", "STATUS", "STATE", "SPATIAL_CONFIDENCE", "FEATURE_SOURCE_DATE"],
    id: (a) => `OBJECTID ${a.objectid}`,
    map: (a) => ({ name: str(a.feature_name), subtype: str(a.feature_subtype), capacity_kv: num(a.capacity_kv), status: str(a.status), state: str(a.state), spatial_confidence: num(a.spatial_confidence), feature_source_date: str(a.feature_source_date) }),
  },
];

async function nearest(spec: NearestSpec, site: Site, deps: LandDeps, at: string): Promise<Part> {
  const part = emptyPart();
  let lastUrl = nearestUrl(spec, site, SEARCH_RADII_KM[0]!);
  for (const r of SEARCH_RADII_KM) {
    const url = nearestUrl(spec, site, r);
    lastUrl = url;
    const res = await arcgis(deps, url);
    if ("error" in res) {
      part.failed = true;
      part.checks.push(mkCheck("access", spec.layer_name, spec.source_ref, url, at, { error: res.error }));
      part.not_found.push(`access: ${spec.layer_name} not checked (${res.error}); no value is given for it`);
      return part;
    }
    if (!res.features.length) continue;
    type Feat = { attributes: Attrs; geometry?: { x?: number; y?: number; paths?: number[][][] } };
    const scored = (res.features as Feat[])
      .map((f) => ({ f, d: minDistanceKm(site, f.geometry) }))
      .filter((x): x is { f: Feat; d: number } => x.d !== null)
      .sort((a, b) => a.d - b.d);
    const best = scored[0];
    part.checks.push(mkCheck("access", spec.layer_name, spec.source_ref, url, at, { count_within_buffer: res.count, truncated: res.truncated }));
    if (!best) break;
    const a = lower(best.f.attributes);
    part.rows.push({
      category: "access", record_type: spec.record_type, record_id: spec.id(a), relation: "nearest_straight_line", layer: spec.layer_name,
      ...spec.map(a), distance_km: Math.round(best.d * 10) / 10, distance_basis: ACCESS_LABEL, search_radius_km: r, candidates_in_radius: res.count,
      source_ref: spec.source_ref, source_url: url, checked_at: at,
    });
    if (res.truncated) part.notes.push(`access: ${spec.layer_name} hit the service's record limit inside ${r} km; the nearest listed may not be the nearest`);
    return part;
  }
  if (!part.checks.length) part.checks.push(mkCheck("access", spec.layer_name, spec.source_ref, lastUrl, at, { count_within_buffer: 0 }));
  part.not_found.push(`access: no ${spec.record_type.replace(/_/g, " ")} within ${SEARCH_RADII_KM[SEARCH_RADII_KM.length - 1]} km in ${spec.layer_name}`);
  return part;
}

// ---------- exploration ----------

async function boreholes(site: Site, deps: LandDeps, at: string): Promise<Part> {
  const part = emptyPart();
  const url = queryUrl(boreSpec, site, true);
  const res = await arcgis(deps, url);
  if ("error" in res) {
    part.failed = true;
    part.checks.push(mkCheck("exploration", boreSpec.name, boreSpec.source_ref, url, at, { error: res.error }));
    part.not_found.push(`exploration: ${boreSpec.name} not checked (${res.error}); no value is given for it`);
    return part;
  }
  part.checks.push(mkCheck("exploration", boreSpec.name, boreSpec.source_ref, url, at, { count_within_buffer: res.count, truncated: res.truncated }));
  const rows = res.features.map((f) => {
    const a = f.attributes;
    const lat = Number(a.latitude), lon = Number(a.longitude);
    const d = Number.isFinite(lat) && Number.isFinite(lon) ? distanceKm(site.lat, site.lon, lat, lon) * 1000 : null;
    const date = qldDay(a.rig_release_date);
    return {
      category: "exploration", record_type: "borehole", record_id: boreSpec.id(a), relation: "within_buffer", layer: boreSpec.name,
      borehole_pid: str(a.borehole_pid), bore_no: num(a.bore_no), name: str(a.bore_name), operator: str(a.operator_name) === "UNKNOWN" ? null : str(a.operator_name),
      type: str(a.bore_type), subtype: str(a.bore_subtype), result: str(a.result) === "UNKNOWN" ? null : str(a.result), status: str(a.status) === "UNKNOWN" ? null : str(a.status),
      rig_release_date: date, year: date ? Number(date.slice(0, 4)) : null, total_depth_m: num(a.total_depth_driller) ?? num(a.total_depth_logger),
      tenure: str(a.tenure_type) && a.tenure_no ? `${str(a.tenure_type)} ${a.tenure_no}` : null,
      company_report_no: str(a.company_report_no), company_report_link: str(a.company_report_link), data_link: str(a.qdex_data_link),
      distance_m: d === null ? null : Math.round(d), source_ref: boreSpec.source_ref, source_url: url, checked_at: at,
    } as RemRow;
  });
  rows.sort((x, y) => (x.distance_m as number ?? 1e9) - (y.distance_m as number ?? 1e9));
  if (!rows.length) {
    part.not_found.push(`exploration: no mineral borehole recorded within ${BUFFER_M / 1000} km of the site point on the Geological Survey of Queensland boreholes layer`);
    return part;
  }
  const shown = rows.slice(0, MAX_ROWS_PER_LAYER);
  part.rows.push(...shown);
  const dated = rows.filter((r) => r.year !== null).length;
  const ops = [...new Set(rows.map((r) => r.operator).filter(Boolean))];
  part.notes.push(`exploration: ${rows.length} mineral borehole${rows.length === 1 ? "" : "s"} within ${BUFFER_M / 1000} km${rows.length > shown.length ? `; the nearest ${shown.length} are listed` : ""}; ${dated} with a rig-release date, ${rows.length - dated} without; operators named: ${ops.length ? ops.slice(0, 6).join(", ") : "none recorded"}`);
  if (res.truncated) part.notes.push("exploration: the boreholes layer hit the service's record limit; the list may be incomplete");
  return part;
}

/** Report numbers MINOCC links to the site, with title and year from the GSQ report index where it holds them. */
export function reportPageUrl(cr: number): string {
  return `https://geoscience.data.qld.gov.au/report/cr${String(cr).padStart(6, "0")}`;
}
export function reportIndexUrl(nums: number[]): string {
  const q = new URLSearchParams({ f: "json", where: `reportnum IN (${nums.join(",")})`, outFields: "reportnum,title,type,permit,startdate,enddate,submitter,link", returnGeometry: "false" });
  return `${REPORT_INDEX}/query?${q}`;
}

async function companyReports(site: Site, cr: number[], deps: LandDeps, at: string): Promise<Part> {
  const part = emptyPart();
  if (!cr.length) {
    part.not_found.push("exploration: the MINOCC 2017 database links no company report (CR) number to this site");
    return part;
  }
  const nums = [...cr].sort((a, b) => b - a).slice(0, 60);
  const url = reportIndexUrl(nums);
  const res = await arcgis(deps, url);
  let idx = new Map<number, Attrs>();
  let checkErr: string | null = null;
  if ("error" in res) {
    checkErr = res.error;
    part.failed = true;
    part.not_found.push(`exploration: report titles and years not checked (GSQ report index: ${res.error}); the CR numbers below are as MINOCC lists them`);
  } else {
    idx = new Map(res.features.map((f) => [Number(f.attributes.reportnum), f.attributes]));
  }
  part.checks.push(mkCheck("exploration", "GSQ report index (open-file reports with a mapped extent)", "QLD-REPORT-INDEX-L0", url, at, { error: checkErr, count_within_buffer: "error" in res ? null : res.count }));
  const rows: RemRow[] = cr.map((n) => {
    const a = idx.get(n);
    const start = a ? day(a.startdate) : null, end = a ? day(a.enddate) : null;
    return {
      category: "exploration", record_type: "company_report", record_id: `CR ${n}`, relation: "linked_by_minocc", layer: "MINOCC 2017 Company reports table, matched to the GSQ report index",
      cr_number: n, title: a ? str(a.title) : null, report_type: a ? str(a.type) : null, permit: a ? str(a.permit) : null, submitter: a ? str(a.submitter) : null,
      period_from: start, period_to: end, year: end ? Number(end.slice(0, 4)) : start ? Number(start.slice(0, 4)) : null, in_report_index: a ? true : checkErr ? null : false,
      report_page_url: (a && str(a.link)) || reportPageUrl(n),
      report_page_url_basis: a && str(a.link) ? "link field published by the GSQ report index" : "built from the geoscience.data.qld.gov.au /report/crNNNNNN pattern used by the index's link field; the page was not fetched (the portal answers automated clients with 403)",
      source_ref: a ? "QLD-REPORT-INDEX-L0" : "GSQ-MINOCC", source_url: a ? url : `MINOCC-2017:Company reports:${site.site_no}`, checked_at: at,
    } as RemRow;
  });
  rows.sort((x, y) => ((y.year as number | null) ?? -1) - ((x.year as number | null) ?? -1) || (y.cr_number as number) - (x.cr_number as number));
  const shown = rows.slice(0, MAX_CR_ROWS);
  part.rows.push(...shown);
  const inIdx = rows.filter((r) => r.in_report_index).length;
  part.notes.push(`exploration: MINOCC links ${cr.length} company report${cr.length === 1 ? "" : "s"} to this site${rows.length > shown.length ? `; the ${shown.length} most recent by report year are listed` : ""}; ${checkErr ? "titles not checked" : `${inIdx} found in the GSQ report index with a title and year, ${rows.length - inIdx} not (the index holds open-file reports with a mapped extent only)`}`);
  return part;
}

// ---------- resources ----------

const TROY_OZ_G = 31.1034768;
const UNIT_T: Record<string, number> = { t: 1, kt: 1e3, mt: 1e6 };

function wfsUrl(typeName: string, cql: string, count = 1000): string {
  const q = new URLSearchParams({ service: "WFS", version: "2.0.0", request: "GetFeature", typeNames: typeName, outputFormat: "application/json", cql_filter: cql, count: String(count) });
  return `${GA_WFS}?${q}`;
}
export function depositsUrl(site: Pick<Site, "lat" | "lon">): string {
  const dLat = (BUFFER_M / 1000 / 111.19) * 1.05;
  const dLon = dLat / Math.cos((site.lat * Math.PI) / 180);
  return wfsUrl("ama:MineralDeposits", `LONG_GDA94 BETWEEN ${(site.lon - dLon).toFixed(5)} AND ${(site.lon + dLon).toFixed(5)} AND LAT_GDA94 BETWEEN ${(site.lat - dLat).toFixed(5)} AND ${(site.lat + dLat).toFixed(5)}`);
}
export function resourcesUrl(enos: number[]): string {
  return wfsUrl("ama:ReservesAndResources", `ENO IN (${enos.join(",")})`);
}

async function wfs(deps: LandDeps, url: string): Promise<{ props: Attrs[]; returned: number } | { error: string }> {
  const timeout = (deps.timeoutMs ?? 8000) * 2;
  try {
    const res = await deps.fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const j = (await res.json()) as { features?: { properties: Attrs }[] };
    if (!Array.isArray(j.features)) return { error: "unexpected response (no features array)" };
    return { props: j.features.map((f) => f.properties), returned: j.features.length };
  } catch (e) {
    const err = e as Error;
    return { error: err.name === "TimeoutError" || err.name === "AbortError" ? `timed out after ${timeout} ms` : `request failed: ${err.message}` };
  }
}

const CATS: { key: string; name: string; basis: "reserve" | "resource"; t: string; g: string }[] = [
  { key: "proved", name: "proved reserve", basis: "reserve", t: "PROVEN_RESERVES", g: "PROVEN_GRADE" },
  { key: "probable", name: "probable reserve", basis: "reserve", t: "PROBABLE_RESERVES", g: "PROBABLE_GRADE" },
  { key: "proved_probable", name: "proved and probable reserve (as published, not summed here)", basis: "reserve", t: "PROVEN_PROBABLE_RESERVES", g: "PROVEN_PROBABLE_GRADE" },
  { key: "measured", name: "measured resource", basis: "resource", t: "MEASURED_RESOURCES", g: "MEASURED_GRADE" },
  { key: "indicated", name: "indicated resource", basis: "resource", t: "INDICATED_RESOURCES", g: "INDICATED_GRADE" },
  { key: "measured_indicated", name: "measured and indicated resource (as published, not summed here)", basis: "resource", t: "MEASURED_INDICATED_RESOURCES", g: "MEASURED_INDICATED_GRADE" },
  { key: "inferred", name: "inferred resource", basis: "resource", t: "INFERRED_RESOURCES", g: "INFERRED_GRADE" },
  { key: "other", name: "other resource", basis: "resource", t: "OTHER_RESOURCES", g: "OTHER_GRADE" },
];

/** Contained metal derived from tonnes and grade; null where the grade unit is not one this converts. */
export function containedMetal(tonnes: number, grade: number | null, gradeUnit: string | null): { value: number; unit: string } | null {
  if (grade === null || !gradeUnit) return null;
  const u = gradeUnit.trim().toLowerCase();
  if (u === "g/t" || u === "ppm") return { value: Math.round((tonnes * grade) / TROY_OZ_G), unit: "troy ounces" };
  if (u === "%") return { value: Math.round((tonnes * grade) / 100), unit: "tonnes" };
  if (u === "kg/t") return { value: Math.round((tonnes * grade) / 1000), unit: "tonnes" };
  return null;
}

async function resources(site: Site, deps: LandDeps, at: string): Promise<Part> {
  const part = emptyPart();
  const dUrl = depositsUrl(site);
  const dep = await wfs(deps, dUrl);
  const layer = "Geoscience Australia mineral deposits (ama:MineralDeposits) and reserves and resources (ama:ReservesAndResources)";
  if ("error" in dep) {
    part.failed = true;
    part.checks.push(mkCheck("resources", layer, "GA-MINERAL-DEPOSITS", dUrl, at, { error: dep.error }));
    part.not_found.push(`resources: Geoscience Australia deposits not checked (${dep.error}); no value is given for it`);
    return part;
  }
  const near = dep.props
    .map((p) => ({ p, d: distanceKm(site.lat, site.lon, Number(p.LAT_GDA94), Number(p.LONG_GDA94)) * 1000 }))
    .filter((x) => Number.isFinite(x.d) && x.d <= BUFFER_M)
    .sort((a, b) => a.d - b.d);
  part.checks.push(mkCheck("resources", "Geoscience Australia mineral deposits (ama:MineralDeposits)", "GA-MINERAL-DEPOSITS", dUrl, at, { count_within_buffer: near.length }));
  if (!near.length) {
    part.not_found.push(`resources: no deposit in Geoscience Australia's mineral deposits layer within ${BUFFER_M / 1000} km of the site point, so no modern reported resource is given`);
    return part;
  }
  const enos = near.map((x) => Number(x.p.ENO));
  const rUrl = resourcesUrl(enos);
  const rr = await wfs(deps, rUrl);
  if ("error" in rr) {
    part.failed = true;
    part.checks.push(mkCheck("resources", "Geoscience Australia reserves and resources (ama:ReservesAndResources)", "GA-RESERVES-AND-RESOURCES", rUrl, at, { error: rr.error }));
    part.not_found.push(`resources: Geoscience Australia resource records not checked (${rr.error}); no value is given for them`);
    return part;
  }
  part.checks.push(mkCheck("resources", "Geoscience Australia reserves and resources (ama:ReservesAndResources)", "GA-RESERVES-AND-RESOURCES", rUrl, at, { count_within_buffer: rr.props.length, truncated: rr.returned >= 1000 }));
  const depNames = near.map((x) => `${x.p.DEPOSIT_NAME} (ENO ${x.p.ENO}, ${km(x.d)} km, location accuracy ${x.p.ACCURACY_M ?? "not stated"} m)`).join("; ");
  if (!rr.props.length) {
    part.not_found.push(`resources: Geoscience Australia lists ${depNames} but holds no reserve or resource record for it`);
    return part;
  }
  // The latest record per zone and commodity; earlier years are counted, not listed.
  const latest = new Map<string, Attrs>();
  for (const p of rr.props) {
    const key = `${p.ENO}|${p.ZONE_ENO}|${p.COMMODITY_CODE}`;
    const cur = latest.get(key);
    if (!cur || String(p.RECORD_DATE) > String(cur.RECORD_DATE) || (p.RECORD_DATE === cur.RECORD_DATE && Number(p.RESOURCE_NO) > Number(cur.RESOURCE_NO))) latest.set(key, p);
  }
  const depOf = new Map(near.map((x) => [Number(x.p.ENO), x]));
  const rows: RemRow[] = [...latest.values()].map((p) => {
    const unit = str(p.TONNAGE_UNIT)?.toLowerCase() ?? "";
    const mult = UNIT_T[unit] ?? null;
    const gradeUnit = str(p.GRADE_UNIT);
    const categories = CATS.flatMap((c) => {
      const raw = num(p[c.t]);
      if (raw === null) return [];
      const tonnes = mult === null ? null : raw * mult;
      const grade = num(p[c.g]);
      return [{ category: c.name, basis: c.basis, tonnage_as_published: raw, tonnage_unit: str(p.TONNAGE_UNIT), tonnes, grade, grade_unit: gradeUnit, contained_metal: tonnes === null ? null : containedMetal(tonnes, grade, gradeUnit) }];
    });
    const d = depOf.get(Number(p.ENO))!;
    return {
      category: "resources", record_type: "modern_resource", record_id: `GA resource_no ${p.RESOURCE_NO} (deposit ENO ${p.ENO}, zone ${p.ZONE_ENO})`, relation: "within_buffer", layer: "Geoscience Australia reserves and resources (ama:ReservesAndResources)",
      label: RESOURCE_LABEL, deposit_name: str(p.DEPOSIT_NAME), deposit_eno: num(p.ENO), distance_m: Math.round(d.d), deposit_location_accuracy_m: num(d.p.ACCURACY_M),
      deposit_operating_status: str(p.OPERATING_STATUS), deposit_companies_current_list: str(d.p.COMPANIES), zone: str(p.ZONE_NAME),
      commodity: str(p.COMMODITY_NAME), commodity_code: str(p.COMMODITY_CODE), reporting_date: str(p.RECORD_DATE), classification_method: str(p.CLASSIFICATION_METHOD),
      resources_inclusive_of_reserves: p.INCLUSIVE === "Y" ? true : p.INCLUSIVE === "N" ? false : null, zeroed: p.ZEROED === "Y" ? true : p.ZEROED === "N" ? false : null,
      published_source: str(p.RESOURCE_REF), categories, contained_metal_basis: "derived here as tonnes x grade (troy ounces for g/t, tonnes for %); not a published figure",
      source_ref: "GA-RESERVES-AND-RESOURCES", source_url: rUrl, checked_at: at,
    } as RemRow;
  });
  const gold = (r: RemRow) => (r.commodity_code === "Au" ? 0 : 1);
  rows.sort((a, b) => gold(a) - gold(b) || String(b.reporting_date).localeCompare(String(a.reporting_date)));
  const shown = rows.slice(0, MAX_ROWS_PER_LAYER);
  part.rows.push(...shown);
  part.notes.push(`resources: ${depNames}; ${rr.props.length} resource record${rr.props.length === 1 ? "" : "s"} across all reporting dates, the latest per zone and commodity listed (${rows.length}${rows.length > shown.length ? `, first ${shown.length} shown` : ""}); earlier reporting dates are not listed`);
  if (rr.returned >= 1000) part.notes.push("resources: the WFS reply reached the 1,000 record request limit; older records may be missing");
  const zeroed = shown.filter((r) => r.zeroed).length;
  if (zeroed) part.notes.push(`resources: ${zeroed} listed record${zeroed === 1 ? " is" : "s are"} flagged ZEROED by Geoscience Australia (the resource was reduced to zero in that report)`);
  return part;
}

// ---------- environment ----------

const ENV_LAYER_CHECKED = "environment: contaminated-land and environmental-management registers: no keyless official spatial layer was found among the Queensland map services (layer names searched 2026-11-23), so they are not checked";

async function environment(site: Site, deps: LandDeps, land: Land, at: string): Promise<Part> {
  const part = emptyPart();
  const [ea, tail, lands] = await Promise.all([checkLayer(eaSpec, site, deps, at), checkLayer(tailingsSpec, site, deps, at), land.query(site, ["land_status"])]);
  for (const [spec, run] of [[eaSpec, ea], [tailingsSpec, tail]] as const) {
    part.checks.push({ ...run.check, category: "environment" });
    if (run.check.error) {
      part.failed = true;
      part.not_found.push(`environment: ${spec.name} not checked (${run.check.error}); no value is given for it`);
    }
  }
  // Environmental authorities: one row per permit, over-the-point first, resource activities first.
  const byPermit = new Map<string, LandRow[]>();
  for (const r of ea.rows) byPermit.set(String(r.permit_ref_no), [...(byPermit.get(String(r.permit_ref_no)) ?? []), r]);
  const eaRows: RemRow[] = [...byPermit.values()].map((g) => {
    const first = g.find((x) => x.relation === "contains_site_point") ?? g[0]!;
    return {
      ...first, category: "environment", record_id: `${first.permit_ref_no} v${first.permit_version ?? "?"}`,
      activities: [...new Set(g.map((x) => String(x.activity)).filter(Boolean))], activity_categories: [...new Set(g.map((x) => String(x.activity_category)).filter(Boolean))],
      locations_in_search: g.length, relation: g.some((x) => x.relation === "contains_site_point") ? "contains_site_point" : "within_buffer",
    } as unknown as RemRow;
  });
  const res = (r: RemRow) => (r.permit_type === "Resource Activity" ? 0 : 1);
  eaRows.sort((a, b) => Number(b.relation === "contains_site_point") - Number(a.relation === "contains_site_point") || res(a) - res(b));
  const shownEa = eaRows.slice(0, MAX_ROWS_PER_LAYER);
  if (!ea.check.error) {
    part.rows.push(...shownEa);
    if (eaRows.length > shownEa.length) part.notes.push(`environment: ${eaRows.length} environmental authorities have a location within ${BUFFER_M / 1000} km; the first ${shownEa.length} (over the site point first, resource activities before other activities) are listed`);
    if (!eaRows.length) part.not_found.push(`environment: no environmental authority location over the site point or within ${BUFFER_M / 1000} km on the Queensland environmental authorities layer`);
  }
  if (!tail.check.error) {
    part.rows.push(...tail.rows.slice(0, MAX_ROWS_PER_LAYER).map((r) => ({ ...r, category: "environment" }) as RemRow));
    if (!tail.rows.length) part.notes.push(`environment: no abandoned-mines tailings polygon within ${BUFFER_M / 1000} km`);
  }
  // Abandoned-mines rows already returned for land status, reused as they are.
  for (const r of lands.rows.land_status.filter((x) => x.record_type.startsWith("abandoned_mine"))) part.rows.push({ ...r, category: "environment", reused_from: "land_status" } as unknown as RemRow);
  for (const c of lands.checks.filter((x) => x.source_ref.startsWith("QLD-ABANDONED-MINES"))) {
    part.checks.push({ ...c, category: "environment" });
    if (c.error) part.failed = true;
  }
  for (const n of lands.not_found.filter((x) => /Abandoned mines/.test(x))) part.not_found.push(n.replace(/^land_status:/, "environment:"));
  const openings = lands.checks.find((x) => x.source_ref === "QLD-ABANDONED-MINES-L45");
  if (openings && openings.count_within_buffer !== null) {
    part.rows.push({
      category: "environment", record_type: "abandoned_mine_openings_count", record_id: `mine openings within ${BUFFER_M / 1000} km`, relation: "within_buffer", layer: "Abandoned mines: mine openings (points)",
      count: openings.count_within_buffer, source_ref: openings.source_ref, source_url: openings.source_url, checked_at: openings.checked_at,
    } as RemRow);
  }
  part.not_found.push(ENV_LAYER_CHECKED);
  return part;
}

// ---------- assembly ----------

export function createRemaining(deps: LandDeps, land: Land) {
  const cache = new Map<string, { at: number; value: Part }>();
  async function memo(key: string, fn: () => Promise<Part>): Promise<Part> {
    const hit = cache.get(key);
    if (hit && deps.now().getTime() - hit.at < CACHE_TTL_MS) return hit.value;
    const value = await fn();
    if (!value.failed) cache.set(key, { at: deps.now().getTime(), value });
    return value;
  }
  return {
    /** `cr` is the list of company report numbers MINOCC links to the site (empty if none). */
    async query(site: Site, categories: RemCategory[], cr: number[]): Promise<RemainingResult> {
      const at = deps.now().toISOString();
      const jobs: { cat: RemCategory; run: () => Promise<Part> }[] = [];
      const add = (cat: RemCategory, key: string, fn: () => Promise<Part>) => jobs.push({ cat, run: () => memo(`${site.site_no}:${key}`, fn) });
      if (categories.includes("exploration")) {
        add("exploration", "boreholes", () => boreholes(site, deps, at));
        add("exploration", "reports", () => companyReports(site, cr, deps, at));
      }
      if (categories.includes("resources")) add("resources", "resources", () => resources(site, deps, at));
      if (categories.includes("access")) for (const s of NEAREST) add("access", s.record_type, () => nearest(s, site, deps, at));
      if (categories.includes("environment")) add("environment", "environment", () => environment(site, deps, land, at));
      const parts = await pool(jobs.map((j) => j.run), 4);
      const rows: Record<RemCategory, RemRow[]> = { exploration: [], resources: [], access: [], environment: [] };
      const checks: LayerCheck[] = [], notFound: string[] = [], notes: string[] = [];
      parts.forEach((p, i) => {
        rows[jobs[i]!.cat].push(...p.rows);
        checks.push(...p.checks);
        notFound.push(...p.not_found);
        notes.push(...p.notes);
      });
      return { rows, checks, not_found: [...new Set(notFound)], notes: [...new Set(notes)], checked_at: at };
    },
  };
}
export type Remaining = ReturnType<typeof createRemaining>;

// ---------- plain-words answer ----------

const LABEL: Record<RemCategory, string> = { exploration: "Exploration", resources: "Resources", access: "Access", environment: "Environment" };

function fmtTonnes(t: number | null): string {
  if (t === null) return "tonnage unit not recognised";
  return t >= 1e6 ? `${Math.round(t / 1e5) / 10} Mt` : t >= 1e3 ? `${Math.round(t / 100) / 10} kt` : `${t} t`;
}

export function describeRemaining(siteName: string, siteNo: number, r: RemainingResult, cats: RemCategory[]): { answer: string; brief: string } {
  const parts: string[] = [`${siteName} (GSQ site ${siteNo}): what might remain today, from official services and registers checked on ${r.checked_at.slice(0, 10)}; each record carries its source, the query URL and the check time.`];
  for (const c of cats) {
    const rows = r.rows[c];
    const label = LABEL[c];
    if (!rows.length) {
      parts.push(`${label}: nothing listed.`);
      continue;
    }
    if (c === "exploration") {
      const bh = rows.filter((x) => x.record_type === "borehole");
      const cr = rows.filter((x) => x.record_type === "company_report");
      const bits: string[] = [];
      const yrs = bh.map((x) => x.year as number | null).filter((y): y is number => y !== null);
      bits.push(bh.length ? `${bh.length} mineral borehole${bh.length === 1 ? "" : "s"} within ${BUFFER_M / 1000} km listed (nearest ${bh[0]!.name} at ${bh[0]!.distance_m} m${bh[0]!.operator ? `, ${bh[0]!.operator}` : ""}${yrs.length ? `; dated ${Math.min(...yrs)} to ${Math.max(...yrs)}` : "; no drill dates recorded"})` : "no mineral borehole listed");
      bits.push(cr.length ? `${cr.length} MINOCC-linked company report${cr.length === 1 ? "" : "s"} listed (latest: CR ${cr[0]!.cr_number}${cr[0]!.title ? ` "${cr[0]!.title}"` : ""}${cr[0]!.year ? `, ${cr[0]!.year}` : ""})` : "no MINOCC-linked company report");
      parts.push(`${label}: ${bits.join("; ")}.`);
    } else if (c === "resources") {
      const bits = rows.slice(0, 4).map((x) => {
        const cs = (x.categories as { category: string; tonnes: number | null; grade: number | null; grade_unit: string | null; contained_metal: { value: number; unit: string } | null }[]).slice(0, 4);
        return `${x.deposit_name}${x.zone && x.zone !== x.deposit_name ? ` / ${x.zone}` : ""} ${x.commodity} as at ${x.reporting_date} (${x.classification_method ?? "classification not stated"}): ${cs.map((k) => `${k.category} ${fmtTonnes(k.tonnes)}${k.grade !== null ? ` at ${k.grade} ${k.grade_unit ?? ""}`.trimEnd() : ""}${k.contained_metal ? `, about ${k.contained_metal.value.toLocaleString("en-AU")} ${k.contained_metal.unit} contained (derived)` : ""}`).join("; ")}`;
      });
      parts.push(`${label}: ${rows.length} record${rows.length === 1 ? "" : "s"}, each a ${RESOURCE_LABEL}: ${bits.join(" | ")}.`);
    } else if (c === "access") {
      const f = (t: string) => rows.find((x) => x.record_type === t);
      const bits: string[] = [];
      const t = f("nearest_town"), t2 = f("nearest_town_1000_plus"), rd = f("nearest_major_road"), pl = f("nearest_power_line");
      if (t) bits.push(`nearest town ${t.name} (${t.distance_km} km${t.population ? `, population ${t.population}` : ""})`);
      if (t2 && t2.name !== t?.name) bits.push(`nearest town of 1,000 or more people ${t2.name} (${t2.distance_km} km, population ${t2.population})`);
      if (rd) bits.push(`nearest major road ${rd.name ?? "(unnamed)"}${rd.national_route || rd.state_route ? ` ${rd.national_route ?? rd.state_route}` : ""} (${rd.distance_km} km; ${String(rd.hierarchy ?? "class not stated").toLowerCase()}, ${String(rd.surface ?? "surface not stated").toLowerCase()})`);
      if (pl) bits.push(`nearest operational power line ${pl.name ?? "(unnamed)"}${pl.capacity_kv ? ` ${pl.capacity_kv} kV` : ""} (${pl.distance_km} km)`);
      parts.push(`${label}: ${bits.join("; ")}; ${ACCESS_LABEL}.`);
    } else {
      const ea = rows.filter((x) => x.record_type === "environmental_authority");
      const ab = rows.filter((x) => x.record_type.startsWith("abandoned_mine") && x.record_type !== "abandoned_mine_openings_count");
      const tl = rows.filter((x) => x.record_type === "abandoned_mine_tailings");
      const op = rows.find((x) => x.record_type === "abandoned_mine_openings_count");
      const eaOver = ea.filter((x) => x.relation === "contains_site_point");
      const prog = ab.find((x) => x.record_type === "abandoned_mine_program_site");
      parts.push(
        `${label}: ${ea.length} environmental authorit${ea.length === 1 ? "y" : "ies"} listed (${eaOver.length} over the site point${eaOver.length ? `, for example ${eaOver.slice(0, 2).map((x) => `${x.permit_ref_no} ${x.holder}, ${String(x.status).toLowerCase()}`).join("; ")}` : ""}); ${ab.length} abandoned-mines record${ab.length === 1 ? "" : "s"}${prog ? ` (program site ${prog.mine_name} ${prog.program_site_id}, ${prog.status})` : ""}, ${tl.length} of them tailings${op ? `; ${op.count} recorded mine openings within ${BUFFER_M / 1000} km` : ""}.`,
      );
    }
  }
  if (r.not_found.length) parts.push(`Not found or not checked: ${r.not_found.join("; ")}.`);
  if (r.notes.length) parts.push(`Note: ${r.notes.join("; ")}.`);
  parts.push(REMAINING_CAVEAT);
  const n = cats.map((c) => `${r.rows[c].length} ${c}`).join(", ");
  return { answer: parts.join(" "), brief: `${siteName}: ${n} (checked ${r.checked_at.slice(0, 10)})`.slice(0, 80) };
}
