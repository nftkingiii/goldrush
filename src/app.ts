import { buildSiteAnswer } from "./answer.ts";
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

export function createHandler(store: Store) {
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

  function site(question: string): Reply {
    const r = resolveSite(question, store.sites);
    if (r.kind === "none") return { status: 422, body: { error: "no_matching_site", closest_names: r.closest, hint: "Name a Queensland gold working as the Geological Survey records it, or give 'site <number>'." } };
    if (r.kind === "elsewhere") return { status: 422, body: { error: "site_not_in_named_area", asked_areas: r.asked, candidates: r.candidates.map((c: Site) => ({ site_id: c.site_no, name: c.name, map_sheet_100k: c.sheet, size_band: c.size })), hint: "A site of that name exists, but not on the map sheet you named. Repeat with 'site <number>' to choose one." } };
    if (r.kind === "ambiguous") return { status: 422, body: { error: "ambiguous_site", candidates: r.candidates.map((c: Site) => ({ site_id: c.site_no, name: c.name, map_sheet_100k: c.sheet, size_band: c.size })), hint: "Repeat the question with 'site <number>'." } };
    const a = buildSiteAnswer(store, r.site, r.others, r.matchedBy);
    return { status: 200, body: { answer: a.answer, source_count: a.sources.length, sources: a.sources, brief: a.brief, ...a.body } };
  }

  return {
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
