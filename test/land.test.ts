import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createHandler, isLandQuestion, isRealPriceQuestion, landCategories } from "../src/app.ts";
import { CAVEAT, LAYERS, queryUrl } from "../src/land.ts";
import { realGoldPrice } from "../src/real.ts";
import { loadStore } from "../src/store.ts";

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const store = loadStore();

/** Recorded ArcGIS responses (test/fixtures/land/site-<no>.json, taken live on 2026-11-21). The stub refuses any URL that was not recorded. */
const responses: Record<string, unknown> = {};
for (const no of [494270, 38722, 479629]) Object.assign(responses, JSON.parse(readFileSync(new URL(`./fixtures/land/site-${no}.json`, import.meta.url), "utf8")).responses);

function stub(opts: { fail?: (url: string) => string | null; calls?: string[] } = {}): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    opts.calls?.push(url);
    const why = opts.fail?.(url);
    if (why === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    if (why) return new Response("boom", { status: Number(why) });
    const hit = responses[url];
    assert.ok(hit, `unrecorded request ${url}`);
    return new Response(JSON.stringify(hit), { status: 200 });
  }) as typeof fetch;
}

const NOW = new Date("2026-11-21T10:00:00.000Z");
const handler = (opts?: Parameters<typeof stub>[0], now: () => Date = () => NOW) => createHandler(store, { fetch: stub(opts), now });
const ask = (h: ReturnType<typeof createHandler>, question: string) => h.askAsync(new URLSearchParams({ question })) as Promise<{ status: number; body: Body }>;

test("question parsing: which of the three the question asks for, and what is a land or a real-price question", () => {
  assert.deepEqual(landCategories("who holds the tenure at Mount Morgan"), ["tenure"]);
  assert.deepEqual(landCategories("native title at Brilliant Lode"), ["native_title"]);
  assert.deepEqual(landCategories("land status of site 494270"), ["land_status"]);
  assert.deepEqual(landCategories("everything about land and rights at Mount Morgan"), ["tenure", "native_title", "land_status"]);
  assert.ok(isLandQuestion("who holds the tenure at Mount Morgan"));
  assert.ok(!isLandQuestion("Tell me about the Mount Morgan gold mine, Queensland: who owned it, how much gold it produced, and when and why it closed."));
  assert.ok(!isLandQuestion("gold price in March 1980"));
  assert.ok(isRealPriceQuestion("gold price at closure vs today for Brilliant Lode"));
  assert.ok(!isRealPriceQuestion("gold price in March 1980"));
});

test("Mount Morgan tenure: the mining lease over the site point, its holder, dates and status, each row sourced and timestamped", async () => {
  const { status, body } = await ask(handler(), "who holds the tenure at Mount Morgan");
  assert.equal(status, 200);
  assert.equal(body.site_no, 494270);
  assert.deepEqual(body.categories, ["tenure"]);
  assert.equal(body.native_title, undefined);
  const over = body.tenure.filter((r: Body) => r.relation === "contains_site_point");
  const ml = over.find((r: Body) => r.tenure_id === "ML 5623");
  assert.equal(ml.tenure_type, "ML");
  assert.deepEqual(ml.holders, ["HERITAGE MINERALS PTY LTD"]);
  assert.equal(ml.status, "Granted");
  assert.equal(ml.sub_status, "Renewal Lodged");
  assert.equal(ml.grant_date, "1974-05-15");
  assert.equal(ml.expiry_date, "2025-08-30");
  const epm = body.tenure.find((r: Body) => r.tenure_id === "EPM 17850");
  assert.equal(epm.relation, "within_buffer");
  assert.equal(epm.expiry_date, "2027-04-14");
  for (const r of body.tenure) {
    assert.ok(r.source_ref && r.record_id && r.layer);
    assert.match(r.source_url, /^https:\/\/spatial-gis\.information\.qld\.gov\.au\/arcgis\/rest\/services\/.+\/query\?/);
    assert.equal(r.checked_at, NOW.toISOString());
  }
  assert.equal(body.caveat, CAVEAT);
  assert.ok(body.answer.includes(CAVEAT));
  assert.equal(body.buffer.within_metres, 2000);
  assert.match(body.answer, /point-in-polygon/);
  assert.ok(body.brief.length <= 80);
  assert.equal(body.source_count, body.sources.length);
});

