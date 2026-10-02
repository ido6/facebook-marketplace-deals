// The comparison engine: turns a raw pile of listings into like-for-like price
// groups, a deal ranking, and a list of things to avoid. Pure: no I/O.

import type { Listing, ListingDetail, RedFlag, Specs } from "./types.js";
import { extractSpecs, isRelevant, normalizeText, specKey, stemMatch, tierKey, tokens } from "./specs.js";
import { isPlaceholderPrice, redFlags, worstSeverity } from "./flags.js";
import { haversineKm, madOutliers, percentile, priceStats, type PriceStats } from "./stats.js";

export interface CompareOptions {
  /** Every query variant used; a title must contain all tokens of one of them. */
  queries: string[];
  mustInclude?: string[];
  exclude?: string[];
  details?: Map<string, ListingDetail>;
  home?: { lat: number; lng: number } | null;
  /** Known fair used price (e.g. from a price guide); adds vsReferencePct and a scam check. */
  referencePrice?: number | null;
  minGroupSize?: number;
  topN?: number;
  nowSec?: number;
}

export interface Benchmark {
  level: "variant" | "tier" | "all";
  key: string;
  stats: PriceStats;
}

export interface Offer {
  verdict: string;
  /** Percent vs the benchmark median; negative = below market. */
  vsMedianPct: number;
  opening: number;
  fair: number;
}

export interface ScoredListing {
  id: string;
  url: string;
  title: string;
  price: number | null;
  priceText: string;
  previousPrice: number | null;
  city: string | null;
  ageDays: number | null;
  variant: string;
  specs: Specs;
  condition: string | null;
  distanceKm: number | null;
  score: number;
  benchmark: Benchmark | null;
  offer: Offer | null;
  vsReferencePct: number | null;
  flags: RedFlag[];
  repostCount: number;
}

export interface GroupSummary {
  variant: string;
  count: number;
  stats: PriceStats | null;
  outliersRemoved: number[];
  bestIds: string[];
}

export interface CompareResult {
  currency: string | null;
  counts: {
    fetched: number;
    unavailable: number;
    irrelevant: number;
    excluded: number;
    otherCurrency: number;
    reposts: number;
    analysed: number;
  };
  overall: PriceStats | null;
  groups: GroupSummary[];
  deals: ScoredListing[];
  suspicious: ScoredListing[];
  placeholders: Array<{ id: string; title: string; priceText: string; url: string }>;
  notes: string[];
}

const DAY = 86400;

/** Round to a price a human would say out loud. */
export function roundNice(x: number): number {
  const step = x >= 5000 ? 100 : x >= 1000 ? 50 : x >= 200 ? 10 : 5;
  return Math.max(step, Math.round(x / step) * step);
}

export function suggestOffer(price: number, bench: PriceStats): Offer {
  const vs = Math.round(((price - bench.median) / bench.median) * 100);
  const verdict =
    vs <= -15 ? "well below market" : vs <= -5 ? "below market" : vs < 5 ? "at market" : vs < 15 ? "above market" : "overpriced";
  const fair = Math.min(price, roundNice(bench.median));
  const opening = Math.min(fair, roundNice(Math.max(price * 0.8, bench.p25 * 0.9)));
  return { verdict, vsMedianPct: vs, opening, fair };
}

/** First token of the query variant this title matched: the product noun to test "accessory for X" against. */
function productTokenFor(title: string, queries: string[]): string | null {
  const q = queries.find((v) => isRelevant(title, [v]));
  return q ? (tokens(q)[0] ?? null) : null;
}

/**
 * One kind of product, so a far-below-median price means something. Measured on
 * the upper half only: bait listings pile up at the bottom and would otherwise
 * widen the spread and switch off the very flag meant to catch them.
 */
export function isHomogeneous(s: PriceStats): boolean {
  return s.median > 0 && (s.p75 - s.median) / s.median < 0.3;
}

const CONDITION_POINTS: Record<string, number> = {
  new: 10,
  used_like_new: 8,
  refurbished: 7,
  used_good: 5,
  used_fair: 2,
};

function recencyPoints(ageDays: number | null): number {
  if (ageDays === null) return 5;
  if (ageDays <= 3) return 10;
  if (ageDays <= 7) return 8;
  if (ageDays <= 14) return 6;
  if (ageDays <= 30) return 4;
  return 2;
}

function distancePoints(km: number | null): number {
  if (km === null) return 7;
  if (km <= 10) return 15;
  if (km <= 25) return 12;
  if (km <= 50) return 8;
  if (km <= 100) return 4;
  return 0;
}

