export interface PriceStats {
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  mean: number;
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function priceStats(values: number[]): PriceStats | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const round = (x: number) => Math.round(x);
  return {
    n: s.length,
    min: s[0],
    p25: round(quantile(s, 0.25)),
    median: round(quantile(s, 0.5)),
    p75: round(quantile(s, 0.75)),
    max: s[s.length - 1],
    mean: round(s.reduce((a, b) => a + b, 0) / s.length),
  };
}

/**
 * Robust outlier test (median absolute deviation). A plain IQR fence breaks on
 * the tiny samples Marketplace returns; MAD stays sane down to ~4 points.
 */
export function madOutliers(values: number[], threshold = 3.5): Set<number> {
  if (values.length < 4) return new Set();
  const s = [...values].sort((a, b) => a - b);
  const med = quantile(s, 0.5);
  const mad = quantile(
    s.map((v) => Math.abs(v - med)).sort((a, b) => a - b),
    0.5,
  );
  if (mad === 0) return new Set();
  return new Set(values.filter((v) => (0.6745 * Math.abs(v - med)) / mad > threshold));
}

/** Share of `values` strictly below `x`, 0..1. */
export function percentile(values: number[], x: number): number {
  if (!values.length) return 0.5;
  return values.filter((v) => v < x).length / values.length;
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
