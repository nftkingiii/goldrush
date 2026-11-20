import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createLimiter } from "../src/ratelimit.ts";
import { fetchGsqSite, gaDepositUrl, gsqSiteUrl, parseGa, parseGsq, parsePinkSheetGold, parseRbaUsd } from "../src/sources.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const json = (name: string) => JSON.parse(fixture(name).toString("utf8"));
const data = (name: string) => readFileSync(new URL(`../data/raw/${name}`, import.meta.url), "utf8");

test("reads a recorded GSQ MINOCC response for Mount Morgan", () => {
  const [site] = parseGsq(json("gsq-site-494270.json"));
  assert.equal(site!.site_no, 494270);
  assert.equal(site!.occur_name, "MOUNT MORGAN");
  assert.equal(site!.main_occur_size, "GIANT");
  assert.equal(site!.mine_status, "ABANDONED MINE");
  assert.equal(site!.latitude, -23.637039);
});

test("reads a recorded GSQ response for a Charters Towers lode", () => {
  const [site] = parseGsq(json("gsq-site-38730.json"));
  assert.equal(site!.occur_name, "DAY DAWN LODE");
  assert.equal(site!.sheet_100_name, "CHARTERS TOWERS");
});

test("fetchGsqSite sends an honest user agent and fails closed on an error status", async () => {
  let agent = "";
  let asked = "";
  const ok: typeof fetch = async (url, init) => {
    asked = String(url);
    agent = String((init?.headers as Record<string, string>)["user-agent"]);
    return new Response(fixture("gsq-site-494270.json"), { status: 200 });
  };
  const site = await fetchGsqSite(ok, 494270);
  assert.equal(site?.occur_name, "MOUNT MORGAN");
  assert.equal(asked, gsqSiteUrl(494270));
  assert.match(agent, /^goldrush-miner\//);
  await assert.rejects(fetchGsqSite(async () => new Response("no", { status: 503 }), 1), /503/);
  await assert.rejects(fetchGsqSite(async () => new Response(JSON.stringify({ error: { code: 400 } })), 1), /no features/);
});

test("refuses a GSQ feature with no coordinates", () => {
  assert.throws(() => parseGsq({ features: [{ attributes: { site_no: 1, occur_name: "X" } }] }), /no coordinates/);
});

test("reads a recorded Geoscience Australia deposit", () => {
  const [d] = parseGa(json("ga-deposit-333486.json"));
  assert.equal(d!.name, "Mount Morgan");
  assert.equal(d!.status, "historic mine");
  assert.equal(d!.companies, "Heritage Minerals Pty Ltd");
  assert.match(gaDepositUrl(333486), /cql_filter=ENO%3D333486/);
});

test("reads gold from the recorded World Bank Pink Sheet workbook", () => {
  const gold = parsePinkSheetGold(fixture("pink-sheet-2026-11.xlsx"));
  assert.equal(gold.length, 802);
  assert.deepEqual(gold[0], { month: "1960-01", usd: 35 });
  assert.deepEqual(gold.find((g) => g.month === "1980-03"), { month: "1980-03", usd: 554 });
  assert.equal(gold.at(-1)!.month, "2026-10");
});

test("refuses a workbook without a gold column", () => {
  assert.throws(() => parsePinkSheetGold(Buffer.from("not a zip")), /not a zip/);
});

test("reads the RBA month-end AUD/USD in both stored forms", () => {
  const old = parseRbaUsd(data("rba-f11hist-1969-2009.usd.txt"));
  const recent = parseRbaUsd(data("rba-f11-2010-2026.usd.txt"));
  assert.deepEqual(old.find((r) => r.month === "1980-03"), { month: "1980-03", date: "1980-03-31", usdPerAud: 1.0831 });
  assert.equal(old.at(-1)!.month, "2009-12");
  assert.equal(recent[0]!.month, "2010-01");
  assert.equal(recent.at(-1)!.month, "2026-10");
  assert.equal(new Set([...old, ...recent].map((r) => r.month)).size, old.length + recent.length, "no month appears twice");
});

test("per-IP limiter refuses the call after the limit and resets after the window", () => {
  let t = 0;
  const allowed = createLimiter(2, 1000, () => t);
  assert.equal(allowed("1.1.1.1"), true);
  assert.equal(allowed("1.1.1.1"), true);
  assert.equal(allowed("1.1.1.1"), false);
  assert.equal(allowed("2.2.2.2"), true);
  t = 1500;
  assert.equal(allowed("1.1.1.1"), true);
});
