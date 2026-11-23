import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { createHandler, isLandQuestion, isRemainingQuestion, remainingCategories, wantsLandToo } from "../src/app.ts";
import { ACCESS_LABEL, containedMetal, minDistanceKm, REMAINING_CAVEAT, RESOURCE_LABEL, reportPageUrl } from "../src/remaining.ts";
import { loadStore } from "../src/store.ts";

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const store = loadStore();

/** Recorded live responses (test/fixtures/remaining, taken 2026-11-23, and test/fixtures/land, taken 2026-11-21). The stub refuses any URL that was not recorded. */
const responses: Record<string, unknown> = {};
for (const no of [494270, 38722, 479629, 481934]) {
  for (const d of ["land", "remaining"]) {
    const f = new URL(`./fixtures/${d}/site-${no}.json`, import.meta.url);
    if (existsSync(f)) Object.assign(responses, JSON.parse(readFileSync(f, "utf8")).responses);
  }
}

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
const NOW = new Date("2026-11-23T10:00:00.000Z");
const handler = (opts?: Parameters<typeof stub>[0]) => createHandler(store, { fetch: stub(opts), now: () => NOW });
const ask = (h: ReturnType<typeof createHandler>, question: string) => h.askAsync(new URLSearchParams({ question })) as Promise<{ status: number; body: Body }>;

function rowConventions(rows: Body[], ref: RegExp) {
  for (const r of rows) {
    assert.ok(r.source_ref && r.record_id && r.relation && r.category, JSON.stringify(r).slice(0, 200));
    assert.ok(ref.test(r.source_url), r.source_url);
    assert.equal(r.checked_at, NOW.toISOString());
  }
}

test("question parsing: each category, the four together, the everything question, and the land questions stay land", () => {
  assert.deepEqual(remainingCategories("drilling near Mount Morgan"), ["exploration"]);
  assert.deepEqual(remainingCategories("modern resources at Brilliant Lode"), ["resources"]);
  assert.deepEqual(remainingCategories("access and infrastructure at Gympie"), ["access"]);
  assert.deepEqual(remainingCategories("environmental records at Kidston"), ["environment"]);
  assert.deepEqual(remainingCategories("what might remain at Ravenswood"), ["exploration", "resources", "access", "environment"]);
  assert.ok(wantsLandToo("everything about Mount Morgan including what might remain today"));
  assert.ok(wantsLandToo("full dossier for Mount Morgan"));
  assert.ok(!wantsLandToo("what might remain at Ravenswood"));
  for (const q of ["who holds the tenure at Mount Morgan", "native title at Brilliant Lode", "land status of site 494270", "everything about land and rights at Mount Morgan", "who holds the exploration permit at Mount Morgan", "abandoned mines at Mount Morgan"]) {
    assert.ok(!isRemainingQuestion(q), q);
    assert.ok(isLandQuestion(q), q);
  }
  assert.ok(!isRemainingQuestion("gold price in March 1980"));
});

test("pure helpers: straight-line distance to a point and a line, contained metal, report page URL", () => {
  const site = { lat: -20, lon: 146 };
  assert.ok(Math.abs(minDistanceKm(site, { x: 146, y: -20.1 })! - 11.1) < 0.2);
  // a line 5.55 km north of the site running east-west: the nearest point is the foot of the perpendicular, not an end
  const d = minDistanceKm(site, { paths: [[[145.5, -19.95], [146.5, -19.95]]] })!;
  assert.ok(Math.abs(d - 5.56) < 0.1, String(d));
  assert.equal(minDistanceKm(site, undefined), null);
  assert.deepEqual(containedMetal(1_000_000, 3.1103476800, "g/t"), { value: 100000, unit: "troy ounces" });
  assert.deepEqual(containedMetal(2_000_000, 0.5, "%"), { value: 10000, unit: "tonnes" });
  assert.equal(containedMetal(1000, 5, "weird"), null);
  assert.equal(containedMetal(1000, null, "g/t"), null);
  assert.equal(reportPageUrl(1393), "https://geoscience.data.qld.gov.au/report/cr001393");
});

