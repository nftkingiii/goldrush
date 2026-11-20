import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadStore } from "../src/store.ts";

const norm = (s: string) => s.replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();
const evidence = JSON.parse(readFileSync(new URL("../data/evidence.json", import.meta.url), "utf8"));

function pageText(fixture: string): string {
  const raw = readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), "utf8");
  return norm(fixture.endsWith(".json") ? (Object.values(JSON.parse(raw).query.pages)[0] as { extract: string }).extract : raw);
}

test("every evidence quote and quoted reason appears verbatim in the recorded page it cites", () => {
  const pages = Object.fromEntries(Object.entries(evidence.sources).map(([k, s]) => [k, pageText((s as { fixture: string }).fixture)]));
  for (const r of evidence.records) {
    assert.ok(pages[r.source_ref]!.includes(norm(r.quote)), `${r.id}: quote not found in ${r.source_ref}`);
    if (r.reason_text) assert.ok(pages[r.source_ref]!.includes(norm(r.reason_text)), `${r.id}: reason_text is not a verbatim quote`);
  }
});

test("a closure reason class other than unknown needs a quoted reason that states it", () => {
  for (const r of evidence.records.filter((x: { kind: string }) => x.kind === "closure")) {
    if (r.reason_class !== "unknown") assert.ok(r.reason_text, `${r.id} has class ${r.reason_class} but no quoted reason`);
    if (!r.reason_text) assert.equal(r.reason_class, "unknown", `${r.id} has no reason text so its class must be unknown`);
  }
});

test("the store loads, and every evidence site exists in the GSQ index", () => {
  const store = loadStore();
  assert.ok(store.sites.byNo.size > 8000);
  for (const siteNo of store.records.keys()) assert.ok(store.sites.byNo.has(siteNo));
  for (const sources of Object.values(store.sources)) {
    assert.ok(sources.url.startsWith("https://"));
    assert.ok(sources.licence);
    assert.ok(sources.retrieved);
  }
});

test("the index keeps the dataset versions and dates it was built from", () => {
  const store = loadStore();
  assert.match(store.datasets.minocc!.licence, /CC BY 4\.0/);
  assert.match(store.datasets.minocc!.fetched, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(store.datasets.minocc!.count, 8132);
  assert.equal(store.gold.first, "1960-01");
});
