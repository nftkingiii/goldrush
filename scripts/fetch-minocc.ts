// Downloads the GSQ MINOCC "Historical workings" layer (gold sites only) into data/raw/minocc-gold.json.
// Keyless public ArcGIS endpoint, CC BY 4.0, State of Queensland. Run by hand; never at request time.
import { writeFileSync } from "node:fs";

const LAYER =
  "https://spatial-gis.information.qld.gov.au/arcgis/rest/services/GeoscientificInformation/MiningResources/MapServer/16/query";
const FIELDS = [
  "site_no", "occur_name", "site_locality", "sheet_100_name", "latitude", "longitude", "loc_accuracy",
  "mine_status", "exposure_type", "group_name", "main_commodity", "main_occur_size", "main_occur_size_def",
  "all_commodities", "date_current",
];
const UA = "goldrush-miner/0.1 (research; keyless read of GSQ MINOCC)";

async function page(offset: number) {
  const url = new URL(LAYER);
  url.search = new URLSearchParams({
    where: "all_commodities LIKE '%Au(%'",
    outFields: FIELDS.join(","),
    returnGeometry: "false",
    orderByFields: "site_no",
    resultOffset: String(offset),
    resultRecordCount: "1000",
    f: "json",
  }).toString();
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`GSQ ${res.status}`);
  return (await res.json()) as { features: { attributes: Record<string, unknown> }[]; exceededTransferLimit?: boolean };
}

const rows: Record<string, unknown>[] = [];
for (let offset = 0; ; offset += 1000) {
  const p = await page(offset);
  for (const f of p.features) rows.push(f.attributes);
  if (!p.features.length || p.features.length < 1000) break;
}
const out = {
  dataset: "Queensland mines and mineral occurrences (MINOCC), Historical workings layer, gold sites",
  source_url: "https://spatial-gis.information.qld.gov.au/arcgis/rest/services/GeoscientificInformation/MiningResources/MapServer/16",
  licence: "CC BY 4.0, State of Queensland (Department of Natural Resources and Mines)",
  fetched: new Date().toISOString().slice(0, 10),
  count: rows.length,
  rows,
};
writeFileSync(new URL("../data/raw/minocc-gold.json", import.meta.url), JSON.stringify(out));
console.log("sites", rows.length);
