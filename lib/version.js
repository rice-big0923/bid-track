// "3.10.0" vs "3.9.9": compared part by part as numbers. Anything that isn't a dotted version never counts as newer.
export function isNewer(latest, current) {
  const parse = (v) => (typeof v === "string" && /^\d+(\.\d+)*$/.test(v.trim()) ? v.trim().split(".").map(Number) : null);
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
