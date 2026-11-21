import { gaDepositUrl, gsqSiteUrl } from "./sources.ts";
import type { Site } from "./match.ts";
import { MINOCC_KEY, sourceKey } from "./minocc.ts";
import type { ClosureRecord, EvidenceRecord, OwnershipRecord, ProductionRecord, ReferenceRecord, Store, YearsWorkedRecord } from "./store.ts";

export interface SiteAnswer {
  answer: string;
  brief: string;
  sources: string[];
  body: Record<string, unknown>;
}

const GSQ_REF = "GSQ-MINOCC";
const title = (s: string | null) => (s ? s.toLowerCase().replace(/(^|[\s(-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase()) : "");

function period(from: number | string | null, to: number | string | null): string {
  if (from && to) return from === to ? String(from) : `${from} to ${to}`;
  return from ? `from ${from}` : to ? `to ${to}` : "period not stated";
}

const UNIT_WORD = { t: "tonnes", oz: "oz", kg: "kg" } as const;
function amount(p: Pick<ProductionRecord, "qualifier" | "amount" | "unit" | "commodity">): string {
  return `${p.qualifier ? `${p.qualifier} ` : ""}${p.amount.toLocaleString("en-AU")} ${UNIT_WORD[p.unit]} ${p.commodity}`;
}

/** Explicit, labelled conversions. They are only ever added next to the recorded value, never in its place. */
export const TROY_OZ_PER_KG = 1000 / 31.1034768;
const GRAMS_PER_TROY_OZ = 31.1034768;
export function toTonnes(amount: number, unit: "t" | "kg" | "oz"): number {
  return unit === "t" ? amount : unit === "kg" ? amount / 1000 : (amount * GRAMS_PER_TROY_OZ) / 1e6;
}
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

/** "MINOCC-2017:Production:494270:2" -> table and record id; other source refs have neither. */
function recordOf(ref: string): { source_table: string; record_id: string } | null {
  const [key, table, site, row] = ref.split(":");
  return key === MINOCC_KEY && table && site ? { source_table: table, record_id: row ? `SITE_NO ${site}, row ${row}` : `SITE_NO ${site}` } : null;
}

export function buildSiteAnswer(store: Store, site: Site, others: Site[], matchedBy: string): SiteAnswer {
  const records = store.records.get(site.site_no) ?? [];
  const src = (ref: string) => store.sources[sourceKey(ref)]!;
  /** Plain-words name of a record's source, with the table and record for MINOCC. */
  const label = (ref: string) => {
    const r = recordOf(ref);
    const name = store.sources[sourceKey(ref)]?.label ?? ref;
    return r ? `${name} (${r.source_table}, ${r.record_id})` : name;
  };
  const withRecord = (ref: string) => ({ ...recordOf(ref) });

  const production = records
    .filter((r): r is ProductionRecord => r.kind === "production")
    .map((r) => ({
      commodity: r.commodity, amount: r.amount, unit: r.unit, period_from: r.period_from, period_to: r.period_to,
      basis: r.basis, qualifier: r.qualifier, entity: r.entity, scope: r.scope ?? null,
      ...(r.commodity_code ? { commodity_code: r.commodity_code } : {}), ...(r.form ? { form: r.form } : {}), ...(r.grade ? { grade: r.grade } : {}),
      ...(r.ore_class ? { ore_class: r.ore_class } : {}), ...(r.ore_recorded ? { ore_recorded: r.ore_recorded } : {}), ...(r.comment ? { comment: r.comment } : {}),
      // The recorded amount and unit above are never altered. A conversion, when given, is a separate labelled field.
      ...(r.commodity === "gold" && r.unit !== "oz"
        ? { converted: { amount: round((toTonnes(r.amount, r.unit) * 1e6) / GRAMS_PER_TROY_OZ, 0), unit: "troy oz", basis: `explicit conversion for reading only: 1 troy oz = ${GRAMS_PER_TROY_OZ} g; the recorded value is ${r.amount} ${r.unit}` } }
        : {}),
      source_ref: r.source_ref, ...withRecord(r.source_ref), source_title: src(r.source_ref).title, source_url: src(r.source_ref).url, quote: r.quote,
    }));
  const closure = records
    .filter((r): r is ClosureRecord => r.kind === "closure")
    .map((r) => ({
      year: r.year, reason_text: r.reason_text, reason_class: r.reason_class, entity: r.entity, scope: r.scope ?? null, source_ref: r.source_ref,
      ...withRecord(r.source_ref), ...(r.basis_note ? { basis_note: r.basis_note } : {}),
      page: r.page, source_title: src(r.source_ref).title, source_url: src(r.source_ref).url, quote: r.quote,
    }));
  const yearsWorked = records
    .filter((r): r is YearsWorkedRecord => r.kind === "years_worked")
    .map((r) => ({
      periods: r.periods, entity: r.entity, source_ref: r.source_ref, ...withRecord(r.source_ref), source_title: src(r.source_ref).title, source_url: src(r.source_ref).url, quote: r.quote,
    }));
  const references = records
    .filter((r): r is ReferenceRecord => r.kind === "reference")
    .map((r) => ({ cr_numbers: r.cr_numbers, source_ref: r.source_ref, ...withRecord(r.source_ref), source_title: src(r.source_ref).title, source_url: src(r.source_ref).url, quote: r.quote }));
  const ownership: Record<string, unknown>[] = records
    .filter((r): r is OwnershipRecord => r.kind === "ownership")
    .map((r) => ({
      owner: r.owner, role: r.role, period_from: r.period_from, period_to: r.period_to, entity: r.entity, source_ref: r.source_ref, ...withRecord(r.source_ref),
      ...(r.tenures ? { tenures: r.tenures } : {}), source_title: src(r.source_ref).title, source_url: src(r.source_ref).url, quote: r.quote,
    }));
  const ga = site.ga_eno ? store.ga.get(site.ga_eno) : undefined;
  if (ga?.companies) {
    ownership.push({
      owner: ga.companies, role: `company listed by Geoscience Australia (status: ${ga.status ?? "not stated"})`, period_from: null, period_to: null,
      entity: ga.name, source_ref: `GA-MINERALDEPOSITS-${ga.eno}`, source_title: store.datasets.ga!.name, source_url: gaDepositUrl(ga.eno),
      quote: `COMPANIES: ${ga.companies}`, link_basis: "GA deposit with the same name within 5 km of the GSQ site",
    });
  }

  // Conflicts: same entity and measure, different values. Every value stays in the lists above.
  // MINOCC rows are left to the cross-source check below (they describe other entities and dated parts).
  const conflicts: Record<string, unknown>[] = [];
  const isMinocc = (ref: unknown) => String(ref).startsWith(MINOCC_KEY);
  const groups = new Map<string, typeof production>();
  for (const p of production.filter((x) => !isMinocc(x.source_ref))) {
    const k = `${p.entity}|${p.commodity}|${p.unit}|${p.period_from ?? "?"}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  // A record with no stated start can only be compared with the others of its entity and commodity.
  for (const [k, list] of groups) {
    if (!k.endsWith("|?")) continue;
    for (const [k2, l2] of groups) if (k2 !== k && k2.startsWith(k.slice(0, -1))) l2.push(...list.filter((x) => !l2.includes(x)));
  }
  for (const [k, list] of groups) {
    if (new Set(list.map((p) => p.amount)).size > 1) {
      conflicts.push({ field: `production ${list[0]!.commodity} (${list[0]!.entity})`, values: list.map((p) => ({ value: `${p.amount} ${p.unit}`, source_ref: p.source_ref, period: period(p.period_from, p.period_to) })), key: k });
    }
  }
  const cgroups = new Map<string, typeof closure>();
  for (const c of closure.filter((x) => !isMinocc(x.source_ref))) cgroups.set(c.entity, [...(cgroups.get(c.entity) ?? []), c]);
  for (const [entity, list] of cgroups) {
    if (new Set(list.map((c) => c.year)).size > 1) conflicts.push({ field: `closure year (${entity})`, values: list.map((c) => ({ value: c.year, source_ref: c.source_ref })) });
  }
  for (const c of conflicts) delete c.key;

  // Cross-source, whole site: records with scope site_total / site, MINOCC included. Totals are compared in tonnes (a labelled conversion, for the
  // comparison only); a spread of more than 1% is a conflict. Alluvial totals add to hard-rock totals rather than replace them, so they are not compared.
  const siteTotals = production.filter((p) => p.scope === "site_total" && p.ore_class !== "alluvial");
  for (const commodity of new Set(siteTotals.map((p) => p.commodity))) {
    const list = siteTotals.filter((p) => p.commodity === commodity);
    const t = list.map((p) => toTonnes(p.amount, p.unit));
    const seen = new Set(list.map((p) => sourceKey(p.source_ref)));
    if (seen.size > 1 && seen.has(MINOCC_KEY) && Math.max(...t) / Math.min(...t) > 1.01) {
      conflicts.push({
        field: `production ${commodity}, whole-site totals across sources (including MINOCC 2017)`,
        comparison_basis: "compared in tonnes; kg and troy-oz values converted for the comparison only (1 troy oz = 31.1034768 g); a spread over 1% is listed",
        values: list.map((p, i) => ({ value: `${p.amount} ${p.unit}`, as_tonnes: round(t[i]!, 3), source_ref: p.source_ref, period: period(p.period_from, p.period_to) })),
      });
    }
  }
  const siteClosures = closure.filter((c) => c.scope === "site");
  if (new Set(siteClosures.map((c) => c.year)).size > 1 && siteClosures.some((c) => isMinocc(c.source_ref)) && new Set(siteClosures.map((c) => sourceKey(c.source_ref))).size > 1) {
    conflicts.push({ field: "closure year, whole site, across sources (including MINOCC 2017)", values: siteClosures.map((c) => ({ value: c.year, source_ref: c.source_ref })) });
  }

  const notFound: string[] = [];
  if (!production.length) notFound.push("production: no reported production figure in the sources indexed for this site");
  if (!closure.length) notFound.push("closure: no closure year or reason in the sources indexed for this site");
  else if (closure.every((c) => !c.reason_text)) notFound.push("closure reason: the indexed sources give a closure year but quote no reason");
  if (!ownership.length) notFound.push("ownership: no owner or tenure history in the sources indexed for this site");

  const sourceUrls = new Set<string>([gsqSiteUrl(site.site_no)]);
  for (const x of [...production, ...closure, ...ownership, ...yearsWorked, ...references]) sourceUrls.add(x.source_url as string);
  const sources = [...sourceUrls];

  const sizeBand = site.size ? `${site.size.toLowerCase()}${site.size_def ? `, ${site.size_def.toLowerCase().replace("tonnes", "t")}` : ""}` : "size not recorded";
  const parts: string[] = [
    `${title(site.name)} (GSQ site ${site.site_no}, ${site.locality ? site.locality.toLowerCase().replace(/\.$/, "") : "locality not recorded"}) is recorded by the Geological Survey of Queensland as ${site.mine_status ? title(site.mine_status).toLowerCase() : "status not recorded"}, gold size band ${sizeBand}.`,
  ];
  const fmtOz = (p: (typeof production)[number]) => {
    const c = (p as { converted?: { amount: number } }).converted;
    return c ? `, about ${c.amount >= 1e6 ? `${round(c.amount / 1e6, 2)} Moz` : `${c.amount.toLocaleString("en-AU")} oz`} troy (converted here; the survey records ${p.amount.toLocaleString("en-AU")} ${p.unit})` : "";
  };
  const shown = production.filter((p) => p.scope !== "period");
  const dated = production.filter((p) => p.scope === "period");
  if (shown.length) {
    const lines = shown.map((p) => `${amount(p)}${fmtOz(p)} (${period(p.period_from, p.period_to)}, ${p.entity}, per ${label(p.source_ref)})`);
    parts.push(`Reported production: ${lines.join("; ")}.`);
  }
  if (dated.length) {
    const rows = new Set(dated.map((p) => p.source_ref));
    const goldRows = dated.filter((p) => p.commodity === "gold");
    parts.push(`${src(dated[0]!.source_ref).label} also lists ${rows.size} dated Production row${rows.size > 1 ? "s" : ""}${goldRows.length ? ` (gold: ${goldRows.map((p) => `${p.amount.toLocaleString("en-AU")} ${p.unit} ${period(p.period_from, p.period_to)}`).join("; ")})` : ""}; see production.`);
  }
  if (closure.length) {
    const lines = closure.map((c) => `${c.year}${c.reason_text ? ` - "${c.reason_text}"` : " (no reason quoted)"} [${c.entity}, ${c.reason_class}, per ${label(c.source_ref)}]`);
    parts.push(`Closure: ${lines.join("; ")}.`);
  }
  for (const y of yearsWorked) {
    const span = y.periods.filter((p) => p.start_year !== null || p.end_year !== null).map((p) => `${p.start_year ?? "?"}-${p.end_year ?? "(no end year)"}`);
    if (span.length) parts.push(`Years worked per ${label(y.source_ref)}: ${span.join(", ")}.`);
  }
  if (ownership.length) parts.push(`Ownership and tenure: ${ownership.map((o) => `${o.owner as string}${o.period_from ? ` (${period(o.period_from as number, o.period_to as number | null)})` : ""} per ${label(o.source_ref as string)}`).join("; ")}.`);
  for (const r of references) parts.push(`${src(r.source_ref).label} lists ${r.cr_numbers.length} company report${r.cr_numbers.length > 1 ? "s" : ""} for this site: ${r.cr_numbers.slice(0, 8).map((n) => `CR ${n}`).join(", ")}${r.cr_numbers.length > 8 ? ", ..." : ""}.`);
  if (conflicts.length) parts.push(`The recorded figures disagree on ${conflicts.map((c) => c.field as string).join(" and ")}; every value is kept above, none is merged or chosen.`);
  if (notFound.length) parts.push(`Not found: ${notFound.join("; ")}.`);
  if (others.length) parts.push(`Other GSQ gold sites with the same name (not described here): ${others.slice(0, 5).map((o) => `${o.site_no} (${o.sheet ? title(o.sheet) : "no sheet"}, ${o.size?.toLowerCase() ?? "size not recorded"})`).join(", ")}.`);

  const au = [...shown, ...dated].filter((p) => p.commodity === "gold" && p.ore_class !== "alluvial");
  const goldConflict = conflicts.find((c) => String(c.field).startsWith("production gold, whole-site")) ?? conflicts.find((c) => String(c.field).startsWith("production gold"));
  const fig = (p: { amount: number; unit: string; qualifier: string | null }) => `${p.qualifier === "about" || p.qualifier === "approximately" ? "~" : ""}${p.amount.toLocaleString("en-AU")} ${p.unit}`;
  const brief = (goldConflict
    ? `${title(site.name)}: gold ${au.filter((p) => (goldConflict.values as { source_ref: string; value: string }[]).some((v) => v.source_ref === p.source_ref && v.value === `${p.amount} ${p.unit}`)).map(fig).join(" vs ")}`
    : au.length
      ? `${title(site.name)}: gold ${fig(au[0]!)}${au.length > 1 ? ` (+${au.length - 1} more)` : ""}`
      : `${title(site.name)}: no production figure found`).slice(0, 80);

  return {
    answer: parts.join(" "),
    brief,
    sources,
    body: {
      site_no: site.site_no,
      site_name: title(site.name),
      matched_by: matchedBy,
      gsq_record: {
        source_ref: GSQ_REF, source_url: gsqSiteUrl(site.site_no), mine_status: site.mine_status, size_band: site.size, size_definition: site.size_def,
        latitude: site.lat, longitude: site.lon, location_accuracy_m: site.accuracy_m, locality: site.locality, map_sheet_100k: site.sheet,
        commodities: site.commodities, record_current_to: site.date_current,
      },
      production,
      closure,
      years_worked: yearsWorked,
      ownership,
      references,
      conflicts,
      not_found: notFound,
      other_sites_with_same_name: others.map((o) => ({ site_no: o.site_no, map_sheet_100k: o.sheet, size_band: o.size })),
      dataset: {
        gsq_minocc_fetched: store.datasets.minocc!.fetched, index_built: store.built,
        minocc_2017: { title: store.minocc.source.title, url: store.minocc.source.url, licence: store.minocc.source.licence },
        licence_note: "GSQ MINOCC: CC BY 4.0, State of Queensland; evidence records carry their own source licence",
      },
    },
  };
}
