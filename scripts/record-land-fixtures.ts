// Records live ArcGIS responses for given sites into test/fixtures/land/site-<no>.json ({url: response body}), for the offline tests.
// Run by hand: tsx scripts/record-land-fixtures.ts 494270 38722
import { mkdirSync, writeFileSync } from "node:fs";
import { createLand } from "../src/land.ts";
import { loadStore } from "../src/store.ts";

const store = loadStore();
const dir = new URL("../test/fixtures/land/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const no of process.argv.slice(2).map(Number)) {
  const site = store.sites.byNo.get(no);
  if (!site) throw new Error(`no site ${no}`);
  const recorded: Record<string, unknown> = {};
  const rec: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    const text = await res.text();
    recorded[String(input)] = JSON.parse(text);
    return new Response(text, { status: res.status });
  };
  const land = createLand({ fetch: rec, now: () => new Date() });
  const result = await land.query(site, ["tenure", "native_title", "land_status"]);
  writeFileSync(new URL(`site-${no}.json`, dir), JSON.stringify({ site_no: no, recorded_at: result.checked_at, responses: recorded }, null, 0));
  console.log(no, Object.keys(recorded).length, "responses", result.not_found.length, "not_found notes");
}