test("Mount Morgan drilling: nearest boreholes first with operator, depth and distance; no MINOCC company report is a not_found", async () => {
  const { status, body } = await ask(handler(), "drilling near Mount Morgan");
  assert.equal(status, 200);
  assert.equal(body.site_no, 494270);
  assert.deepEqual(body.categories, ["exploration"]);
  assert.equal(body.resources, undefined);
  const bh = body.exploration.filter((r: Body) => r.record_type === "borehole");
  assert.equal(bh.length, 15);
  assert.equal(bh[0].name, "MOUNT MORGAN MINE 5-28");
  assert.equal(bh[0].operator, "MOUNT MORGAN LIMITED");
  assert.equal(bh[0].total_depth_m, 868.07);
  assert.equal(bh[0].relation, "within_buffer");
  assert.ok(bh[0].distance_m <= bh[1].distance_m);
  assert.equal(bh[0].year, null, "no drill date is invented");
  assert.ok(bh.some((r: Body) => r.operator === "PERILYA MINES NL"));
  rowConventions(body.exploration, /^https:\/\/spatial-gis\.information\.qld\.gov\.au\/arcgis\/rest\/services\/GeoscientificInformation\/Boreholes\/MapServer\/6\/query\?/);
  assert.ok(body.not_found.some((n: string) => /links no company report/.test(n)));
  assert.equal(body.exploration.filter((r: Body) => r.record_type === "company_report").length, 0);
  assert.equal(body.remaining_caveat, REMAINING_CAVEAT);
  assert.ok(body.answer.includes(REMAINING_CAVEAT));
  assert.match(body.caveats.exploration, /not of what it found/);
  assert.ok(body.brief.length <= 80);
});

test("Brilliant Lode company reports: CR numbers MINOCC links, with title, year and the report page link; the page was not fetched", async () => {
  const { body } = await ask(handler(), "exploration reports for Brilliant Lode");
  const cr = body.exploration.filter((r: Body) => r.record_type === "company_report");
  assert.deepEqual(cr.map((r: Body) => r.cr_number).sort((a: number, b: number) => a - b), [10953, 12721, 13258, 25584, 26969, 28518, 32042]);
  const r = cr.find((x: Body) => x.cr_number === 13258);
  assert.match(r.title, /EPM 1775 CHARTERS TOWERS FINAL REPORT/);
  assert.equal(r.relation, "linked_by_minocc");
  assert.equal(r.year, 1984);
  assert.equal(r.report_page_url, "https://geoscience.data.qld.gov.au/report/cr013258");
  assert.match(r.report_page_url_basis, /link field published by the GSQ report index/);
  assert.equal(r.in_report_index, true);
  assert.ok(cr[0].year >= cr[cr.length - 1].year, "most recent first");
  assert.match(r.source_url, /ReportIndex\/MapServer\/0\/query\?/);
  assert.ok(body.notes.some((n: string) => /MINOCC links 7 company reports/.test(n)));
});

test("Brilliant Lode modern resources: labelled, latest per zone, derived contained metal, historical production kept out", async () => {
  const { body } = await ask(handler(), "modern resources at Brilliant Lode");
  assert.deepEqual(body.categories, ["resources"]);
  const rows = body.resources as Body[];
  assert.equal(rows.length, 6);
  for (const r of rows) {
    assert.equal(r.label, RESOURCE_LABEL);
    assert.equal(r.record_type, "modern_resource");
    assert.match(r.source_url, /^https:\/\/services\.ga\.gov\.au\/gis\/earthresource\/wfs\?.*ReservesAndResources/);
    assert.equal(r.production, undefined);
  }
  const top = rows[0]!;
  assert.equal(top.deposit_name, "Charters Towers");
  assert.equal(top.reporting_date, "2020-12-09");
  assert.equal(top.classification_method, "JORC code 2012");
  assert.match(top.published_source, /Citigold/);
  const inferred = top.categories.find((c: Body) => c.category === "inferred resource");
  assert.equal(inferred.tonnes, 32_000_000);
  assert.equal(inferred.grade, 14);
  assert.equal(inferred.grade_unit, "g/t");
  assert.equal(inferred.contained_metal.unit, "troy ounces");
  assert.ok(Math.abs(inferred.contained_metal.value - (32_000_000 * 14) / 31.1034768) < 1);
  assert.match(top.contained_metal_basis, /derived here/);
  assert.ok(body.answer.includes("not historical production and not a claim about what remains"));
  assert.match(body.caveats.resources, /derived here as tonnes times grade/);
});

