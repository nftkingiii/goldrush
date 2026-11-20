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

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://goldrush");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "GET") return send(405, { error: "method_not_allowed" });
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

  const { status, body } = url.pathname === "/ask" ? handle.ask(url.searchParams) : handle.price(url.searchParams);
  send(status, body);
});

server.listen(Number(process.env.PORT ?? 8080), () => console.log("goldrush listening"));
