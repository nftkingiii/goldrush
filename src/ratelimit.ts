/** Fixed-window per-IP limiter. The map is cleared if it ever grows past 10,000 addresses. */
export function createLimiter(limit: number, windowMs = 60_000, now: () => number = Date.now) {
  const hits = new Map<string, { count: number; reset: number }>();
  return function allowed(ip: string): boolean {
    const t = now();
    const hit = hits.get(ip);
    if (!hit || hit.reset < t) {
      if (hits.size > 10_000) hits.clear();
      hits.set(ip, { count: 1, reset: t + windowMs });
      return true;
    }
    return ++hit.count <= limit;
  };
}
