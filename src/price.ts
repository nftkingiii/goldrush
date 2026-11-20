import type { GoldMonths } from "./store.ts";

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MAX_MONTHS = 120;

export type MonthSpan = { from: string; to: string } | { error: string };

const key = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
const index = (k: string) => Number(k.slice(0, 4)) * 12 + Number(k.slice(5, 7)) - 1;
const fromIndex = (i: number) => key(Math.floor(i / 12), (i % 12) + 1);

/** Reads the month or year range a question asks about. Refuses anything it cannot read exactly. */
export function parseSpan(question: string, today = new Date()): MonthSpan {
  const text = question.toLowerCase();
  const found: { at: number; end: number; k: string }[] = [];
  const add = (at: number, len: number, y: number, m: number) => {
    if (m < 1 || m > 12) throw new RangeError("month out of range");
    found.push({ at, end: at + len, k: key(y, m) });
  };
  try {
    for (const m of text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/g)) add(m.index!, m[0].length, Number(m[2]), MONTH_NAMES.indexOf(m[1]!) + 1);
    for (const m of text.matchAll(/\b(\d{4})[-/](\d{1,2})\b/g)) add(m.index!, m[0].length, Number(m[1]), Number(m[2]));
    for (const m of text.matchAll(/\b(\d{1,2})\/(\d{4})\b/g)) add(m.index!, m[0].length, Number(m[2]), Number(m[1]));
  } catch {
    return { error: "month_out_of_range" };
  }
  found.sort((a, b) => a.at - b.at);

  const years: { at: number; y: number }[] = [];
  for (const m of text.matchAll(/\b(1[5-9]\d\d|20\d\d)\b/g)) {
    const at = m.index!;
    if (found.some((f) => at >= f.at && at < f.end)) continue;
    years.push({ at, y: Number(m[1]) });
  }

  let from: string;
  let to: string;
  if (found.length >= 2) {
    if (found.length > 2 || years.length) return { error: "ambiguous_period" };
    [from, to] = [found[0]!.k, found[1]!.k];
  } else if (found.length === 1) {
    if (years.length) return { error: "ambiguous_period" };
    from = to = found[0]!.k;
  } else if (years.length === 1) {
    from = key(years[0]!.y, 1);
    to = key(years[0]!.y, 12);
  } else if (years.length === 2) {
    const between = text.slice(years[0]!.at + 4, years[1]!.at);
    if (!/^\s*(to|-|–|—|through|until|and)\s*$/.test(between)) return { error: "ambiguous_period" };
    from = key(years[0]!.y, 1);
    to = key(years[1]!.y, 12);
  } else {
    return { error: years.length ? "ambiguous_period" : "no_period" };
  }
  if (index(to) < index(from)) return { error: "period_end_before_start" };
  if (index(to) - index(from) + 1 > MAX_MONTHS) return { error: "period_too_long" };
  if (Number(to.slice(0, 4)) > today.getUTCFullYear() + 1) return { error: "period_in_the_future" };
  return { from, to };
}

export interface PriceRow {
  month: string;
  usd_per_oz: number;
  aud_per_oz: number | null;
  series: string;
  source_url: string;
  aud_basis: string | null;
  fx_usd_per_aud: number | null;
  fx_date: string | null;
}

export interface PriceResult {
  rows: PriceRow[];
  not_found: string[];
  sources: string[];
}

export function lookupPrices(gold: GoldMonths, span: { from: string; to: string }): PriceResult {
  const rows: PriceRow[] = [];
  const missing: string[] = [];
  const missingAud: string[] = [];
  for (let i = index(span.from); i <= index(span.to); i++) {
    const m = fromIndex(i);
    const v = gold.months.get(m);
    if (!v) {
      missing.push(m);
      continue;
    }
    const aud = v.fx ? Math.round((v.usd / v.fx) * 100) / 100 : null;
    if (aud === null) missingAud.push(m);
    rows.push({
      month: m,
      usd_per_oz: v.usd,
      aud_per_oz: aud,
      series: gold.gold.series,
      source_url: gold.gold.url,
      aud_basis: aud === null ? null : `derived: usd_per_oz divided by ${gold.fx.series}`,
      fx_usd_per_aud: v.fx,
      fx_date: v.fx_date,
    });
  }
  const notFound: string[] = [];
  const range = (list: string[]) => (list.length > 1 ? `${list[0]} to ${list.at(-1)} (${list.length} months)` : list[0]!);
  if (missing.length) notFound.push(`gold_price usd_per_oz for ${range(missing)}: the open series covers ${gold.first} to ${gold.last}`);
  if (missingAud.length) notFound.push(`gold_price aud_per_oz for ${range(missingAud)}: no RBA AUD/USD observation for the month`);
  return { rows, not_found: notFound, sources: rows.length ? [gold.gold.url, gold.fx.url] : [] };
}

export function describePrices(r: PriceResult, span: { from: string; to: string }): { answer: string; brief: string } {
  if (!r.rows.length) {
    return {
      answer: `No gold price is held for ${span.from === span.to ? span.from : `${span.from} to ${span.to}`}. ${r.not_found.join(" ")}`,
      brief: `No open monthly gold price for ${span.from}`.slice(0, 80),
    };
  }
  const fmt = (x: PriceRow) => `${x.month} US$${x.usd_per_oz}${x.aud_per_oz === null ? "" : ` / A$${x.aud_per_oz}`}`;
  const list = r.rows.length <= 12 ? r.rows.map(fmt).join("; ") : `${fmt(r.rows[0]!)}; ... ; ${fmt(r.rows.at(-1)!)} (${r.rows.length} months, all in gold_price)`;
  const answer =
    `Gold, monthly average per troy ounce (World Bank Pink Sheet, nominal US dollars): ${list}. ` +
    `Australian dollar figures are derived by dividing by the RBA month-end A$1=US$ rate for the same month (a different day-basis from the World Bank average, so they are indicative, not an official A$ price).` +
    (r.not_found.length ? ` Not found: ${r.not_found.join(" ")}` : "");
  const first = r.rows[0]!;
  const brief = r.rows.length === 1 ? `Gold ${first.month}: US$${first.usd_per_oz}/oz` : `Gold ${first.month} to ${r.rows.at(-1)!.month}: US$${first.usd_per_oz} to ${r.rows.at(-1)!.usd_per_oz}/oz`;
  return { answer, brief: brief.slice(0, 80) };
}
