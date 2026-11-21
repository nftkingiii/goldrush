import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandler } from "../src/app.ts";
import { loadStore } from "../src/store.ts";

const store = loadStore();
const h = createHandler(store);
const ask = (question: string) => h.ask(new URLSearchParams({ question }));
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const APP_QUESTION = "Tell me about the Mount Morgan gold mine, Queensland: who owned it, how much gold it produced, and when and why it closed.";

test("Mount Morgan: answers the app's own question with GSQ id, production, closure, owners, each sourced", () => {
  const { status, body } = ask(APP_QUESTION) as { status: number; body: Body };
  assert.equal(status, 200);
  assert.equal(body.site_no, 494270);
  assert.equal(body.site_name, "Mount Morgan");
  assert.equal(body.gsq_record.size_band, "GIANT");
  assert.ok(body.production.length >= 3);
  for (const p of [...body.production, ...body.closure, ...body.ownership]) {
    assert.ok(p.source_ref, "source_ref");
    assert.match(p.source_url, /^https:\/\//);
    assert.ok(p.quote);
  }
  assert.equal(body.source_count, body.sources.length);
  assert.ok(body.brief.length <= 80, `brief is ${body.brief.length} characters`);
  assert.equal(body.other_sites_with_same_name[0].site_no, 479252, "the Croydon site of the same name is disclosed, not silently picked");
});

test("Mount Morgan: conflicting sources are both kept, in production and in closure, and not merged", () => {
  const { body } = ask("site 494270") as { body: Body };
  const curated = (p: Body) => !String(p.source_ref).startsWith("MINOCC");
  const gold = body.production.filter((p: Body) => p.commodity === "gold" && curated(p)).map((p: Body) => [p.amount, p.unit, p.source_ref]);
  assert.deepEqual(gold, [[250, "t", "QLDGOV-MM"], [262, "t", "WP-MM"]]);
  const years = body.closure.filter((c: Body) => c.entity === "Mount Morgan mine").map((c: Body) => [c.year, c.reason_class]); // MINOCC's entity is "Mount Morgan", a separate record
  assert.deepEqual(years, [[1990, "unknown"], [1981, "exhausted"]]);
  const fields = body.conflicts.map((c: Body) => c.field);
  assert.ok(fields.includes("production gold (Mount Morgan mine)"));
  assert.ok(fields.includes("closure year (Mount Morgan mine)"));
  assert.match(body.answer, /none is merged or chosen/);
});

test("Mount Morgan: a closure year the source gives without a reason stays unknown, never guessed", () => {
  const { body } = ask("site 494270") as { body: Body };
  const noReason = body.closure.find((c: Body) => c.source_ref === "QLDGOV-MM");
  assert.equal(noReason.reason_text, null);
  assert.equal(noReason.reason_class, "unknown");
});

test("Mount Morgan: current company comes from Geoscience Australia with its own source", () => {
  const { body } = ask("site 494270") as { body: Body };
  const ga = body.ownership.find((o: Body) => String(o.source_ref).startsWith("GA-"));
  assert.equal(ga.owner, "Heritage Minerals Pty Ltd");
  assert.match(ga.source_url, /services\.ga\.gov\.au/);
});

test("Charters Towers lode: Day Dawn lode keeps each mine's figure separately and flags the in-source tonnage mismatch", () => {
  const { status, body } = ask("What did the Day Dawn lode at Charters Towers produce and when did it close?") as { status: number; body: Body };
  assert.equal(status, 200);
  assert.equal(body.site_no, 38730);
  const gold = body.production.filter((p: Body) => p.commodity === "gold" && !String(p.source_ref).startsWith("MINOCC")).map((p: Body) => [p.entity.split(" (")[0], p.amount, p.unit]);
  assert.deepEqual(gold, [["Day Dawn P.C.", 379859, "oz"], ["Day Dawn P.C.", 120722, "oz"], ["Day Dawn Block and Wyndham", 546531, "oz"]]);
  assert.deepEqual(body.production.filter((p: Body) => p.commodity === "ore" && !String(p.source_ref).startsWith("MINOCC")).map((p: Body) => p.amount), [279543, 76334]);
  assert.deepEqual(body.conflicts.map((c: Body) => c.field), ["production ore (Day Dawn P.C. (on the Day Dawn lode))"]);
  assert.equal(body.closure[0].year, 1913);
  assert.equal(body.closure[0].reason_class, "unknown");
  assert.match(body.closure[0].reason_text, /returns grew less/);
  assert.ok(body.closure.length >= 2 && body.closure.at(-1).source_ref.startsWith("MINOCC"), "MINOCC adds its own closure record after the curated one");
});

test("Charters Towers lode: Brilliant lode answers from its own records", () => {
  const { body } = ask("Brilliant Lode Charters Towers") as { body: Body };
  assert.equal(body.site_no, 38722);
  assert.equal(body.production[0].amount, 22843);
  assert.equal(body.closure[0].year, 1917);
});

test("a site that no source covers reports not_found for all three and invents nothing", () => {
  const { status, body } = ask("site 610384") as { status: number; body: Body };
  assert.equal(status, 200);
  assert.equal(body.site_no, 610384);
  assert.deepEqual([body.production, body.closure, body.ownership], [[], [], []]);
  assert.equal(body.not_found.length, 3);
  assert.match(body.not_found[0], /^production/);
  assert.match(body.answer, /Not found/);
});

test("an unknown site gets 422 with closest real names, not an invented answer", () => {
  const { status, body } = ask("Tell me about the Atlantis Reef gold mine") as { status: number; body: Body };
  assert.equal(status, 422);
  assert.equal(body.error, "no_matching_site");
  assert.ok(Array.isArray(body.closest_names));
  const near = ask("Tell me about the Brilliant Dawn gold mine at Charters Towers") as { status: number; body: Body };
  assert.equal(near.status, 422, "a Brilliant on another sheet is not answered as a Charters Towers one");
});

test("a name that exists only on another map sheet than the one asked about is not answered as if it matched", () => {
  const { status, body } = ask("Tell me about the Xanadu Lode at Charters Towers") as { status: number; body: Body };
  assert.equal(status, 422);
  assert.equal(body.error, "site_not_in_named_area");
  assert.deepEqual(body.asked_areas, ["CHARTERS TOWERS"]);
  assert.equal(body.candidates[0].site_no, 504677);
});

test("a site name plus the map sheet it is on picks the site on that sheet and discloses the others", () => {
  const { status, body } = ask("Tell me about the Sunburst gold mine near Gympie") as { status: number; body: Body };
  assert.equal(status, 200);
  assert.equal(body.site_no, 40216);
  assert.equal(body.gsq_record.map_sheet_100k, "GYMPIE");
  assert.ok(body.other_sites_with_same_name.length >= 1);
});

test("an unknown site id gets 422", () => {
  assert.equal(ask("site 999999").status, 422);
});

test("two sites with the same name and size are not guessed between", () => {
  const { status, body } = ask("Silver Queen gold mine") as { status: number; body: Body };
  assert.equal(status, 422);
  assert.equal(body.error, "ambiguous_site");
  assert.deepEqual(body.candidates.map((c: Body) => c.site_no).sort(), [36745, 481748]);
});

test("gold price for one month, in USD and AUD, with series and source", () => {
  const { status, body } = ask("What was the price of gold in March 1980 in USD and AUD?") as { status: number; body: Body };
  assert.equal(status, 200);
  assert.equal(body.gold_price.length, 1);
  const row = body.gold_price[0];
  assert.equal(row.month, "1980-03");
  assert.equal(row.usd_per_oz, 554);
  assert.equal(row.aud_per_oz, Math.round((554 / row.fx_usd_per_aud) * 100) / 100);
  assert.match(row.series, /World Bank/);
  assert.match(row.source_url, /worldbank\.org/);
  assert.match(row.aud_basis, /^derived:/);
});

test("gold price for a year range returns every month in order", () => {
  const { status, body } = h.price(new URLSearchParams({ question: "gold price from 1975 to 1977" })) as { status: number; body: Body };
  assert.equal(status, 200);
  assert.equal(body.gold_price.length, 36);
  assert.equal(body.gold_price[0].month, "1975-01");
  assert.equal(body.gold_price.at(-1).month, "1977-12");
  assert.deepEqual(body.not_found, []);
});

test("gold price for two named months is an inclusive range", () => {
  const { body } = ask("gold price between January 2010 and March 2010") as { body: Body };
  assert.deepEqual(body.gold_price.map((r: Body) => r.month), ["2010-01", "2010-02", "2010-03"]);
});

test("gold price before the open series starts is not_found, not filled in", () => {
  const { status, body } = ask("gold price in March 1903") as { status: number; body: Body };
  assert.equal(status, 200);
  assert.deepEqual(body.gold_price, []);
  assert.match(body.not_found[0], /covers 1960-01/);
});

test("a range that starts before 1960 returns the covered months and lists the rest", () => {
  const { body } = ask("gold price from 1958 to 1960") as { body: Body };
  assert.equal(body.gold_price.length, 12);
  assert.match(body.not_found[0], /1958-01 to 1959-12 \(24 months\)/);
});

test("months with no RBA exchange rate keep USD and say the AUD is missing", () => {
  const { body } = ask("gold price in June 1965") as { body: Body };
  assert.equal(body.gold_price[0].aud_per_oz, null);
  assert.ok(body.gold_price[0].usd_per_oz > 0);
  assert.match(body.not_found[0], /aud_per_oz for 1965-06/);
});

test("malformed asks are refused with a reason", () => {
  const cases: [string, string, number][] = [
    ["", "question_required", 400],
    ["   ", "question_required", 400],
    ["x".repeat(600), "question_too_long", 400],
    ["gold price in March\u0007 1980", "question_has_control_characters", 400],
    ["what is the price of gold", "no_period", 422],
    ["gold price in March 1980 and 1985", "ambiguous_period", 422],
    ["gold price from 1980 to 1975", "period_end_before_start", 422],
    ["gold price from 1900 to 2026", "period_too_long", 422],
    ["gold price in 13/1980", "month_out_of_range", 422],
    ["gold price in 2040", "period_in_the_future", 422],
  ];
  for (const [q, error, status] of cases) {
    const r = ask(q) as { status: number; body: Body };
    assert.equal(r.body.error, error, q.slice(0, 40));
    assert.equal(r.status, status, q.slice(0, 40));
  }
  const silver = h.price(new URLSearchParams({ question: "silver price in March 1980" }));
  assert.equal(silver.body.error, "unsupported_commodity");
  assert.equal(h.price(new URLSearchParams({ question: "how are you in March 1980" })).body.error, "not_a_gold_price_question");
  assert.equal(h.price(new URLSearchParams()).status, 400);
});

test("every figure in an answer comes from a cited record: no number appears in production that the records do not hold", () => {
  const ev = JSON.parse(JSON.stringify([...store.records.values()].flat()));
  const held = new Set(ev.filter((r: Body) => r.kind === "production").map((r: Body) => `${r.site_no}|${r.commodity}|${r.amount}`));
  for (const siteNo of [494270, 38730, 38722, 38776]) {
    const { body } = ask(`site ${siteNo}`) as { body: Body };
    for (const p of body.production) assert.ok(held.has(`${siteNo}|${p.commodity}|${p.amount}`), `${siteNo} ${p.commodity} ${p.amount}`);
  }
});
