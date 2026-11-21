// Downloads US CPI-U (all items, US city average, not seasonally adjusted) from FRED into data/cpi.json.
// FRED series CPIAUCNS is the BLS series CUUR0000SA0 (checked: the BLS v1 API gave identical Aug to Oct 2026 values on the fetch date).
// Keyless GET. Run by hand; never at request time. The fetch date is the snapshot date every real-price answer reports.
import { writeFileSync } from "node:fs";
import { CPI_URL } from "../src/real.ts";
import { USER_AGENT } from "../src/sources.ts";

const res = await fetch(CPI_URL, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(60_000) });
if (!res.ok) throw new Error(`FRED answered ${res.status}`);
const lines = (await res.text()).trim().split("\n");
if (lines[0] !== "observation_date,CPIAUCNS") throw new Error(`unexpected header ${lines[0]}`);
const months: [string, number][] = [];
for (const line of lines.slice(1)) {
  const [d, v] = line.split(",");
  if (!d || !v || v === ".") continue;
  months.push([d.slice(0, 7), Number(v)]);
}
writeFileSync(
  new URL("../data/cpi.json", import.meta.url),
  JSON.stringify({
    series: "US CPI-U, all items, US city average, not seasonally adjusted, index 1982-1984=100 (FRED CPIAUCNS = BLS CUUR0000SA0)",
    url: CPI_URL,
    series_page: "https://fred.stlouisfed.org/series/CPIAUCNS",
    licence: "U.S. Bureau of Labor Statistics data: public domain, citation requested (BLS Copyright Information page; FRED series page: 'Public Domain: Citation Requested')",
    fetched: new Date().toISOString().slice(0, 10),
    months,
  }),
);
console.log("cpi months", months.length, months[0], months.at(-1));
