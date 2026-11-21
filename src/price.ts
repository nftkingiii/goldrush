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
  source_ref: string;
  source_url: string;
  /** "market" (World Bank monthly average) or "official" (US statutory or Treasury price, not a market average). */
  price_basis: "market" | "official";
  note?: string;
  aud_basis: string | null;
  fx_usd_per_aud: number | null;
  fx_date: string | null;
}

export interface PriceResult {
  rows: PriceRow[];
  not_found: string[];
  sources: string[];
}

/**
 * Before the World Bank monthly series (1960), most Queensland workings had already closed. For those years the
 * clean, citable figure is the official US gold price. Per Federal Reserve History ("Gold Reserve Act of 1934"):
 * $20.67 per ounce, "the value set by the Gold Act of 1900", which "had prevailed until the spring of 1933"; then
 * $35 per ounce under the Gold Reserve Act (30 January 1934) and Proclamation 2072 (31 January 1934). Earlier
 * months are not held: the cited source does not cover them. These are official prices, not market averages, and
 * are labelled as such. Australia used the pound until 1966, so there is no A$ figure.
 */
export const OFFICIAL_SERIES = {
  ref: "US-OFFICIAL-GOLD-PRICE",
  title: "Official US gold price (Gold Act of 1900: $20.67/oz; Gold Reserve Act of 1934 and Proclamation 2072: $35/oz from 31 January 1934), per Federal Reserve History",
  url: "https://www.federalreservehistory.org/essays/gold-reserve-act",
  first: "1900-03",
};

export function officialPrice(month: string): { usd: number; note?: string } | null {
  if (index(month) < index(OFFICIAL_SERIES.first)) return null;
  if (index(month) <= index("1934-01")) {
    if (month === "1934-01") return { usd: 20.67, note: "the official price became $35.00 on 31 January 1934" };
    if (index(month) >= index("1933-04")) {
      return { usd: 20.67, note: "statutory price; the dollar was off gold from April 1933 and US government purchase prices rose above it before the Gold Reserve Act" };
    }
    return { usd: 20.67 };
  }
  return { usd: 35 };
}

export function lookupPrices(gold: GoldMonths, span: { from: string; to: string }): PriceResult {
  const rows: PriceRow[] = [];
  const missing: string[] = [];
  const missingAud: string[] = [];
  const official: string[] = [];
  for (let i = index(span.from); i <= index(span.to); i++) {
    const m = fromIndex(i);
    const v = gold.months.get(m);
    if (!v) {
      const o = index(m) < index(gold.first) ? officialPrice(m) : null;
      if (!o) {
        missing.push(m);
        continue;
      }
      official.push(m);
      rows.push({
        month: m,
        usd_per_oz: o.usd,
        aud_per_oz: null,
        series: OFFICIAL_SERIES.title,
        source_ref: OFFICIAL_SERIES.ref,
        source_url: OFFICIAL_SERIES.url,
        price_basis: "official",
        ...(o.note ? { note: o.note } : {}),
        aud_basis: null,
        fx_usd_per_aud: null,
        fx_date: null,
      });
      continue;
    }
    const aud = v.fx ? Math.round((v.usd / v.fx) * 100) / 100 : null;
    if (aud === null) missingAud.push(m);
    rows.push({
      month: m,
      usd_per_oz: v.usd,
      aud_per_oz: aud,
      series: gold.gold.series,
      source_ref: "WB-PINKSHEET-GOLD",
      source_url: gold.gold.url,
      price_basis: "market",
      aud_basis: aud === null ? null : `derived: usd_per_oz divided by ${gold.fx.series}`,
      fx_usd_per_aud: v.fx,
      fx_date: v.fx_date,
    });
  }
  const notFound: string[] = [];
  const range = (list: string[]) => (list.length > 1 ? `${list[0]} to ${list.at(-1)} (${list.length} months)` : list[0]!);
  if (missing.length) notFound.push(`gold_price usd_per_oz for ${range(missing)}: held from ${OFFICIAL_SERIES.first} (official US price) and ${gold.first} to ${gold.last} (World Bank monthly average)`);
  if (missingAud.length) notFound.push(`gold_price aud_per_oz for ${range(missingAud)}: no RBA AUD/USD observation for the month`);
  if (official.length) notFound.push(`gold_price aud_per_oz for ${range(official)}: Australia used the pound until 1966; no A$ figure before the World Bank series`);
  const sources = new Set<string>();
  if (official.length) sources.add(OFFICIAL_SERIES.url);
  if (rows.length > official.length) [gold.gold.url, gold.fx.url].forEach((u) => sources.add(u));
  return { rows, not_found: notFound, sources: [...sources] };
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
  const hasOfficial = r.rows.some((x) => x.price_basis === "official");
  const hasMarket = r.rows.some((x) => x.price_basis === "market");
  const notes = [...new Set(r.rows.map((x) => x.note).filter(Boolean))];
  const answer =
    (hasOfficial
      ? `Gold, official US price per ounce (not a market average): ${hasMarket ? "before 1960; " : ""}$20.67, the value set by the Gold Act of 1900, until the Gold Reserve Act of 1934, then $35 from 31 January 1934 (Proclamation 2072) (source: Federal Reserve History, ${OFFICIAL_SERIES.url}). `
      : "") +
    (hasMarket ? `Gold, monthly average per troy ounce (World Bank Pink Sheet, nominal US dollars) from 1960. ` : "") +
    `Prices: ${list}. ` +
    (hasMarket
      ? `Australian dollar figures are derived by dividing by the RBA month-end A$1=US$ rate for the same month (a different day-basis from the World Bank average, so they are indicative, not an official A$ price). `
      : "") +
    (notes.length ? `Note: ${notes.join("; ")}. ` : "") +
    (r.not_found.length ? `Not found: ${r.not_found.join(" ")}` : "");
  const first = r.rows[0]!;
  const tag = hasOfficial && !hasMarket ? " (official US)" : "";
  const brief = r.rows.length === 1 ? `Gold ${first.month}: US$${first.usd_per_oz}/oz${tag}` : `Gold ${first.month} to ${r.rows.at(-1)!.month}: US$${first.usd_per_oz} to ${r.rows.at(-1)!.usd_per_oz}/oz${tag}`;
  return { answer, brief: brief.slice(0, 80) };
}
