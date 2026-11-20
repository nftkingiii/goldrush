import { gaDepositUrl, gsqSiteUrl } from "./sources.ts";
import type { Site } from "./match.ts";
import type { ClosureRecord, OwnershipRecord, ProductionRecord, Store } from "./store.ts";

export interface SiteAnswer {
  answer: string;
  brief: string;
  sources: string[];
  body: Record<string, unknown>;
}

const GSQ_REF = "GSQ-MINOCC";
const title = (s: string | null) => (s ? s.toLowerCase().replace(/(^|[\s(-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase()) : "");

function period(from: string | null, to: string | null): string {
  if (from && to) return from === to ? from : `${from} to ${to}`;
  return from ? `from ${from}` : to ? `to ${to}` : "period not stated";
}

function amount(p: Pick<ProductionRecord, "qualifier" | "amount" | "unit" | "commodity">): string {
  return `${p.qualifier ? `${p.qualifier} ` : ""}${p.amount.toLocaleString("en-AU")} ${p.unit === "t" ? "tonnes" : "oz"} ${p.commodity}`;
}

export function buildSiteAnswer(store: Store, site: Site, others: Site[], matchedBy: string): SiteAnswer {
  const records = store.records.get(site.site_no) ?? [];
  const src = (ref: string) => store.sources[ref]!;
  const label = (ref: string) => store.sources[ref]?.label ?? ref;

  const production = records
    .filter((r): r is ProductionRecord => r.kind === "production")
    .map((r) => ({
      commodity: r.commodity, amount: r.amount, unit: r.unit, period_from: r.period_from, period_to: r.period_to,
      basis: r.basis, qualifier: r.qualifier, entity: r.entity, source_ref: r.source_ref, source_title: src(r.source_ref).title,
      source_url: src(r.source_ref).url, quote: r.quote,
    }));
  const closure = records
    .filter((r): r is ClosureRecord => r.kind === "closure")
    .map((r) => ({
      year: r.year, reason_text: r.reason_text, reason_class: r.reason_class, entity: r.entity, source_ref: r.source_ref,
      page: r.page, source_title: src(r.source_ref).title, source_url: src(r.source_ref).url, quote: r.quote,
    }));
  const ownership: Record<string, unknown>[] = records
    .filter((r): r is OwnershipRecord => r.kind === "ownership")
    .map((r) => ({
      owner: r.owner, role: r.role, period_from: r.period_from, period_to: r.period_to, entity: r.entity, source_ref: r.source_ref,
      source_title: src(r.source_ref).title, source_url: src(r.source_ref).url, quote: r.quote,
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
  const conflicts: Record<string, unknown>[] = [];
  const groups = new Map<string, typeof production>();
  for (const p of production) {
    const k = `${p.entity}|${p.commodity}|${p.unit}|${p.period_from ?? "?"}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  // A record with no stated start can only be compared with the others of its entity and commodity.
  for (const [k, list] of groups) {
    if (!k.endsWith("|?")) continue;
    for (const [k2, l2] of groups) if (k2 !== k && k2.startsWith(k.slice(0, -1)) ) l2.push(...list.filter((x) => !l2.includes(x)));
  }
  for (const [k, list] of groups) {
    if (new Set(list.map((p) => p.amount)).size > 1) {
      conflicts.push({ field: `production ${list[0]!.commodity} (${list[0]!.entity})`, values: list.map((p) => ({ value: `${p.amount} ${p.unit}`, source_ref: p.source_ref, period: period(p.period_from, p.period_to) })), key: k });
    }
  }
  const cgroups = new Map<string, typeof closure>();
  for (const c of closure) cgroups.set(c.entity, [...(cgroups.get(c.entity) ?? []), c]);
  for (const [entity, list] of cgroups) {
    if (new Set(list.map((c) => c.year)).size > 1) conflicts.push({ field: `closure year (${entity})`, values: list.map((c) => ({ value: c.year, source_ref: c.source_ref })) });
  }
  for (const c of conflicts) delete c.key;

  const notFound: string[] = [];
  if (!production.length) notFound.push("production: no reported production figure in the sources indexed for this site");
  if (!closure.length) notFound.push("closure: no closure year or reason in the sources indexed for this site");
  else if (closure.every((c) => !c.reason_text)) notFound.push("closure reason: the indexed sources give a closure year but quote no reason");
  if (!ownership.length) notFound.push("ownership: no owner or tenure history in the sources indexed for this site");

  const sourceUrls = new Set<string>([gsqSiteUrl(site.site_no)]);
  for (const x of [...production, ...closure, ...ownership]) sourceUrls.add(x.source_url as string);
  const sources = [...sourceUrls];

  const sizeBand = site.size ? `${site.size.toLowerCase()}${site.size_def ? `, ${site.size_def.toLowerCase().replace("tonnes", "t")}` : ""}` : "size not recorded";
  const parts: string[] = [
    `${title(site.name)} (GSQ site ${site.site_no}, ${site.locality ? site.locality.toLowerCase().replace(/\.$/, "") : "locality not recorded"}) is recorded by the Geological Survey of Queensland as ${site.mine_status ? title(site.mine_status).toLowerCase() : "status not recorded"}, gold size band ${sizeBand}.`,
  ];
  if (production.length) {
    const lines = production.map((p) => `${amount(p)} (${period(p.period_from, p.period_to)}, ${p.entity}, per ${label(p.source_ref)})`);
    parts.push(`Reported production: ${lines.join("; ")}.`);
  }
  if (closure.length) {
    const lines = closure.map((c) => `${c.year}${c.reason_text ? ` - "${c.reason_text}"` : " (no reason quoted)"} [${c.entity}, ${c.reason_class}, per ${label(c.source_ref)}]`);
    parts.push(`Closure: ${lines.join("; ")}.`);
  }
  if (ownership.length) parts.push(`Ownership and tenure: ${ownership.map((o) => `${o.owner as string}${o.period_from ? ` (${period(o.period_from as string, o.period_to as string | null)})` : ""} per ${label(o.source_ref as string)}`).join("; ")}.`);
  if (conflicts.length) parts.push(`The recorded figures disagree on ${conflicts.map((c) => c.field as string).join(" and ")}; every value is kept above, none is merged or chosen.`);
  if (notFound.length) parts.push(`Not found: ${notFound.join("; ")}.`);
  if (others.length) parts.push(`Other GSQ gold sites with the same name (not described here): ${others.slice(0, 5).map((o) => `${o.site_no} (${o.sheet ? title(o.sheet) : "no sheet"}, ${o.size?.toLowerCase() ?? "size not recorded"})`).join(", ")}.`);

  const au = production.filter((p) => p.commodity === "gold");
  const goldConflict = conflicts.find((c) => String(c.field).startsWith("production gold"));
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
      site_id: site.site_no,
      site_name: title(site.name),
      matched_by: matchedBy,
      gsq_record: {
        source_ref: GSQ_REF, source_url: gsqSiteUrl(site.site_no), mine_status: site.mine_status, size_band: site.size, size_definition: site.size_def,
        latitude: site.lat, longitude: site.lon, location_accuracy_m: site.accuracy_m, locality: site.locality, map_sheet_100k: site.sheet,
        commodities: site.commodities, record_current_to: site.date_current,
      },
      production,
      closure,
      ownership,
      conflicts,
      not_found: notFound,
      other_sites_with_same_name: others.map((o) => ({ site_id: o.site_no, map_sheet_100k: o.sheet, size_band: o.size })),
      dataset: { gsq_minocc_fetched: store.datasets.minocc!.fetched, index_built: store.built, licence_note: "GSQ MINOCC: CC BY 4.0, State of Queensland; evidence records carry their own source licence" },
    },
  };
}
