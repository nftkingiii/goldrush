import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createHandler } from "../src/app.ts";
import { buildMinocc, expandSite, parseProduction, readTable, sourceKey, yearOf, type Tables } from "../src/minocc.ts";
import { loadStore } from "../src/store.ts";

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const store = loadStore();
const h = createHandler(store);
const ask = (question: string) => h.ask(new URLSearchParams({ question })) as { status: number; body: Body };
const isMinocc = (x: Body) => String(x.source_ref).startsWith("MINOCC-2017:");
const minoccJson = JSON.parse(readFileSync(new URL("../data/minocc.json", import.meta.url), "utf8"));

const FIXTURE_SITES = [494270, 38730, 38722, 479629, 36049, 38776];
const fixtureTables = (): Tables => {
  const t = (name: string) => readTable(readFileSync(new URL(`./fixtures/minocc/${name}.csv`, import.meta.url), "utf8"));
  return {
    Production: t("Production"), MineHist: t("MineHist"), Tenure: t("Tenure"), Total_Ores_Prod: t("Total_Ores_Prod"), Total_Alluvial_Prod: t("Total_Alluvial_Prod"),
    Explorer: t("Explorer"), "Company reports": t("Company reports"), Location: t("Location"),
  };
};
const goldNames = () => new Map<number, string>(FIXTURE_SITES.map((n) => [n, store.sites.byNo.get(n)!.name]));

test("the builder reproduces data/minocc.json for the fixture sites from the raw MINOCC table rows", () => {
  const { sites } = buildMinocc(fixtureTables(), goldNames());
  for (const n of FIXTURE_SITES) assert.deepEqual(sites[n], minoccJson.sites[n], `site ${n}`);
});

test("the SITE_NO join: Mount Morgan 494270, Day Dawn 38730 and Brilliant 38722 are the same sites in the MINOCC Location table and in the GSQ index", () => {
  const { report } = buildMinocc(fixtureTables(), goldNames());
  assert.deepEqual(report.join.checks, { "38722": "BRILLIANT LODE", "38730": "DAY DAWN LODE", "494270": "MOUNT MORGAN" });
  assert.equal(report.join.missing.length, 0);
  assert.equal(minoccJson.join.in_location_table, 8130, "8,130 of the 8,132 indexed gold sites are in the MINOCC Location table");
  assert.deepEqual(minoccJson.join.missing, [517058, 610384]);
  for (const n of [494270, 38730, 38722]) assert.equal(store.sites.byNo.get(n)!.name.trim().toUpperCase(), (report.join.checks as Record<string, string | null>)[String(n)]);
});

test("Mount Morgan: MINOCC production is its own source record, in the unit recorded, with table and record in source_ref", () => {
  const { body } = ask("site 494270");
  const m = body.production.filter(isMinocc);
  const gold = m.find((p: Body) => p.commodity === "gold" && p.scope === "site_total");
  assert.equal(gold.amount, 294056);
  assert.equal(gold.unit, "kg", "recorded as KG, not converted in place");
  assert.equal(gold.source_ref, "MINOCC-2017:Total_Ores_Prod:494270");
  assert.equal(gold.source_table, "Total_Ores_Prod");
  assert.equal(gold.source_url, "https://geoscience.data.qld.gov.au/dataset/ds000004");
  assert.match(gold.quote, /294056 KG Au 36842 KG Ag 360616 T Cu/);
  assert.equal(gold.basis, "reported");
  assert.equal(gold.converted.unit, "troy oz");
  assert.equal(gold.converted.amount, Math.round(294056 * 1000 / 31.1034768), "the conversion is separate, labelled and explicit");
  assert.match(gold.converted.basis, /explicit conversion/);
  const cu = m.find((p: Body) => p.commodity === "copper" && p.scope === "site_total");
  assert.deepEqual([cu.amount, cu.unit], [360616, "t"]);
  assert.equal(cu.converted, undefined, "only gold gets an ounce reading");
  // The dated rows are the same gold, in the same unit, and add up to the total: nothing was invented.
  const rows = m.filter((p: Body) => p.commodity === "gold" && p.scope === "period");
  assert.deepEqual(rows.map((p: Body) => [p.amount, p.period_from, p.period_to]), [[1835, null, null], [157273, null, 1927], [78788, 1929, 1982], [56160, 1983, 1990]]);
  assert.equal(rows.reduce((a: number, p: Body) => a + p.amount, 0), 294056);
  assert.deepEqual(rows.map((p: Body) => p.source_ref.split(":").at(-1)), ["1", "2", "3", "4"]);
});

