// Builds eval/pairs.jsonl: preference pairs (correct vs wrong answer) from the curated records and the open series.
// Same row shape as research/factcheck/pairs.jsonl. Local seed material only; nothing here is uploaded anywhere.
//   node scripts/make-eval-pairs.ts
import { writeFileSync } from "node:fs";
import { createHandler } from "../src/app.ts";
import { loadStore } from "../src/store.ts";

const store = loadStore();
const h = createHandler(store);
const INTENT = "RESEARCH_QUERY_GENERAL";
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const get = (q: string): Body => h.ask(new URLSearchParams({ question: q })).body;

const rows: Record<string, unknown>[] = [];
function pair(kind: string, prompt: string, chosen: string, rejected: string, source_url: string, note: string) {
  rows.push({
    label_kind: "preference_pair", intent_id: INTENT, prompt, chosen, rejected,
    provenance: { source_kind: `goldrush_${kind}`, source_url, note },
  });
}

const gsqUrl = (n: number) => `https://spatial-gis.information.qld.gov.au/arcgis/rest/services/GeoscientificInformation/MiningResources/MapServer/16/query?where=site_no%3D${n}&outFields=%2A&f=json`;

// 1. Wrong production figure
const mm = get("site 494270");
const qld = mm.production.find((p: Body) => p.source_ref === "QLDGOV-MM" && p.commodity === "gold");
const wp = mm.production.find((p: Body) => p.source_ref === "WP-MM" && p.commodity === "gold");
const mmQ = "How much gold did the Mount Morgan mine in Queensland produce?";
pair("wrong_production", mmQ,
  `The Queensland Government gives about ${qld.amount} tonnes of gold for Mount Morgan (${qld.period_from} to ${qld.period_to}); Wikipedia gives approximately ${wp.amount} tonnes (${wp.period_from} to ${wp.period_to}). The two figures differ and both are reported as given. Sources: ${qld.source_url} ; ${wp.source_url}`,
  `Mount Morgan produced about ${qld.amount * 10} tonnes of gold between ${qld.period_from} and ${qld.period_to}, according to the Queensland Government. Sources: ${qld.source_url}`,
  qld.source_url, "figure inflated tenfold, attributed to the real source");
pair("wrong_production", mmQ,
  `The Queensland Government gives about ${qld.amount} tonnes of gold for Mount Morgan; Wikipedia gives approximately ${wp.amount} tonnes. Both are kept. Sources: ${qld.source_url} ; ${wp.source_url}`,
  `Mount Morgan produced about ${qld.amount} ounces of gold in total. Source: ${qld.source_url}`,
  qld.source_url, "unit confusion: tonnes restated as ounces");
pair("merged_conflict", mmQ,
  `Two sources, two figures: about ${qld.amount} t gold (Queensland Government, ${qld.period_from} to ${qld.period_to}) and approximately ${wp.amount} t (Wikipedia, ${wp.period_from} to ${wp.period_to}). They are not averaged.`,
  `Mount Morgan produced about ${(qld.amount + wp.amount) / 2} tonnes of gold (the average of the published figures). Sources: ${qld.source_url} ; ${wp.source_url}`,
  qld.source_url, "averages two sources instead of preserving both");
pair("wrong_period", "Over what years did the Mount Morgan mine produce the gold, per the Queensland Government?",
  `The Queensland Government page says the mine was founded in ${qld.period_from} and its mining operations continued until November ${qld.period_to}. Source: ${qld.source_url}`,
  `The Queensland Government page says the mine produced gold from 1882 until 1927. Source: ${qld.source_url}`,
  qld.source_url, "period swapped for the 1927 underground closure, which is a different source and entity");

// 2. Invented closure reason
const close90 = mm.closure.find((c: Body) => c.source_ref === "QLDGOV-MM");
const close81 = mm.closure.find((c: Body) => c.source_ref === "WP-MM" && c.year === 1981);
const closeQ = "When and why did the Mount Morgan mine close?";
pair("invented_closure_reason", closeQ,
  `Two sources give two closure years. The Queensland Government says mining operations continued until November ${close90.year} and quotes no reason. Wikipedia says the operation reached the end of its ore body in ${close81.year} (exhausted). Sources: ${close90.source_url} ; ${close81.source_url}`,
  `Mount Morgan closed in ${close90.year} because gold prices collapsed and the pit flooded, making it uneconomic. Source: ${close90.source_url}`,
  close90.source_url, "invents an economic and flooding reason the source never states");
pair("invented_closure_reason", closeQ,
  `The sources quote no single reason. Wikipedia says the company "reached the end of its ore body in ${close81.year}" (class: exhausted); the Queensland Government gives ${close90.year} with no reason. Sources: ${close81.source_url} ; ${close90.source_url}`,
  `Mount Morgan was closed by court order in ${close90.year} after a legal dispute with the Queensland Government. Source: ${close90.source_url}`,
  close81.source_url, "invents a legal reason");
const dd = get("site 38730");
const ddClose = dd.closure[0];
pair("invented_closure_reason", "When and why did the Day Dawn mine at Charters Towers close?",
  `The Heritage Register entry says: "${ddClose.reason_text}" It names no further cause, so the reason class is unknown. Source: ${ddClose.source_url}`,
  `The Day Dawn mine closed in ${ddClose.year} after a flood drowned the lower levels. Source: ${ddClose.source_url}`,
  ddClose.source_url, "invents flooding");
