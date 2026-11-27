import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createHandler } from "./app.ts";
import { createLimiter } from "./ratelimit.ts";
import { loadStore } from "./store.ts";

const store = loadStore();
const handle = createHandler(store);

/** Telegraph nodes fetch the YAMLs and check them against the hashes registered on-chain. */
const yamls: Record<string, Buffer> = {
  "/goldrush-qld-history.yaml": readFileSync(new URL("../miners/goldrush-qld-history.yaml", import.meta.url)),
  "/goldrush-gold-price.yaml": readFileSync(new URL("../miners/goldrush-gold-price.yaml", import.meta.url)),
};

const allowed = createLimiter(30);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://goldrush");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "GET") return send(405, { error: "method_not_allowed" });
  if (url.pathname === "/") {
    return send(200, {
      name: "Gold Rush",
      about: "Queensland historical gold mines from official records, served to Telegraph as miner 7310050 (RESEARCH_QUERY_GENERAL).",
      endpoints: {
        "/ask?question=...": "mine history: production, closure, ownership, later exploration, what might remain",
        "/price?date=YYYY-MM-DD": "monthly gold price series",
        "/health": "status",
        "/goldrush-qld-history.yaml": "registered miner definition",
      },
      example: "/ask?question=How%20much%20gold%20did%20Mount%20Morgan%20produce%3F",
      source: "https://github.com/nftkingiii/goldrush",
    });
  }
  if (url.pathname === "/health") {
    return send(200, { status: "ok", index_built: store.built, minocc_fetched: store.datasets.minocc!.fetched, gold_series: [store.gold.first, store.gold.last] });
  }
  const yaml = yamls[url.pathname];
  if (yaml) {
    res.writeHead(200, { "content-type": "application/yaml" });
    return res.end(yaml);
  }
  if (url.pathname !== "/ask" && url.pathname !== "/price") return send(404, { error: "not_found" });

  const forwarded = req.headers["x-real-ip"];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? req.socket.remoteAddress ?? "unknown";
  if (!allowed(ip)) return send(429, { error: "rate_limited" });

  const t0 = Date.now();
  // One line per request so scorer probes can be read back from the logs: route, the question asked, status,
  // whether anything was found, and time taken. No caller address is logged.
  const logReq = (status: number, body: any) =>
    console.log(
      "req " +
        JSON.stringify({
          ts: new Date(t0).toISOString(),
          route: url.pathname,
          q: Object.fromEntries([...url.searchParams].map(([k, v]) => [k, v.slice(0, 200)])),
          status,
          matched: body?.matched ?? body?.mine?.name ?? body?.site_no ?? null,
          not_found: Array.isArray(body?.not_found) ? body.not_found.length : undefined,
          error: body?.error,
          ms: Date.now() - t0,
        }),
    );
  try {
    const { status, body } = url.pathname === "/ask" ? await handle.askAsync(url.searchParams) : handle.price(url.searchParams);
    logReq(status, body);
    send(status, body);
  } catch (e) {
    console.error("ask failed", (e as Error).message);
    logReq(500, { error: "internal_error" });
    send(500, { error: "internal_error" });
  }
});

server.listen(Number(process.env.PORT ?? 8080), () => console.log("goldrush listening"));
