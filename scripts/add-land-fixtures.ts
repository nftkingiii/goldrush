// Adds responses for layers added since the fixtures were recorded, keeping every recorded response as it is.
// Run by hand: tsx scripts/add-land-fixtures.ts 494270 38722 479629
import { readFileSync, writeFileSync } from "node:fs";
import { createLand } from "../src/land.ts";
import { loadStore } from "../src/store.ts";

const store = loadStore();
for (const no of process.argv.slice(2).map(Number)) {
  const file = new URL(`../test/fixtures/land/site-${no}.json`, import.meta.url);
  const fx = JSON.parse(readFileSync(file, "utf8"));
  const site = store.sites.byNo.get(no);
  if (!site) throw new Error(`no site ${no}`);
  let added = 0;
  const rec: typeof fetch = async (input, init) => {
    const key = String(input);
    if (key in fx.responses) return new Response(JSON.stringify(fx.responses[key]), { status: 200 });
    const res = await fetch(input, init);
    const text = await res.text();
    fx.responses[key] = JSON.parse(text);
    added++;
    return new Response(text, { status: res.status });
  };
  await createLand({ fetch: rec, now: () => new Date(fx.recorded_at) }).query(site, ["tenure", "native_title", "land_status"]);
  writeFileSync(file, JSON.stringify(fx, null, 0));
  console.log(no, "added", added, "responses");
}