pair("wrong_year", "When did the Brilliant Extended mine at Charters Towers close?",
  `The Queensland Heritage Register text says the last of the big mines, the Brilliant Extended, closed down in ${get("site 38722").closure[0].year}. Source: ${get("site 38722").closure[0].source_url}`,
  `The Brilliant Extended closed down in 1932. Source: ${get("site 38722").closure[0].source_url}`,
  get("site 38722").closure[0].source_url, "wrong year");

// 3. Wrong coordinates
for (const n of [494270, 38730]) {
  const b = get(`site ${n}`);
  const g = b.gsq_record;
  pair("wrong_coordinates", `Where is the ${b.site_name} gold working (GSQ site ${n}) in Queensland?`,
    `GSQ site ${n} (${b.site_name}) is at latitude ${g.latitude}, longitude ${g.longitude} (GDA94), accuracy ${g.location_accuracy_m} m, ${String(g.locality).toLowerCase()}. Source: ${g.source_url}`,
    `GSQ site ${n} (${b.site_name}) is at latitude ${(g.latitude + 2.4).toFixed(6)}, longitude ${(g.longitude - 3.1).toFixed(6)}, ${String(g.locality).toLowerCase()}. Source: ${g.source_url}`,
    g.source_url, "coordinates moved by hundreds of kilometres while keeping the real locality text");
}
{
  const g = get("site 494270").gsq_record;
  pair("wrong_coordinates", "Give the position of Mount Morgan (GSQ site 494270) and its survey size band.",
    `Latitude ${g.latitude}, longitude ${g.longitude}; GSQ gold size band ${g.size_band.toLowerCase()} (${g.size_definition.toLowerCase()}). Source: ${g.source_url}`,
    `Latitude ${g.longitude}, longitude ${g.latitude}; GSQ gold size band small. Source: ${g.source_url}`,
    g.source_url, "latitude and longitude swapped, wrong size band");
}

// 4. Not found must stay not found
const sun = get("site 38776");
pair("invented_production", "How much gold did the Sunburst Lode at Charters Towers produce, and who owned it?",
  `None of the indexed sources gives a production figure or an owner for Sunburst Lode (GSQ site 38776); the survey records it as abandoned, gold size band small. Not found: production, closure, ownership. Source: ${sun.gsq_record.source_url}`,
  `Sunburst Lode produced about 14,000 ounces of gold between 1895 and 1911 and was owned by the Sunburst Gold Mining Company. Source: ${sun.gsq_record.source_url}`,
  sun.gsq_record.source_url, "fabricates production and owner where nothing is recorded");
pair("invented_production", "Did the Xanadu lode near Allora in Queensland ever record gold production? Give the figure.",
  `No production figure is held for Xanadu (GSQ site 504677). The survey lists it as a very small abandoned gold working. Not found: production.`,
  `Xanadu recorded 3,200 ounces of gold production before closing in 1908.`,
  gsqUrl(504677), "fabricates a figure for a very small working");

// 5. Ambiguous name
pair("wrong_site", "Tell me about the Silver Queen gold mine in Queensland.",
  `There are two GSQ gold sites named Silver Queen (36745 on the Atherton sheet and 481748 on the Ravenswood sheet), both very small. Which one do you mean? Repeat with 'site <number>'.`,
  `Silver Queen (GSQ site 36745) produced about 800 ounces of gold and closed in 1904.`,
  gsqUrl(36745), "picks one of two same-sized same-name sites and invents a history");

// 6. Gold price
const price = (q: string): Body => h.price(new URLSearchParams({ question: q })).body;
for (const m of ["1980-03", "2011-09", "1996-06"]) {
  const [y, mo] = m.split("-");
  const monthName = new Date(Date.UTC(Number(y), Number(mo) - 1, 1)).toLocaleString("en-AU", { month: "long", timeZone: "UTC" });
  const row = price(`gold price in ${monthName} ${y}`).gold_price[0];
  const wrong = price(`gold price in ${monthName} ${Number(y) + 1}`).gold_price[0];
  pair("wrong_gold_price", `What was the price of gold in ${monthName} ${y} in US dollars and Australian dollars per ounce?`,
    `${m}: US$${row.usd_per_oz} per troy ounce (World Bank Pink Sheet monthly average) and about A$${row.aud_per_oz}, derived with the RBA month-end A$1=US$${row.fx_usd_per_aud} rate. Sources: ${row.source_url} ; https://www.rba.gov.au/statistics/historical-data.html`,
    `${m}: US$${wrong.usd_per_oz} per troy ounce and A$${wrong.usd_per_oz} (Australian dollars equal US dollars). Source: ${row.source_url}`,
    row.source_url, "price taken from the following year, AUD not converted");
}
pair("invented_gold_price", "What was the price of gold in March 1903 in Australian dollars?",
  `The openly licensed monthly series starts in January 1960, so no figure is held for March 1903. Not found: gold_price.`,
  `Gold was about A$4.25 per ounce in March 1903. Source: https://www.worldbank.org/en/research/commodity-markets`,
  "https://www.worldbank.org/en/research/commodity-markets", "invents a pre-1960 figure and attributes it to the World Bank");

writeFileSync(new URL("../eval/pairs.jsonl", import.meta.url), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log("pairs", rows.length);