test("Mount Morgan: totals from MINOCC, the Queensland Government and Wikipedia are all kept and listed as a conflict, in their own units", () => {
  const { body } = ask("site 494270");
  const c = body.conflicts.find((x: Body) => x.field.startsWith("production gold, whole-site"));
  assert.ok(c, "cross-source gold conflict listed");
  assert.deepEqual(c.values.map((v: Body) => [v.value, v.source_ref]), [["250 t", "QLDGOV-MM"], ["262 t", "WP-MM"], ["294056 kg", "MINOCC-2017:Total_Ores_Prod:494270"]]);
  assert.deepEqual(c.values.map((v: Body) => v.as_tonnes), [250, 262, 294.056]);
  assert.match(c.comparison_basis, /converted for the comparison only/);
  const cu = body.conflicts.find((x: Body) => x.field.startsWith("production copper, whole-site"));
  assert.equal(cu.values.length, 3);
  const closure = body.conflicts.find((x: Body) => x.field.startsWith("closure year, whole site"));
  assert.deepEqual(closure.values.map((v: Body) => [v.value, v.source_ref]), [[1990, "QLDGOV-MM"], [1981, "WP-MM"], [1990, "MINOCC-2017:MineHist:494270:6"]]);
  assert.match(body.answer, /none is merged or chosen/);
  assert.ok(body.brief.length <= 80);
});

test("Mount Morgan: the answer text states the MINOCC facts and the other sources' facts in plain words with sources", () => {
  const { body } = ask("site 494270");
  assert.match(body.answer, /294,056 kg gold, about 9\.45 Moz troy \(converted here; the survey records 294,056 kg\).*per GSQ MINOCC 2017 \(Total_Ores_Prod, SITE_NO 494270\)/);
  assert.match(body.answer, /about 250 tonnes gold.*per Queensland Government/);
  assert.match(body.answer, /262 tonnes gold.*per Wikipedia/);
  assert.match(body.answer, /Years worked per GSQ MINOCC 2017 \(MineHist, SITE_NO 494270\): 1882-1903/);
  assert.match(body.answer, /Norton Gold Fields Limited per GSQ MINOCC 2017 \(Tenure, SITE_NO 494270\)/);
});

test("Mount Morgan: MINOCC years worked, closure year and owner are separate records; the closure reason stays unknown", () => {
  const { body } = ask("site 494270");
  const worked = body.years_worked[0];
  assert.deepEqual(worked.periods.map((p: Body) => [p.start_year, p.end_year]), [[1882, 1903], [1903, null], [1925, 1927], [1929, 1968], [1968, 1981], [1981, 1990], [1882, null]]);
  assert.match(worked.periods[2].comment, /closed in 1927/, "the survey's own comment is carried verbatim, not turned into a class");
  const closure = body.closure.filter(isMinocc);
  assert.equal(closure.length, 1);
  assert.deepEqual([closure[0].year, closure[0].reason_text, closure[0].reason_class], [1990, null, "unknown"]);
  assert.match(closure[0].basis_note, /latest End Year/);
  const owner = body.ownership.find(isMinocc);
  assert.equal(owner.owner, "Norton Gold Fields Limited");
  assert.equal(owner.tenures.length, 17);
  assert.equal(owner.period_from, null, "MINOCC gives no dates for tenure holders, none are invented");
  const curated = body.ownership.filter((o: Body) => !isMinocc(o));
  assert.ok(curated.length >= 7, "the curated and GA owners are still there, unmerged");
});

test("Day Dawn lode: MINOCC adds the lode total in kg beside the per-mine Heritage Register figures, which it does not replace or merge", () => {
  const { body } = ask("What did the Day Dawn lode at Charters Towers produce and when did it close?");
  assert.equal(body.site_no, 38730);
  const m = body.production.filter(isMinocc);
  const gold = m.filter((p: Body) => p.commodity === "gold");
  assert.deepEqual(gold.map((p: Body) => [p.amount, p.unit, p.scope, p.period_to]), [[38668, "kg", "site_total", 1919], [38668, "kg", "period", 1919]]);
  assert.equal(m.find((p: Body) => p.commodity === "ore").amount, 1590880);
  assert.equal(body.production.filter((p: Body) => p.commodity === "gold" && !isMinocc(p)).length, 3);
  assert.deepEqual(body.years_worked[0].periods.map((p: Body) => [p.start_year, p.end_year]), [[1873, 1919], [1931, 1936], [1939, 1940]]);
  assert.equal(body.closure.filter(isMinocc)[0].year, 1940);
  assert.equal(body.ownership.find(isMinocc).owner, "Citigold Corporation Limited");
  assert.deepEqual(body.references[0].cr_numbers, [7342, 16730, 32042, 32872, 34255]);
  assert.deepEqual(body.conflicts.map((c: Body) => c.field), ["production ore (Day Dawn P.C. (on the Day Dawn lode))"], "a lode total and a single mine's figure are different things, not a conflict");
});

