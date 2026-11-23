import { buildSiteAnswer } from "./answer.ts";
import { BUFFER_M, CAVEAT, createLand, describeLand, type Category, type Land } from "./land.ts";
import { MINOCC_KEY } from "./minocc.ts";
import { ACCESS_LABEL, CAVEATS, REMAINING_CAVEAT, REM_CATEGORIES, RESOURCE_LABEL, createRemaining, describeRemaining, type RemCategory, type Remaining } from "./remaining.ts";
import { REAL_LABEL, realGoldPrice } from "./real.ts";
import { resolveSite, type Site } from "./match.ts";
import { describePrices, lookupPrices, parseSpan } from "./price.ts";
import type { Store } from "./store.ts";

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

const MAX_QUESTION = 512;

const isPriceQuestion = (q: string) => /\b(price|prices|per ounce|per oz|\/oz|worth|ounce)\b/i.test(q) && /\bgold\b/i.test(q);

function readQuestion(query: URLSearchParams): { question: string } | Reply {
  const question = (query.get("question") ?? "").trim();
  if (!question) return { status: 400, body: { error: "question_required" } };
  if (question.length > MAX_QUESTION) return { status: 400, body: { error: "question_too_long", max_characters: MAX_QUESTION } };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(question)) return { status: 400, body: { error: "question_has_control_characters" } };
  return { question };
}

const SPAN_ERRORS: Record<string, string> = {
  no_period: "Name a month (for example March 1903) or a year or range of years.",
  ambiguous_period: "Ask for one month, one year, or one range written as two months or two years.",
  period_end_before_start: "The end of the range is before its start.",
  period_too_long: "Ask for at most 120 months at a time.",
  period_in_the_future: "That period is in the future.",
  month_out_of_range: "A month must be 1 to 12.",
};

const ALL: Category[] = ["tenure", "native_title", "land_status"];
/** "gold price at closure vs today for Brilliant Lode": a gold price, a closure and a comparison with now. */
export const isRealPriceQuestion = (q: string) =>
  /\bgold\b/i.test(q) && /\b(price|worth|ounce|oz)\b/i.test(q) && /\b(closure|closed|closing|shut)\b/i.test(q) && /\b(today|now|current|inflation|real|adjusted|vs|versus|compared)\b/i.test(q);
const LAND_WORDS = /\b(tenure|tenures|tenement|tenements|lease|leases|permit|permits|epm|mdl|holds?|holder|holders|native title|nntt|ilua|iluas|determination|determinations|claimant|land|rights|protected|national park|heritage|abandoned)\b/i;
export const isLandQuestion = (q: string) => LAND_WORDS.test(q) && !/\bprice\b/i.test(q);

/** Which of tenure, native title and land status a question asks for; "land and rights" or "everything" asks for all three. */
export function landCategories(q: string): Category[] {
  if (/\b(land and rights|everything|all of it|all three)\b/i.test(q)) return ALL;
  const out: Category[] = [];
  if (/\b(tenure|tenures|tenement|tenements|lease|leases|permit|permits|epm|mdl|holds?|holder|holders)\b/i.test(q)) out.push("tenure");
  if (/\b(native title|nntt|ilua|iluas|determination|determinations|claimant)\b/i.test(q)) out.push("native_title");
  if (/\b(land status|protected|national park|heritage|abandoned)\b/i.test(q)) out.push("land_status");
  return out.length ? out : ALL;
}

