import { lookupPrices } from "./price.ts";
import type { Cpi, GoldMonths } from "./store.ts";

export const CPI_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCNS";
export const REAL_LABEL = "US-dollar purchasing power (US CPI-U); not an Australian-dollar figure";
export const CPI_FIRST_YEAR = 1913;

export interface RealPriceRow {
  closure_year: number;
  nominal_usd_per_oz: number;
  nominal_basis: string;
  months_used: number;
  nominal_aud_per_oz: number | null;
  cpi_closure_year_average: number;
  cpi_months_used: number;
  cpi_latest_month: string;
  cpi_latest: number;
  real_usd_per_oz_in_latest_dollars: number;
  today_month: string;
  today_usd_per_oz: number;
  today_vs_closure_real_ratio: number;
  label: string;
  source_ref: string;
  source_url: string;
  price_source_refs: string[];
  price_source_urls: string[];
  checked_at: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Closure-year gold price against today, in today's US dollars. Closure-year price = mean of the monthly prices held for that year
 * (World Bank monthly average from 1960, the official US price before); CPI = mean of that year's CPI-U months; "today" = the latest
 * month both series hold. Nothing is returned when either series does not reach the year.
 */
export function realGoldPrice(gold: GoldMonths, cpi: Cpi, year: number): { row: RealPriceRow } | { not_found: string } {
  if (year < CPI_FIRST_YEAR) return { not_found: `gold_price_real for ${year}: US CPI-U starts in ${CPI_FIRST_YEAR}, so no real-dollar comparison is held for earlier years` };
  const lastCpiMonth = cpi.last;
  if (year > Number(lastCpiMonth.slice(0, 4))) return { not_found: `gold_price_real for ${year}: after the last CPI-U month held (${lastCpiMonth})` };
  const prices = lookupPrices(gold, { from: `${year}-01`, to: `${year}-12` });
  if (!prices.rows.length) return { not_found: `gold_price_real for ${year}: no gold price held for that year (${prices.not_found[0] ?? "not covered"})` };
  const usd = prices.rows.map((r) => r.usd_per_oz);
  const nominal = usd.reduce((a, b) => a + b, 0) / usd.length;
  const yearCpi = [...cpi.months].filter(([m]) => m.startsWith(`${year}-`)).map(([, v]) => v);
  if (!yearCpi.length) return { not_found: `gold_price_real for ${year}: no CPI-U observation for that year` };
  const cpiYear = yearCpi.reduce((a, b) => a + b, 0) / yearCpi.length;
  const cpiLatest = cpi.months.get(lastCpiMonth)!;
  // "Today" needs a gold price for the same month as the last CPI month; otherwise the latest gold month with a CPI value.
  let todayMonth = gold.last;
  while (!cpi.months.has(todayMonth) && todayMonth > gold.first) todayMonth = prevMonth(todayMonth);
  const today = gold.months.get(todayMonth)!;
  const cpiToday = cpi.months.get(todayMonth)!;
  const real = (nominal * cpiToday) / cpiYear;
  const official = prices.rows.every((r) => r.price_basis === "official");
  const mixed = !official && prices.rows.some((r) => r.price_basis === "official");
  const audVals = prices.rows.map((r) => r.aud_per_oz);
  return {
    row: {
      closure_year: year,
      nominal_usd_per_oz: r2(nominal),
      nominal_basis: official
        ? "mean of the official US gold price over the months of the year held (a statutory price, not a market average)"
        : mixed
          ? "mean of the months held: official US price before 1960, World Bank monthly average from 1960"
          : "mean of the World Bank Pink Sheet monthly averages for the year",
      months_used: prices.rows.length,
      nominal_aud_per_oz: audVals.every((v): v is number => v !== null) ? r2(audVals.reduce((a, b) => a + b, 0) / audVals.length) : null,
      cpi_closure_year_average: Math.round(cpiYear * 1000) / 1000,
      cpi_months_used: yearCpi.length,
      cpi_latest_month: todayMonth,
      cpi_latest: cpiToday,
      real_usd_per_oz_in_latest_dollars: r2(real),
      today_month: todayMonth,
      today_usd_per_oz: today.usd,
      today_vs_closure_real_ratio: r2(today.usd / real),
      label: REAL_LABEL,
      source_ref: "FRED-CPIAUCNS",
      source_url: cpi.url,
      price_source_refs: [...new Set(prices.rows.map((r) => r.source_ref))],
      price_source_urls: prices.sources,
      checked_at: cpi.fetched,
    },
  };
}

function prevMonth(m: string): string {
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7));
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
}
