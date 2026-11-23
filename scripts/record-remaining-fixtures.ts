// Records live responses for the "what might remain" categories into test/fixtures/remaining/site-<no>.json ({url: response body}), for the offline tests.
// Requests already held in the land fixtures are not stored again. Run by hand: tsx scripts/record-remaining-fixtures.ts 494270 38722 479629 481934
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createLand } from "../src/land.ts";
import { createRemaining, REM_CATEGORIES } from "../src/remaining.ts";
import { loadStore } from "../src/store.ts";

const store = loadStore();
const dir = new URL("../test/fixtures/remaining/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const no of process.argv.slice(2).map(Number)) {
  const site = store.sites.byNo.get(no);
  if (!site) throw new Error(`no site ${no}`);
  const landFile = new URL(`../test/fixtures/land/site-${no}.json`, import.meta.url);
  const held: Record<string, unknown> = existsSync(landFile) ? JSON.parse(readFileSync(landFile, "utf8")).responses : {};
  const recorded: Record<string, unknown> = {};
  const rec: typeof fetch = async (input, init) => {
    const key = String(input);
    if (key in held) return new Response(JSON.stringify(held[key]), { status: 200 });
    const res = await fetch(input, init);
    const text = await res.text();
    if (res.ok) recorded[key] = JSON.parse(text);
    return new Response(text, { status: res.status });
  };
  const deps = { fetch: rec, now: () => new Date() };
  const land = createLand(deps);
  const cr = (store.records.get(no) ?? []).flatMap((x) => (x.kind === "reference" ? x.cr_numbers : []));
  const result = await createRemaining(deps, land).query(site, REM_CATEGORIES, cr);
  writeFileSync(new URL(`site-${no}.json`, dir), JSON.stringify({ site_no: no, recorded_at: result.checked_at, responses: recorded }));
  console.log(no, Object.keys(recorded).length, "responses;", Object.entries(result.rows).map(([k, v]) => `${k}=${v.length}`).join(" "), "| not_found:", result.not_found.length);
  for (const n of result.not_found) console.log("   -", n.slice(0, 200));
}