test("Mount Morgan tenure: more records than the cap are cut and the answer says so", async () => {
  const { body } = await ask(handler(), "who holds the tenure at Mount Morgan");
  assert.equal(body.tenure.filter((r: Body) => r.layer === "Mining lease (ML)").length, 25);
  assert.ok(body.notes.some((n: string) => /Mining lease \(ML\) has 30 records/.test(n)));
  assert.ok(!body.not_found.some((n: string) => /has 30 records/.test(n)), "a cut list is a note, not a not_found");
  assert.equal((body.answer.match(/ML 5623 \(/g) ?? []).length, 1, "a tenure present in two layers is named once in the text");
});

test("Brilliant Lode native title: determination outcomes with their stated outcome, ILUAs, and no application where none exists", async () => {
  const { status, body } = await ask(handler(), "native title at Brilliant Lode");
  assert.equal(status, 200);
  assert.equal(body.site_no, 38722);
  const outcomes = body.native_title.filter((r: Body) => r.record_type === "determination_outcome");
  assert.ok(outcomes.length >= 4);
  assert.ok(outcomes.some((r: Body) => r.outcome === "Native title exists (non-exclusive)" && r.name === "Gudjala People" && r.tribunal_id === "QCD2014/006"));
  assert.ok(outcomes.some((r: Body) => r.outcome === "Native title extinguished"));
  const ilua = body.native_title.filter((r: Body) => r.record_type === "ilua");
  assert.ok(ilua.some((r: Body) => r.tribunal_id === "QI2013/082" && r.relation === "contains_site_point" && r.agreement_status === "ILUA registered"));
  assert.equal(body.native_title.filter((r: Body) => r.record_type === "application").length, 0);
  for (const r of body.native_title) {
    assert.match(r.source_url, /^https:\/\/services2\.arcgis\.com\/rzk7fNEt0xoEp3cX\/ArcGIS\/rest\/services\/NNTT_Custodial_AGOL\/FeatureServer\/\d\/query\?/);
    assert.ok(r.record_id && r.source_ref && r.checked_at);
    assert.match(r.nntt_date_currency, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.ok(body.answer.includes("Native title records are as published by the NNTT on the checked date."));
});

test("Mount Morgan native title: a registered claimant application is reported with its registration status", async () => {
  const { body } = await ask(handler(), "native title at Mount Morgan");
  const app = body.native_title.find((r: Body) => r.record_type === "application");
  assert.equal(app.tribunal_id, "QC2012/009");
  assert.equal(app.registration_test_status, "Accepted for registration");
  assert.equal(app.relation, "contains_site_point");
  const d = body.native_title.find((r: Body) => r.record_type === "determination_outcome");
  assert.equal(d.name, "Darumbal People");
  assert.equal(d.outcome, "Native title exists (non-exclusive)");
});

test("land status of site 494270: abandoned-mines program site and pit, heritage places within 2 km, no protected area", async () => {
  const { body } = await ask(handler(), "land status of site 494270");
  assert.equal(body.matched_by, "site_no");
  const prog = body.land_status.find((r: Body) => r.record_type === "abandoned_mine_program_site");
  assert.equal(prog.program_site_id, "PS0023");
  assert.equal(prog.mine_name, "MOUNT MORGAN");
  assert.equal(prog.relation, "contains_site_point");
  assert.ok(body.land_status.some((r: Body) => r.record_type === "abandoned_mine_pit" && r.minocc_id === 494270));
  assert.ok(body.land_status.some((r: Body) => r.record_type === "heritage_place" && r.name === "Mount Morgan Railway Station Complex" && r.relation === "within_buffer"));
  assert.equal(body.land_status.filter((r: Body) => r.record_type === "protected_area").length, 0);
  assert.match(body.answer, /no protected area/);
});

test("everything about land and rights returns all three, and every row has the five required fields", async () => {
  const { body } = await ask(handler(), "everything about land and rights at Mount Morgan");
  assert.deepEqual(body.categories, ["tenure", "native_title", "land_status"]);
  for (const k of ["tenure", "native_title", "land_status"]) {
    assert.ok(body[k].length > 0, k);
    for (const r of body[k]) for (const f of ["source_ref", "source_url", "record_id", "checked_at", "relation"]) assert.ok(r[f], `${k} row lacks ${f}`);
  }
  assert.equal(body.checks.length, LAYERS.length);
  assert.ok(body.checks.every((c: Body) => !c.error));
});

test("a third site (Kidston): tenure and mine openings read from other recorded responses", async () => {
  const { body } = await ask(handler(), "everything about land and rights at site 479629");
  assert.ok(body.tenure.some((r: Body) => r.tenure_id === "ML 3347" && r.relation === "contains_site_point"));
  assert.ok(body.tenure.some((r: Body) => r.tenure_id === "EPM 27579"));
  assert.ok(body.land_status.some((r: Body) => r.name === "Kidston State Battery & Township"));
});

test("a layer that fails is reported as not checked with its reason; nothing is filled in and nothing is cached", async () => {
  const calls: string[] = [];
  const h = handler({ calls, fail: (u) => (u.includes("/NNTT_Custodial_AGOL/FeatureServer/4/") ? "timeout" : u.includes("/MapServer/40/") ? "503" : null) });
  const first = (await ask(h, "everything about land and rights at Mount Morgan")).body;
  const ilua = first.checks.find((c: Body) => c.source_ref === "NNTT-ILUA");
  assert.match(ilua.error, /timed out/);
  assert.equal(ilua.count_within_buffer, null);
  assert.equal(first.native_title.filter((r: Body) => r.record_type === "ilua").length, 0);
  assert.ok(first.not_found.some((n: string) => /Indigenous Land Use Agreements not checked \(timed out/.test(n)));
  assert.ok(first.not_found.some((n: string) => /Exploration permit for mineral \(EPM\) not checked \(HTTP 503\)/.test(n)));
  assert.ok(first.tenure.every((r: Body) => r.tenure_id !== "EPM 17850"), "the failed layer's record is not invented from anywhere else");
  assert.match(first.answer, /Not found or not checked/);
  const before = calls.length;
  await ask(h, "everything about land and rights at Mount Morgan");
  const again = calls.slice(before);
  assert.ok(again.some((u) => u.includes("/FeatureServer/4/")), "the failed layer is asked again");
  assert.ok(!again.some((u) => u.includes("/FeatureServer/5/")), "layers that answered are served from the 24 h cache");
});

test("the per-site cache keeps checked_at as the fetch time and expires after 24 hours", async () => {
  let t = NOW.getTime();
  const calls: string[] = [];
  const h = handler({ calls }, () => new Date(t));
  const a = (await ask(h, "who holds the tenure at Mount Morgan")).body;
  const n = calls.length;
  t += 23 * 3600 * 1000;
  const b = (await ask(h, "who holds the tenure at Mount Morgan")).body;
  assert.equal(calls.length, n, "no new requests inside 24 hours");
  assert.equal(b.tenure[0].checked_at, a.tenure[0].checked_at, "checked_at is when the data was pulled, not when it was served");
  t += 2 * 3600 * 1000;
  const c = (await ask(h, "who holds the tenure at Mount Morgan")).body;
  assert.ok(calls.length > n, "asked again after 24 hours");
  assert.equal(c.tenure[0].checked_at, new Date(t).toISOString());
});

test("a layer with nothing over or near the site is reported as not_found with the caveat, never as 'available'", async () => {
  const { body } = await ask(handler(), "who holds the tenure at site 479629");
  assert.ok(!body.not_found.some((n: string) => /^tenure: nothing recorded/.test(n)), "Kidston has tenure");
  const quiet = (await ask(handler(), "land status of site 479629")).body;
  assert.equal(quiet.land_status.filter((r: Body) => r.record_type === "protected_area").length, 0);
  assert.ok(quiet.answer.includes(CAVEAT));
  assert.ok(!/available/i.test(quiet.answer.replace(CAVEAT, "")));
});

test("queries are point-in-polygon and a 2 km distance query on the official layers", () => {
  const site = store.sites.byNo.get(494270)!;
  const ml = LAYERS.find((l) => l.layer === 120)!;
  const near = new URL(queryUrl(ml, site, true));
  const point = new URL(queryUrl(ml, site, false));
  assert.equal(near.searchParams.get("distance"), "2000");
  assert.equal(near.searchParams.get("units"), "esriSRUnit_Meter");
  assert.equal(point.searchParams.get("distance"), null);
  assert.equal(point.searchParams.get("geometry"), `${site.lon},${site.lat}`);
  assert.equal(point.searchParams.get("geometryType"), "esriGeometryPoint");
  assert.equal(point.searchParams.get("returnGeometry"), "false");
});

test("an unknown site gets the same 422 as the other site questions", async () => {
  const { status, body } = await ask(handler(), "who holds the tenure at Atlantis Reef");
  assert.equal(status, 422);
  assert.equal(body.error, "no_matching_site");
});

test("existing questions are untouched by the async entry point", async () => {
  const price = await ask(handler(), "gold price in March 1980");
  assert.equal(price.body.gold_price[0].usd_per_oz, 554);
  const site = await ask(handler(), "site 494270");
  assert.equal(site.body.site_name, "Mount Morgan");
  assert.equal(site.body.tenure, undefined);
});

// gold_price_real

test("real gold price, Brilliant Lode: the MINOCC closure year, the official price, CPI-U, labelled US-dollar purchasing power, no A$", async () => {
  const { status, body } = await ask(handler(), "gold price at closure vs today for Brilliant Lode");
  assert.equal(status, 200);
  assert.equal(body.site_no, 38722);
  assert.equal(body.closure_year_used.year, 1917);
  assert.match(body.closure_year_used.basis, /latest End Year in the MINOCC 2017 MineHist/);
  const g = body.gold_price_real[0];
  assert.equal(g.nominal_usd_per_oz, 20.67);
  assert.equal(g.nominal_aud_per_oz, null);
  const cpi1917 = [...store.cpi.months].filter(([m]) => m.startsWith("1917-")).map(([, v]) => v);
  const avg = cpi1917.reduce((a, b) => a + b, 0) / 12;
  assert.equal(g.cpi_months_used, 12);
  assert.equal(g.real_usd_per_oz_in_latest_dollars, Math.round(((20.67 * g.cpi_latest) / avg) * 100) / 100);
  assert.ok(g.real_usd_per_oz_in_latest_dollars > 300 && g.real_usd_per_oz_in_latest_dollars < 600);
  assert.match(g.label, /US-dollar purchasing power/);
  assert.equal(g.source_ref, "FRED-CPIAUCNS");
  assert.match(g.source_url, /fred\.stlouisfed\.org/);
  assert.equal(g.checked_at, store.cpi.fetched);
  assert.match(body.answer, /US-dollar purchasing power/);
  assert.ok(body.brief.length <= 80);
});

test("real gold price, Mount Morgan: closure 1990 from MINOCC, the other sources' years disclosed but not used", async () => {
  const { body } = await ask(handler(), "gold price at closure vs today for site 494270");
  assert.equal(body.closure_year_used.year, 1990);
  assert.match(body.closure_year_used.basis, /other sources give/);
  const g = body.gold_price_real[0];
  assert.equal(g.months_used, 12);
  assert.ok(g.nominal_aud_per_oz === null || g.nominal_aud_per_oz > 0);
  assert.ok(g.today_vs_closure_real_ratio > 1);
});

test("real gold price: before 1913 there is no CPI-U, so it is not_found, and before 1900 no price either", () => {
  const a = realGoldPrice(store.gold, store.cpi, 1908);
  assert.ok("not_found" in a);
  assert.match((a as { not_found: string }).not_found, /CPI-U starts in 1913/);
  const b = realGoldPrice(store.gold, store.cpi, 1895);
  assert.ok("not_found" in b);
  const c = realGoldPrice(store.gold, store.cpi, 1913);
  assert.ok("row" in c);
  assert.equal(c.row.nominal_usd_per_oz, 20.67);
  const d = realGoldPrice(store.gold, store.cpi, 1975);
  assert.ok("row" in d);
  assert.ok(d.row.nominal_aud_per_oz === null || d.row.nominal_aud_per_oz > 0);
});

test("real gold price: a site with no MINOCC closure year gets not_found, not a guessed year", async () => {
  const none = [...store.sites.byNo.keys()].find((no) => !(store.records.get(no) ?? []).some((r) => r.kind === "closure"))!;
  const { body } = await ask(handler(), `gold price at closure vs today for site ${none}`);
  assert.deepEqual(body.gold_price_real, []);
  assert.match(body.not_found[0], /no MINOCC MineHist end year/);
});
