// Downloads Geoscience Australia's Queensland gold deposits (OZMIN-derived MineralDeposits layer) into data/raw/ga-qld-gold.json.
// Keyless WFS, CC BY 4.0 per the service's AccessConstraints. Run by hand; never at request time.
import { writeFileSync } from "node:fs";
import { GA_WFS, USER_AGENT, parseGa } from "../src/sources.ts";

const q = new URLSearchParams({
  service: "WFS", version: "2.0.0", request: "GetFeature", typeNames: "ama:MineralDeposits",
  outputFormat: "application/json", cql_filter: "STATE='QLD'",
});
const res = await fetch(`${GA_WFS}?${q}`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(90_000) });
if (!res.ok) throw new Error(`GA answered ${res.status}`);
const rows = parseGa(await res.json()).filter((d) => /gold/i.test(d.commodities ?? ""));
writeFileSync(
  new URL("../data/raw/ga-qld-gold.json", import.meta.url),
  JSON.stringify({
    dataset: "Geoscience Australia, Mineral Deposits and Mineral Resources WFS (ama:MineralDeposits), Queensland, gold",
    source_url: GA_WFS,
    licence: "Creative Commons Attribution 4.0 International (service AccessConstraints: Copyright Commonwealth of Australia (Geoscience Australia) 2022)",
    fetched: new Date().toISOString().slice(0, 10),
    count: rows.length,
    rows,
  }),
);
console.log("ga gold deposits", rows.length);