test("Brilliant lode: MINOCC total in kg, years worked and holder", () => {
  const { body } = ask("site 38722");
  const gold = body.production.find((p: Body) => isMinocc(p) && p.commodity === "gold" && p.scope === "site_total");
  assert.deepEqual([gold.amount, gold.unit], [51482.73, "kg"]);
  assert.deepEqual(body.years_worked[0].periods.map((p: Body) => [p.start_year, p.end_year]), [[1879, 1917]]);
  assert.equal(body.closure.find(isMinocc).year, 1917);
  assert.equal(body.ownership.find(isMinocc).owner, "Citigold Corporation Limited");
});

test("a site only MINOCC covers (Kidston): production, years worked, owner and report numbers all come from MINOCC and carry their record", () => {
  const { status, body } = ask("site 479629");
  assert.equal(status, 200);
  assert.equal(body.site_no, 479629);
  assert.ok(body.production.length > 5);
  assert.ok([...body.production, ...body.closure, ...body.ownership, ...body.years_worked, ...body.references].every(isMinocc), "no curated source for this site");
  const gold = body.production.find((p: Body) => p.commodity === "gold" && p.scope === "site_total");
  assert.deepEqual([gold.amount, gold.unit, gold.period_from, gold.period_to], [113804.5, "kg", 1915, 2002]);
  assert.deepEqual(body.production.filter((p: Body) => p.commodity === "gold" && p.scope === "period").map((p: Body) => [p.amount, p.period_from, p.period_to]), [[1309, 1915, 1924], [66333, 1985, 1994], [30589, 1994, 1999], [14865.4, 1999, 2001], [708.1, 2001, 2002]]);
  assert.equal(body.ownership[0].owner, "Kidston Gold Mines Limited");
  assert.equal(body.closure[0].year, 2001);
  assert.equal(body.closure[0].reason_class, "unknown");
  assert.deepEqual(body.conflicts, [], "one source, nothing to disagree with");
  assert.ok(body.sources.includes("https://geoscience.data.qld.gov.au/dataset/ds000004"));
  assert.match(body.not_found.join(" "), /closure reason: the indexed sources give a closure year but quote no reason/);
  assert.equal(body.not_found.length, 1);
});

test("a site with no MINOCC production still gets not_found for production, with the ownership and report numbers MINOCC does hold", () => {
  const { status, body } = ask("site 36049");
  assert.equal(status, 200);
  assert.deepEqual(body.production, []);
  assert.match(body.not_found[0], /^production: no reported production figure/);
  assert.match(body.not_found[1], /^closure: no closure year/);
  assert.equal(body.not_found.length, 2);
  assert.deepEqual(body.ownership.map((o: Body) => o.owner), ["Territory Minerals Ltd", "North Queensland Resources Nl", "Dulcet Pty Ltd"]);
  assert.deepEqual(body.ownership.slice(1).map((o: Body) => [o.period_from, o.period_to]), [[1988, 1988], [1984, 1988]]);
  assert.deepEqual(body.references[0].cr_numbers, [14450, 15701, 17886, 19075]);
  assert.match(body.answer, /Not found: production/);
});

test("MINOCC never states a closure cause: every MINOCC closure record has reason_class unknown and no reason_text", () => {
  let n = 0;
  for (const records of store.records.values()) {
    for (const r of records) {
      if (r.kind !== "closure" || !r.source_ref.startsWith("MINOCC-2017:")) continue;
      n++;
      assert.equal(r.reason_class, "unknown");
      assert.equal(r.reason_text, null);
      assert.ok(Number.isInteger(r.year));
    }
  }
  assert.ok(n > 2000);
});