test("Kidston resources: the deposit is in the GA layer but has no resource record, so it comes back not_found with the reason", async () => {
  const { body } = await ask(handler(), "modern resources at Kidston");
  assert.equal(body.resources.length, 0);
  assert.ok(body.not_found.some((n: string) => /Kidston \(ENO 336212.*holds no reserve or resource record/.test(n)));
});

test("Mount Morgan access: nearest town, major road and power line, straight line and labelled", async () => {
  const { body } = await ask(handler(), "access and infrastructure at Mount Morgan");
  const by = (t: string) => body.access.find((r: Body) => r.record_type === t);
  assert.equal(by("nearest_town").name, "Mount Morgan");
  assert.equal(by("nearest_town").population, 2558);
  assert.ok(by("nearest_town").distance_km < 3);
  assert.equal(by("nearest_major_road").national_route, "A3");
  assert.equal(by("nearest_major_road").surface, "SEALED");
  assert.equal(by("nearest_power_line").name, "Calvale to Stanwell");
  assert.equal(by("nearest_power_line").capacity_kv, 275);
  assert.ok(by("nearest_power_line").distance_km > 1);
  for (const r of body.access) {
    assert.equal(r.distance_basis, ACCESS_LABEL);
    assert.equal(r.relation, "nearest_straight_line");
    assert.ok(r.search_radius_km >= 5);
  }
  rowConventions(body.access, /^https:\/\/(services-ap1\.arcgis\.com|services\.ga\.gov\.au)\/.+\/query\?/);
  assert.match(body.answer, /straight-line distance, not route distance/);
});

test("Kidston access: a remote site widens the search radius and still answers, with the radius stated", async () => {
  const { body } = await ask(handler(), "access and infrastructure at Kidston");
  const town = body.access.find((r: Body) => r.record_type === "nearest_town");
  assert.equal(town.name, "Georgetown");
  assert.ok(town.search_radius_km > 5);
  assert.ok(town.distance_km > 50);
  const big = body.access.find((r: Body) => r.record_type === "nearest_town_1000_plus");
  assert.ok(big.population >= 1000 && big.distance_km > town.distance_km);
  assert.equal(body.access.find((r: Body) => r.record_type === "nearest_power_line").name, "Kidston to Georgetown");
});

test("Kidston environment: authorities and abandoned-mines records, reused land-status rows, and the registers that could not be checked", async () => {
  const { body } = await ask(handler(), "environmental records at Kidston");
  assert.deepEqual(body.categories, ["environment"]);
  assert.ok(body.environment.length > 0);
  assert.ok(body.environment.every((r: Body) => r.category === "environment"));
  assert.ok(body.environment.some((r: Body) => r.record_type === "environmental_authority"));
  assert.ok(body.environment.some((r: Body) => r.record_type === "abandoned_mine_openings_count"));
  const reused = body.environment.filter((r: Body) => r.reused_from === "land_status");
  assert.ok(reused.every((r: Body) => r.record_type.startsWith("abandoned_mine")));
  assert.ok(body.not_found.some((n: string) => /contaminated-land and environmental-management registers: no keyless official spatial layer/.test(n)));
  const ea = body.environment.filter((r: Body) => r.record_type === "environmental_authority");
  assert.equal(new Set(ea.map((r: Body) => r.permit_ref_no)).size, ea.length, "one row per permit");
  assert.ok(ea.every((r: Body) => /^https:\/\/apps\.des\.qld\.gov\.au\//.test(r.register_link)));
});

test("Ravenswood (a site with modern activity): what might remain returns all four categories in one call", async () => {
  const calls: string[] = [];
  const { status, body } = await ask(handler({ calls }), "what might remain at site 481934");
  assert.equal(status, 200);
  assert.deepEqual(body.categories, ["exploration", "resources", "access", "environment"]);
  for (const c of body.categories) assert.ok(body[c].length > 0, c);
  assert.equal(body.tenure, undefined, "land is not added unless asked");
  assert.ok(body.resources.some((r: Body) => /Copper Knob|Sarsfield|Ravenswood/.test(r.deposit_name)));
  assert.ok(body.environment.some((r: Body) => r.holder === "RAVENSWOOD GOLD PTY LTD" && r.relation === "contains_site_point"));
  assert.equal(body.calls.this_response, 1);
  assert.equal(body.source_count, body.sources.length);
  assert.ok(body.sources.every((u: string) => /^https:\/\//.test(u)));
  assert.match(body.licences.geoscience_australia, /Creative Commons Attribution 4\.0/);
  assert.equal(body.labels.resources, RESOURCE_LABEL);
  assert.ok(calls.length > 10);
});

test("the everything question returns land and remaining-today together; the plain land question is unchanged", async () => {
  const { body } = await ask(handler(), "everything about Mount Morgan including what might remain today");
  assert.deepEqual(body.categories, ["tenure", "native_title", "land_status", "exploration", "resources", "access", "environment"]);
  for (const c of body.categories) assert.ok(body[c] !== undefined, c);
  assert.ok(body.tenure.some((r: Body) => r.tenure_id === "ML 5623"));
  assert.ok(body.access.length > 0);
  assert.ok(body.caveat.includes("expiry date"));
  assert.equal(body.remaining_caveat, REMAINING_CAVEAT);
  const land = await ask(handler(), "everything about land and rights at Mount Morgan");
  assert.deepEqual(land.body.categories, ["tenure", "native_title", "land_status"]);
  assert.equal(land.body.exploration, undefined);
});

test("fail closed: a source that errors or times out is listed under not_found with the reason, gives no rows, and is not cached", async () => {
  let down = true;
  const h = handler({ fail: (u) => (down && u.includes("services.ga.gov.au/gis/earthresource") ? "503" : down && u.includes("Town_Point") ? "timeout" : null) });
  const a = await ask(h, "what might remain at Mount Morgan");
  assert.equal(a.body.resources.length, 0);
  assert.ok(a.body.not_found.some((n: string) => /Geoscience Australia deposits not checked \(HTTP 503\)/.test(n)));
  assert.ok(a.body.not_found.some((n: string) => /Town Points.* not checked \(timed out/.test(n)));
  assert.ok(!a.body.access.some((r: Body) => r.record_type === "nearest_town"));
  assert.ok(a.body.access.some((r: Body) => r.record_type === "nearest_major_road"), "the other layers still answer");
  assert.ok(a.body.checks.some((c: Body) => c.error === "HTTP 503"));
  down = false;
  const b = await ask(h, "what might remain at Mount Morgan");
  assert.equal(b.body.resources.length, 1, "the failure was not cached");
  assert.ok(b.body.access.some((r: Body) => r.record_type === "nearest_town"));
});

test("a failed report index keeps the MINOCC CR numbers but gives no titles, and says so", async () => {
  const h = handler({ fail: (u) => (u.includes("ReportIndex") ? "500" : null) });
  const { body } = await ask(h, "exploration reports for Kidston");
  const cr = body.exploration.filter((r: Body) => r.record_type === "company_report");
  assert.equal(cr.length, 17);
  assert.ok(cr.every((r: Body) => r.title === null && r.source_ref === "GSQ-MINOCC"));
  assert.match(cr[0].report_page_url_basis, /built from the .*pattern.*not fetched/);
  assert.ok(body.not_found.some((n: string) => /titles and years not checked \(GSQ report index: HTTP 500\)/.test(n)));
});

test("answers are cached for 24 hours per site", async () => {
  const calls: string[] = [];
  const h = handler({ calls });
  await ask(h, "modern resources at Brilliant Lode");
  const n = calls.length;
  await ask(h, "modern resources at Brilliant Lode");
  assert.equal(calls.length, n);
});
