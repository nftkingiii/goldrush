// Local helper: node scripts/ask.ts "question"  (prints the miner's answer without starting a server)
import { createHandler } from "../src/app.ts";
import { loadStore } from "../src/store.ts";

const h = createHandler(loadStore());
const q = new URLSearchParams({ question: process.argv[2] ?? "" });
const r = h.ask(q);
console.log(r.status, JSON.stringify(r.body, null, 2));