function dominantCurrency(ls: Listing[]): string | null {
  const counts = new Map<string, number>();
  for (const l of ls) if (l.currency) counts.set(l.currency, (counts.get(l.currency) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Same title, price and city under different ids = the seller re-posted. Keep the newest. */
function collapseReposts(ls: Listing[]): { kept: Listing[]; repostCount: Map<string, number> } {
  const byKey = new Map<string, Listing[]>();
  for (const l of ls) {
    const key = `${l.sellerId ?? ""}|${normalizeText(l.title)}|${l.price}|${l.city}`;
    byKey.set(key, [...(byKey.get(key) ?? []), l]);
  }
  const kept: Listing[] = [];
  const repostCount = new Map<string, number>();
  for (const group of byKey.values()) {
    const newest = [...group].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
    kept.push(newest);
    repostCount.set(newest.id, group.length - 1);
  }
  return { kept, repostCount };
}

interface Pool {
  clean: number[];
  stats: PriceStats | null;
  outliers: number[];
}

function pool(prices: number[]): Pool {
  const real = prices.filter((p) => !isPlaceholderPrice(p));
  const out = madOutliers(real);
  const clean = real.filter((p) => !out.has(p));
  return { clean, stats: priceStats(clean), outliers: [...out] };
}

export function compareListings(all: Listing[], opts: CompareOptions): CompareResult {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const minGroup = opts.minGroupSize ?? 3;
  const details = opts.details ?? new Map<string, ListingDetail>();
  const excludeTokens = (opts.exclude ?? []).map((e) => tokens(e)).filter((t) => t.length);
  const notes: string[] = [];

  const available = all.filter((l) => !l.isSold && !l.isPending);
  const relevant = available.filter((l) => isRelevant(l.title, opts.queries, opts.mustInclude));
  // Stem match, so "משחק" also drops "משחקי"/"ומשחקים" and "case" drops "cases".
  const notExcluded = relevant.filter((l) => {
    const words = tokens(l.title);
    return !excludeTokens.some((ts) => ts.every((t) => words.some((w) => stemMatch(w, t))));
  });
  const currency = dominantCurrency(notExcluded);
  const sameCurrency = notExcluded.filter((l) => !currency || !l.currency || l.currency === currency);
  const { kept, repostCount } = collapseReposts(sameCurrency);

  // Title only: reading the description for the few enriched listings would move
  // them into a different group than their un-enriched peers.
  const specsOf = new Map(kept.map((l) => [l.id, extractSpecs(l.title)]));
  const byVariant = new Map<string, Listing[]>();
  const byTier = new Map<string, Listing[]>();
  for (const l of kept) {
    const s = specsOf.get(l.id)!;
    byVariant.set(specKey(s), [...(byVariant.get(specKey(s)) ?? []), l]);
    byTier.set(tierKey(s), [...(byTier.get(tierKey(s)) ?? []), l]);
  }
  const priced = (ls: Listing[]) => ls.map((l) => l.price).filter((p): p is number => p !== null);
  const variantPools = new Map([...byVariant].map(([k, ls]) => [k, pool(priced(ls))]));
  const tierPools = new Map([...byTier].map(([k, ls]) => [k, pool(priced(ls))]));
  const overallPool = pool(priced(kept));

  const benchmarkFor = (s: Specs): { b: Benchmark | null; clean: number[] } => {
    const v = variantPools.get(specKey(s))!;
    if (v.stats && v.stats.n >= minGroup) return { b: { level: "variant", key: specKey(s), stats: v.stats }, clean: v.clean };
    const t = tierPools.get(tierKey(s))!;
    if (t.stats && t.stats.n >= minGroup) return { b: { level: "tier", key: tierKey(s), stats: t.stats }, clean: t.clean };
    if (overallPool.stats && overallPool.stats.n >= minGroup) {
      return { b: { level: "all", key: "all", stats: overallPool.stats }, clean: overallPool.clean };
    }
    return { b: null, clean: [] };
  };

  const scored: ScoredListing[] = kept.map((l) => {
    const s = specsOf.get(l.id)!;
    const d = details.get(l.id) ?? null;
    const { b, clean } = benchmarkFor(s);
    const distanceKm =
      opts.home && d?.latitude != null && d?.longitude != null
        ? Math.round(haversineKm(opts.home.lat, opts.home.lng, d.latitude, d.longitude) * 10) / 10
        : null;
    const flags = redFlags(l, {
      groupMedian: b?.stats.median ?? null,
      groupHomogeneous: b ? isHomogeneous(b.stats) : true,
      productToken: productTokenFor(l.title, opts.queries),
      referencePrice: opts.referencePrice,
      detail: d,
      distanceKm,
      nowSec: now,
    });
    const ageDays = l.createdAt ? Math.max(0, Math.round(((now - l.createdAt) / DAY) * 10) / 10) : null;
    const realPrice = l.price !== null && !isPlaceholderPrice(l.price);

    let score = 0;
    // Price position dominates (60 of 100); the rest only breaks near-ties, so an
    // overpriced listing cannot climb back up on freshness or a small price cut.
    // Half rank within the group, half actual discount vs its median: in a thin
    // group the cheapest listing ranks first even when it is barely below market.
    if (realPrice && clean.length && b) {
      const rankPts = (1 - percentile(clean, l.price!)) * 60;
      const discount = (b.stats.median - l.price!) / b.stats.median;
      const discountPts = Math.min(60, Math.max(0, 30 + discount * 100));
      score += (rankPts + discountPts) / 2;
    } else {
      score += 20;
    }
    if (l.previousPrice && l.price !== null && l.previousPrice > l.price) {
      score += Math.min(5, ((l.previousPrice - l.price) / l.previousPrice) * 25);
    }
    score += recencyPoints(ageDays);
    score += d?.condition ? (CONDITION_POINTS[d.condition] ?? 5) : 5;
    score += distancePoints(distanceKm);
    for (const f of flags) score -= f.severity === "medium" ? 15 : f.severity === "low" ? 3 : 0;
    if (worstSeverity(flags) === "high") score = Math.min(score, 20);

    return {
      id: l.id,
      url: l.url,
      title: l.title,
      price: l.price,
      priceText: l.priceText,
      previousPrice: l.previousPrice,
      city: d?.locationText ?? l.city,
      ageDays,
      variant: specKey(s),
      specs: s,
      condition: d?.conditionLabel ?? d?.condition ?? null,
      distanceKm,
      score: Math.max(0, Math.round(score)),
      benchmark: b,
      offer: b && realPrice ? suggestOffer(l.price!, b.stats) : null,
      vsReferencePct:
        opts.referencePrice && realPrice ? Math.round(((l.price! - opts.referencePrice) / opts.referencePrice) * 100) : null,
      flags,
      repostCount: repostCount.get(l.id) ?? 0,
    };
  });

  const byScore = (a: ScoredListing, b: ScoredListing) => b.score - a.score;
  const placeholders = scored.filter((x) => isPlaceholderPrice(x.price));
  const suspicious = scored.filter((x) => worstSeverity(x.flags) === "high").sort(byScore);
  const deals = scored
    .filter((x) => worstSeverity(x.flags) !== "high" && !isPlaceholderPrice(x.price))
    .sort(byScore);

  const groups: GroupSummary[] = [...byVariant.entries()]
    .map(([variant, ls]) => ({
      variant,
      count: ls.length,
      stats: variantPools.get(variant)!.stats,
      outliersRemoved: variantPools.get(variant)!.outliers,
      bestIds: deals.filter((x) => x.variant === variant).slice(0, 3).map((x) => x.id),
    }))
    .sort((a, b) => b.count - a.count);

  if (groups.some((g) => g.stats && g.stats.n >= minGroup && !isHomogeneous(g.stats))) {
    notes.push(
      "Prices within a group spread widely: the query probably mixes different products (sizes, models). Cheap listings there are not auto-flagged as scams; narrow the query or use must_include for a sharper comparison.",
    );
  }
  if (kept.length < 8) notes.push("Small sample: treat the medians as rough. Try more query variants or a wider radius.");
  if (groups.some((g) => g.count < minGroup)) {
    notes.push("Some variants have too few listings; they are benchmarked against their product tier or the whole set (see benchmark.level).");
  }
  notes.push("All figures are asking prices, not sold prices: real deals usually close 5-15% lower.");

  return {
    currency,
    counts: {
      fetched: all.length,
      unavailable: all.length - available.length,
      irrelevant: available.length - relevant.length,
      excluded: relevant.length - notExcluded.length,
      otherCurrency: notExcluded.length - sameCurrency.length,
      reposts: sameCurrency.length - kept.length,
      analysed: kept.length,
    },
    overall: overallPool.stats,
    groups,
    deals: deals.slice(0, opts.topN ?? 10),
    suspicious,
    placeholders: placeholders.map((p) => ({ id: p.id, title: p.title, priceText: p.priceText, url: p.url })),
    notes,
  };
}