test("every MINOCC record has a source key that resolves, a quote, a table and a record id, and units are only kg, t or oz", () => {
  let n = 0;
  for (const records of store.records.values()) {
    for (const r of records) {
      if (!r.source_ref.startsWith("MINOCC-2017:")) continue;
      n++;
      assert.ok(store.sources[sourceKey(r.source_ref)]);
      assert.ok(r.quote.length > 5);
      const [, table, site] = r.source_ref.split(":");
      assert.ok(["Production", "Total_Ores_Prod", "Total_Alluvial_Prod", "MineHist", "Tenure", "Explorer", "Company reports"].includes(table!), r.source_ref);
      assert.equal(Number(site), r.site_no);
      if (r.kind === "production") {
        assert.ok(["kg", "t"].includes(r.unit));
        assert.ok(r.amount > 0 || r.amount === 0);
        for (const y of [r.period_from, r.period_to]) assert.ok(y === null || (Number.isInteger(y) && y > 1800 && y < 2100));
      }
    }
  }
  assert.ok(n > 15000);
  const src = store.sources["MINOCC-2017"]!;
  assert.match(src.licence, /CC BY 4\.0/);
  assert.equal(src.url, "https://geoscience.data.qld.gov.au/dataset/ds000004");
  assert.match(src.title, /MINOCC 2017/);
});

test("coverage: the numbers stored in minocc.json match what the loaded records show", () => {
  const withKind = (kind: string, pred: (r: any) => boolean = () => true) => // eslint-disable-line @typescript-eslint/no-explicit-any
    [...store.records.values()].filter((rs) => rs.some((r) => r.source_ref.startsWith("MINOCC-2017:") && r.kind === kind && pred(r))).length;
  const c = minoccJson.coverage;
  assert.equal(withKind("production", (r) => r.commodity === "gold" && r.scope === "site_total"), c.with_gold_total);
  assert.equal(withKind("production", (r) => r.scope === "site_total"), c.with_total_production);
  assert.equal(withKind("years_worked", (r) => r.periods.some((p: any) => p.start_year !== null || p.end_year !== null)), c.with_years_worked); // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(withKind("reference"), c.with_cr_numbers);
  assert.equal(withKind("ownership"), c.with_owner_or_holder);
  assert.ok(c.with_gold_total > 2000 && c.with_years_worked > 2000 && c.with_owner_or_holder > 1500);
  assert.equal(store.minocc.coverage.with_gold_total, c.with_gold_total);
});

test("the structured fields are top-level keys; site_no, not site_id; production periods are integer years", () => {
  const { body } = ask("site 494270");
  for (const k of ["answer", "sources", "source_count", "brief", "site_no", "site_name", "production", "closure", "ownership", "not_found"]) assert.ok(k in body, k);
  assert.equal("site_id" in body, false);
  for (const p of body.production) for (const y of [p.period_from, p.period_to]) assert.ok(y === null || Number.isInteger(y), `${p.source_ref} ${y}`);
  for (const x of [...body.production]) assert.ok(["reported", "estimated"].includes(x.basis));
  const price = ask("gold price in March 1980").body;
  assert.match(price.gold_price[0].month, /^\d{4}-\d{2}$/);
  const amb = ask("Silver Queen gold mine");
  assert.ok(amb.body.candidates.every((c: Body) => "site_no" in c && !("site_id" in c)));
});

test("parseProduction reads figures as recorded, attaches grades, and flags text with no figure", () => {
  assert.deepEqual(parseProduction("157273 KG GOLD BULLION   116175 T COPPER MATTE        ").items.map((i) => [i.amount, i.unit, i.commodity, i.form]), [[157273, "kg", "gold", "bullion"], [116175, "t", "copper", "matte"]]);
  assert.deepEqual(parseProduction("56160 KG GOLD BULLION 1.08 G/T").items.map((i) => [i.amount, i.grade]), [[56160, "1.08 G/T"]]);
  assert.deepEqual(parseProduction("GOLD BULLION 4.71 KG").items.map((i) => [i.amount, i.unit, i.commodity]), [[4.71, "kg", "gold"]]);
  assert.deepEqual(parseProduction("30 T STEATITE (TALC) ORE").items.map((i) => [i.amount, i.commodity]), [[30, "steatite"]]);
  const grade = parseProduction("GOLD BULLION 5.58 G/T");
  assert.deepEqual([grade.items.length, grade.unparsed], [0, true], "a grade with no amount is not a production figure");
  assert.deepEqual(parseProduction("").items, []);
});

test("yearOf keeps real years and treats the unknown-date marker as no year", () => {
  assert.equal(yearOf("1927-12-31"), 1927);
  assert.equal(yearOf("1996-07-01"), 1996);
  assert.equal(yearOf("1900-01-00"), null);
  assert.equal(yearOf(""), null);
  assert.equal(yearOf("12/31/27"), null);
});

test("expandSite is deterministic and does not touch the recorded amounts", () => {
  const d = minoccJson.sites["494270"];
  const a = expandSite(494270, d);
  assert.deepEqual(a, expandSite(494270, d));
  assert.ok((a as Body[]).filter((r) => r.kind === "production").every((r) => r.unit === "kg" || r.unit === "t"));
});
