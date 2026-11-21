export function normalizeName(s: string): string {
  return s
    .toUpperCase()
    .replace(/['’`]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/** Words that appear in questions or in many site names; a name made only of these never identifies a site. */
const GENERIC = new Set([
  "GOLD", "MINE", "MINES", "LODE", "REEF", "CREEK", "HILL", "QUEENSLAND", "QLD", "THE", "ABOUT", "TELL", "ME", "WHO", "OWNED", "HOW",
  "MUCH", "PRODUCED", "WHEN", "WHY", "CLOSED", "AND", "OF", "IN", "AT", "NEAR", "HISTORICAL", "OLD", "NEW", "NORTH", "SOUTH", "EAST",
  "WEST", "LEAD", "FIELD", "GOLDFIELD", "WORKINGS", "SHAFT", "PROSPECT", "CLAIM", "ALLUVIAL", "TOWN", "MOUNT", "MOUNTAIN",
  "PRICE", "OUNCE", "PRODUCTION", "CLOSURE", "OWNER", "OWNERSHIP", "DID", "WHAT", "WAS", "WERE", "IS", "ARE", "YEAR", "UNNAMED",
]);

export interface Site {
  site_no: number;
  name: string;
  norm: string;
  locality: string | null;
  sheet: string | null;
  lat: number;
  lon: number;
  accuracy_m: number | null;
  mine_status: string | null;
  exposure: string | null;
  group: string | null;
  size: string | null;
  size_def: string | null;
  commodities: string | null;
  date_current: string | null;
  ga_eno: number | null;
}

const SIZE_RANK: Record<string, number> = { GIANT: 5, LARGE: 4, MEDIUM: 3, SMALL: 2, "VERY SMALL": 1 };

export function sizeRank(site: Site): number {
  return SIZE_RANK[(site.size ?? "").toUpperCase()] ?? 0;
}

export interface SiteIndex {
  byNo: Map<number, Site>;
  byName: Map<string, Site[]>;
  maxWords: number;
  sheets: Set<string>;
}

export function buildSiteIndex(sites: Site[]): SiteIndex {
  const byNo = new Map<number, Site>();
  const byName = new Map<string, Site[]>();
  let maxWords = 1;
  const sheets = new Set<string>();
  for (const s of sites) {
    if (s.sheet) sheets.add(normalizeName(s.sheet));
    byNo.set(s.site_no, s);
    const list = byName.get(s.norm);
    if (list) list.push(s);
    else byName.set(s.norm, [s]);
    maxWords = Math.max(maxWords, s.norm.split(" ").length);
  }
  return { byNo, byName, maxWords: Math.min(maxWords, 8), sheets };
}

export type Resolution =
  | { kind: "found"; site: Site; others: Site[]; matchedBy: "site_no" | "name" }
  | { kind: "ambiguous"; candidates: Site[] }
  | { kind: "elsewhere"; candidates: Site[]; asked: string[] }
  | { kind: "none"; closest: string[] };

const ID_PATTERN = /\b(?:site(?:\s*(?:no\.?|number|id))?|gsq(?:\s*(?:site|id|no\.?))?|minocc)\s*#?:?\s*(\d{3,7})\b/i;

export function resolveSite(question: string, index: SiteIndex): Resolution {
  const idMatch = question.match(ID_PATTERN);
  if (idMatch) {
    const site = index.byNo.get(Number(idMatch[1]));
    if (site) return { kind: "found", site, others: [], matchedBy: "site_no" };
    return { kind: "none", closest: [] };
  }

  const words = normalizeName(question).split(" ").filter(Boolean);
  let best: { norm: string; sites: Site[] } | null = null;
  for (let n = Math.min(index.maxWords, words.length); n >= 1 && !best; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const gram = words.slice(i, i + n).join(" ");
      const sites = index.byName.get(gram);
      if (!sites) continue;
      const parts = gram.split(" ");
      if (parts.every((w) => GENERIC.has(w))) continue;
      if (parts.length === 1 && (gram.length < 5 || /^\d+$/.test(gram))) continue;
      if (!best || gram.length > best.norm.length) best = { norm: gram, sites };
    }
  }
  if (best) {
    let sameName = best.sites;
    // A place named in the question (a 1:100,000 map sheet such as Charters Towers) must agree with the site chosen.
    const asked = new Set<string>();
    for (let n = 1; n <= 4; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        const gram = words.slice(i, i + n).join(" ");
        if (index.sheets.has(gram) && gram !== best.norm) asked.add(gram);
      }
    }
    if (asked.size) {
      const here = best.sites.filter((s) => s.sheet && asked.has(normalizeName(s.sheet)));
      if (!here.length) {
        return { kind: "elsewhere", candidates: [...best.sites].sort((a, b) => sizeRank(b) - sizeRank(a)).slice(0, 10), asked: [...asked] };
      }
      sameName = best.sites;
      best = { norm: best.norm, sites: here };
    }
    const ranked = [...best.sites].sort((a, b) => sizeRank(b) - sizeRank(a) || a.site_no - b.site_no);
    const top = ranked[0]!;
    if (ranked.length === 1 || sizeRank(top) > sizeRank(ranked[1]!)) {
      return { kind: "found", site: top, others: sameName.filter((s) => s !== top).sort((a, b) => sizeRank(b) - sizeRank(a) || a.site_no - b.site_no), matchedBy: "name" };
    }
    return { kind: "ambiguous", candidates: ranked.slice(0, 10) };
  }

  // Nothing matched: offer the closest real names by shared words.
  const asked = new Set(words.filter((w) => !GENERIC.has(w) && w.length > 2));
  const scored: [number, string][] = [];
  for (const [norm] of index.byName) {
    const parts = norm.split(" ");
    const shared = parts.filter((p) => asked.has(p)).length;
    if (shared) scored.push([shared / parts.length + shared, norm]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
  return { kind: "none", closest: scored.slice(0, 5).map(([, n]) => n) };
}