const EXPLORATION_WORDS = /\b(drill|drills|drilling|drilled|drillhole|drillholes|borehole|boreholes|bore holes?|company reports?|cr numbers?|exploration (drilling|history|reports?|activity|records?)|later exploration|geoscience reports?)\b/i;
const RESOURCE_WORDS = /\b(resources?|reserves?|jorc|ounces in the ground)\b/i;
const ACCESS_WORDS = /\b(infrastructure|nearest (town|road|power|locality)|distance to|how far|power lines?|transmission lines?|electricity|grid)\b/i;
const ENVIRONMENT_WORDS = /\b(environment|environmental|contaminat\w*|liabilit\w+|rehabilitation|tailings)\b/i;
const REMAIN_ALL = /\b(what (might|may|could) (still )?remain|might remain|remaining today|remains? today|what is left|what's left)\b/i;
const FULL_DOSSIER = /\b(full (dossier|report)|everything today|dossier)\b/i;

/** Which of exploration, resources, access and environment a question asks for; "what might remain" asks for all four. Empty if none. */
export function remainingCategories(q: string): RemCategory[] {
  if (REMAIN_ALL.test(q) || FULL_DOSSIER.test(q)) return REM_CATEGORIES;
  const out: RemCategory[] = [];
  if (EXPLORATION_WORDS.test(q)) out.push("exploration");
  if (RESOURCE_WORDS.test(q)) out.push("resources");
  if (ACCESS_WORDS.test(q)) out.push("access");
  if (ENVIRONMENT_WORDS.test(q)) out.push("environment");
  return out;
}
export const isRemainingQuestion = (q: string) => remainingCategories(q).length > 0 && !/\bprice\b/i.test(q);
/** The "everything" question: land and rights plus what might remain, in one call. */
export const wantsLandToo = (q: string) => FULL_DOSSIER.test(q) || (isRemainingQuestion(q) && /\b(everything|land and rights)\b/i.test(q));

export interface HandlerDeps {
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

export function createHandler(store: Store, deps: HandlerDeps = {}) {
  const land: Land = createLand({ fetch: deps.fetch ?? fetch, now: deps.now ?? (() => new Date()), timeoutMs: deps.timeoutMs });
  const remaining: Remaining = createRemaining({ fetch: deps.fetch ?? fetch, now: deps.now ?? (() => new Date()), timeoutMs: deps.timeoutMs }, land);
  function price(question: string): Reply {
    if (/\b(silver|copper|zinc|platinum|oil)\b/i.test(question) && !/\bgold\b/i.test(question)) {
      return { status: 422, body: { error: "unsupported_commodity", supported: ["gold"] } };
    }
    if (!/\bgold\b/i.test(question)) return { status: 422, body: { error: "not_a_gold_price_question", hint: "Ask for the gold price in a month or year, for example: gold price in March 1980." } };
    const span = parseSpan(question);
    if ("error" in span) return { status: 422, body: { error: span.error, hint: SPAN_ERRORS[span.error] } };
    const result = lookupPrices(store.gold, span);
    const { answer, brief } = describePrices(result, span);
    return {
      status: 200,
      body: {
        answer, source_count: result.sources.length, sources: result.sources, brief,
        gold_price: result.rows, period: span, not_found: result.not_found,
        series_coverage: { from: store.gold.first, to: store.gold.last },
      },
    };
  }

  function resolve(question: string): { site: Site; others: Site[]; matchedBy: string } | Reply {
    const r = resolveSite(question, store.sites);
    if (r.kind === "none") return { status: 422, body: { error: "no_matching_site", closest_names: r.closest, hint: "Name a Queensland gold working as the Geological Survey records it, or give 'site <number>'." } };
    if (r.kind === "elsewhere") return { status: 422, body: { error: "site_not_in_named_area", asked_areas: r.asked, candidates: r.candidates.map((c: Site) => ({ site_no: c.site_no, name: c.name, map_sheet_100k: c.sheet, size_band: c.size })), hint: "A site of that name exists, but not on the map sheet you named. Repeat with 'site <number>' to choose one." } };
    if (r.kind === "ambiguous") return { status: 422, body: { error: "ambiguous_site", candidates: r.candidates.map((c: Site) => ({ site_no: c.site_no, name: c.name, map_sheet_100k: c.sheet, size_band: c.size })), hint: "Repeat the question with 'site <number>'." } };
    return { site: r.site, others: r.others, matchedBy: r.matchedBy };
  }

  function site(question: string): Reply {
    const r = resolve(question);
    if ("status" in r) return r;
    const a = buildSiteAnswer(store, r.site, r.others, r.matchedBy);
    return { status: 200, body: { answer: a.answer, source_count: a.sources.length, sources: a.sources, brief: a.brief, ...a.body } };
  }

  const siteHead = (s: Site, matchedBy: string) => ({
    site_no: s.site_no,
    site_name: s.name.toLowerCase().replace(/(^|[\s(-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase()),
    matched_by: matchedBy,
    gsq_record: { source_ref: "GSQ-MINOCC", latitude: s.lat, longitude: s.lon, location_accuracy_m: s.accuracy_m, locality: s.locality, map_sheet_100k: s.sheet },
  });

  async function landReply(question: string): Promise<Reply> {
    const r = resolve(question);
    if ("status" in r) return r;
    const cats = landCategories(question);
    const result = await land.query(r.site, cats);
    const head = siteHead(r.site, r.matchedBy);
    const d = describeLand(head.site_name, r.site.site_no, result, cats);
    const sources = [...new Set(result.checks.map((c) => c.source_url))];
    return {
      status: 200,
      body: {
        answer: d.answer, source_count: sources.length, sources, brief: d.brief, ...head,
        ...Object.fromEntries(cats.map((c) => [c, result.rows[c]])),
        not_found: result.not_found,
        notes: result.notes,
        caveat: CAVEAT,
        buffer: {
          point_in_polygon: true, within_metres: BUFFER_M,
          note: `each record says whether it contains the site point or lies within ${BUFFER_M / 1000} km of it; the site point is the GSQ MINOCC location (accuracy ${r.site.accuracy_m ?? "not stated"} m)`,
        },
        checks: result.checks, checked_at: result.checked_at, categories: cats,
        licences: {
          queensland_services: "State of Queensland services; licence not verified (data.qld.gov.au refuses automated clients and the data.gov.au mirror says 'Not Specified'); attribute the State of Queensland",
          nntt: "NNTT spatial data: reproduction of the information is permitted and is to be attributed to the NNTT (© Commonwealth of Australia); general information only, not legal advice",
        },
      },
    };
  }

  async function remainingReply(question: string): Promise<Reply> {
    const r = resolve(question);
    if ("status" in r) return r;
    const cats = remainingCategories(question);
    const withLand = wantsLandToo(question);
    const cr = (store.records.get(r.site.site_no) ?? []).flatMap((x) => (x.kind === "reference" ? x.cr_numbers : []));
    const [rem, landRes] = await Promise.all([remaining.query(r.site, cats, cr), withLand ? land.query(r.site, ALL) : Promise.resolve(null)]);
    const head = siteHead(r.site, r.matchedBy);
    const dr = describeRemaining(head.site_name, r.site.site_no, rem, cats);
    const dl = landRes ? describeLand(head.site_name, r.site.site_no, landRes, ALL) : null;
    const checks = [...(landRes?.checks ?? []), ...rem.checks];
    const sources = [...new Set(checks.map((c) => c.source_url))];
    const allCats = [...(landRes ? ALL : []), ...cats];
    return {
      status: 200,
      body: {
        answer: dl ? `${dl.answer} ${dr.answer}` : dr.answer, source_count: sources.length, sources,
        brief: dl ? `${head.site_name}: land and what might remain`.slice(0, 80) : dr.brief, ...head,
        ...Object.fromEntries(allCats.map((c) => [c, landRes && (ALL as string[]).includes(c) ? landRes.rows[c as Category] : rem.rows[c as RemCategory]])),
        not_found: [...(landRes?.not_found ?? []), ...rem.not_found], notes: [...(landRes?.notes ?? []), ...rem.notes],
        ...(landRes ? { caveat: CAVEAT } : {}),
        remaining_caveat: REMAINING_CAVEAT, caveats: Object.fromEntries(cats.map((c) => [c, CAVEATS[c]])),
        labels: { resources: RESOURCE_LABEL, access: ACCESS_LABEL },
        buffer: {
          point_in_polygon: Boolean(landRes), within_metres: BUFFER_M,
          note: `boreholes, resource deposits, authorities and abandoned-mines records within ${BUFFER_M / 1000} km of the GSQ MINOCC site point (accuracy ${r.site.accuracy_m ?? "not stated"} m); access rows are the nearest feature at any distance, straight line`,
        },
        checks, checked_at: rem.checked_at, categories: allCats,
        calls: { this_response: 1, note: "one question returns every category asked for; with the history question (/ask for production and closure) a full report is 2 paid calls, or 3 if land and remaining are asked separately" },
        licences: {
          gsq_boreholes_and_report_index: "Service iteminfo, quoted: \"This service is licenced under a Creative Commons — Attribution 4.0 International licence.\" Attribution: © State of Queensland (Department of Natural Resources and Mines, Manufacturing and Regional and Rural Development) 2026",
          geoscience_australia: "Mineral deposits WFS AccessConstraints, quoted: \"Copyright Commonwealth of Australia (Geoscience Australia) 2022. This material is released free under the Creative Commons Attribution 4.0 International Licence.\" Electricity infrastructure: \"This material is released under the Creative Commons Attribution 4.0 International License.\"",
          geoscape_via_digital_atlas: "Towns and roads: item licence \"Creative Commons Attribution 4.0 International\"; \"Incorporates or developed using Administrative Boundaries / Roads © Geoscape Australia\"",
          queensland_environment: "Environmental authority locations: © State of Queensland (Department of Environment, Tourism, Science and Innovation) 2026; the service's item licence is Creative Commons Attribution 4.0",
          ...(landRes ? { queensland_services: "State of Queensland services; see the land and rights licence notes", nntt: "NNTT spatial data: reproduction of the information is permitted and is to be attributed to the NNTT (© Commonwealth of Australia); general information only, not legal advice" } : {}),
        },
      },
    };
  }

  function realReply(question: string): Reply {
    const r = resolve(question);
    if ("status" in r) return r;
    const head = siteHead(r.site, r.matchedBy);
    const closures = (store.records.get(r.site.site_no) ?? []).flatMap((x) => (x.kind === "closure" ? [x] : []));
    const minocc = closures.filter((c) => c.source_ref.startsWith(MINOCC_KEY));
    const checkedAt = store.cpi.fetched;
    const none = (why: string, used: unknown): Reply => ({
      status: 200,
      body: { answer: `${head.site_name}: ${why}`, source_count: 0, sources: [], brief: `${head.site_name}: no real price`.slice(0, 80), ...head, closure_year_used: used, gold_price_real: [], not_found: [why], checked_at: checkedAt },
    });
    if (!minocc.length) return none("not found: no MINOCC MineHist end year is recorded for this site, so no closure year is chosen and no real-dollar comparison is made.", null);
    const c = minocc.reduce((a, b) => (b.year > a.year ? b : a));
    const year = c.year;
    const others = [...new Set(closures.filter((x) => !x.source_ref.startsWith(MINOCC_KEY)).map((x) => `${x.year} (${x.source_ref})`))];
    const basis = `closure year ${year} is the latest End Year in the MINOCC 2017 MineHist table for this site (${c.source_ref}): the last recorded period of working ended then, which says when working last ended, not why${others.length ? `; other sources give ${others.join(", ")}, not used here` : ""}`;
    const used = { year, basis, source_ref: c.source_ref };
    const res = realGoldPrice(store.gold, store.cpi, year);
    if ("not_found" in res) return none(`${basis}. Not found: ${res.not_found}.`, used);
    const g = res.row;
    const aud = g.nominal_aud_per_oz === null ? "no A$ figure is held for that year" : `A$${g.nominal_aud_per_oz} nominal`;
    const answer =
      `${head.site_name}: ${basis}. Gold in ${year} averaged US$${g.nominal_usd_per_oz}/oz nominal (${g.nominal_basis}; ${g.months_used} month${g.months_used > 1 ? "s" : ""}; ${aud}). ` +
      `In ${g.cpi_latest_month} US dollars that is US$${g.real_usd_per_oz_in_latest_dollars}/oz (US CPI-U, ${year} average ${g.cpi_closure_year_average} against ${g.cpi_latest}). ` +
      `Gold in ${g.today_month} averaged US$${g.today_usd_per_oz}/oz, ${g.today_vs_closure_real_ratio} times the closure-year price in today's dollars. ${REAL_LABEL}. CPI snapshot taken ${g.checked_at}.`;
    return {
      status: 200,
      body: {
        answer, source_count: 1 + g.price_source_urls.length, sources: [g.source_url, ...g.price_source_urls],
        brief: `${head.site_name} ${year}: US$${g.nominal_usd_per_oz} = US$${g.real_usd_per_oz_in_latest_dollars} today`.slice(0, 80),
        ...head, closure_year_used: used, gold_price_real: [{ ...g, record_id: `CPIAUCNS ${year} average against ${g.cpi_latest_month}` }], not_found: [], checked_at: checkedAt,
        cpi: { series: store.cpi.series, licence: store.cpi.licence, snapshot_date: store.cpi.fetched },
      },
    };
  }

  return {
    /** Questions that need a live service call (land and rights) or a closure lookup answer here; everything else as `ask` does. */
    async askAsync(query: URLSearchParams): Promise<Reply> {
      const q = readQuestion(query);
      if ("status" in q) return q;
      if (isRealPriceQuestion(q.question)) return realReply(q.question);
      if (isRemainingQuestion(q.question)) return remainingReply(q.question);
      if (isLandQuestion(q.question)) return landReply(q.question);
      return this.ask(query);
    },
    ask(query: URLSearchParams): Reply {
      const q = readQuestion(query);
      if ("status" in q) return q;
      return isPriceQuestion(q.question) && !/\bsite\s*(no\.?|number|id)?\s*#?:?\s*\d/i.test(q.question) ? price(q.question) : site(q.question);
    },
    price(query: URLSearchParams): Reply {
      const q = readQuestion(query);
      if ("status" in q) return q;
      return price(q.question);
    },
  };
}
