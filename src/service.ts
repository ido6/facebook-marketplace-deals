// Orchestration shared by the MCP tools and the CLI: sweep several query
// variants × sort orders (logged out, Facebook returns ~24 results per page, so
// different sorts surface different listings), merge, compare, enrich the top
// candidates with their detail pages, and record price history.

import { config } from "./config.js";
import { compareListings, type CompareResult, type ScoredListing } from "./core/analyze.js";
import type { Listing, ListingDetail } from "./core/types.js";
import { BlockedError, NotAuthenticatedError, UnknownLocationError, type MarketplaceSession } from "./browser/session.js";
import { buildSearchUrl, type Condition, type SortOrder } from "./browser/urls.js";
import type { PriceChange, Store, Watch } from "./store/db.js";
import { log } from "./log.js";

export interface CompareRequest {
  queries: string[];
  location?: string;
  minPrice?: number;
  maxPrice?: number;
  conditions?: Condition[];
  daysSinceListed?: 1 | 7 | 30;
  radiusKm?: number;
  sorts?: SortOrder[];
  mustInclude?: string[];
  exclude?: string[];
  referencePrice?: number;
  home?: { lat: number; lng: number } | null;
  /** How many top deals to open for condition, description, distance and deeper scam checks. */
  enrichTop?: number;
  topN?: number;
  maxResultsPerPage?: number;
}

export interface CompareRun {
  result: CompareResult;
  listings: Listing[];
  meta: {
    location: string;
    loggedIn: boolean;
    pagesLoaded: number;
    pagesFromCache: number;
    pagesSkipped: number;
    enriched: number;
    errors: string[];
    newSinceLastSeen: number;
    priceDrops: PriceChange[];
    seconds: number;
  };
}

const DEFAULT_SORTS: SortOrder[] = ["relevance", "price_asc", "newest"];

function isFatal(e: unknown): boolean {
  return e instanceof NotAuthenticatedError || e instanceof BlockedError || e instanceof UnknownLocationError;
}

export async function runCompare(session: MarketplaceSession, store: Store, req: CompareRequest): Promise<CompareRun> {
  const started = Date.now();
  const location = req.location ?? config.location;
  const queries = [...new Set(req.queries.map((q) => q.trim()).filter(Boolean))];
  if (!queries.length) throw new Error("Give at least one search query.");
  const sorts = req.sorts?.length ? req.sorts : DEFAULT_SORTS;

  const plan = queries.flatMap((query) => sorts.map((sort) => ({ query, sort })));
  const pages = plan.slice(0, config.maxPagesPerCompare);
  const errors: string[] = [];
  const merged = new Map<string, Listing>();
  let loggedIn = false;
  let fromCache = 0;

  for (const { query, sort } of pages) {
    const url = buildSearchUrl({
      query,
      location,
      sort,
      minPrice: req.minPrice,
      maxPrice: req.maxPrice,
      conditions: req.conditions,
      daysSinceListed: req.daysSinceListed,
      radiusKm: req.radiusKm,
    });
    try {
      const page = await session.search(url, req.maxResultsPerPage ?? 48);
      loggedIn ||= page.loggedIn;
      if (page.fromCache) fromCache++;
      for (const l of page.listings) if (!merged.has(l.id)) merged.set(l.id, l);
    } catch (e) {
      if (isFatal(e)) throw e;
      errors.push(`${query} / ${sort}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!merged.size && errors.length) throw new Error(`Every search failed:\n${errors.join("\n")}`);

  const listings = [...merged.values()];
  const seen = store.recordListings(listings);
  const opts = {
    queries,
    mustInclude: req.mustInclude,
    exclude: req.exclude,
    referencePrice: req.referencePrice ?? null,
    home: req.home ?? config.home,
    topN: req.topN ?? 10,
  };

  // First pass ranks on search data; the top few get their detail page opened,
  // then we re-rank with condition, distance and description-based flags.
  const firstPass = compareListings(listings, opts);
  const details = new Map<string, ListingDetail>();
  for (const d of firstPass.deals.slice(0, req.enrichTop ?? 3)) {
    try {
      details.set(d.id, await session.detail(d.id));
    } catch (e) {
      if (isFatal(e)) throw e;
      errors.push(`detail ${d.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const result = details.size ? compareListings(listings, { ...opts, details }) : firstPass;
  const analysedIds = new Set([...result.deals, ...result.suspicious].map((x) => x.id));
  log.info(`compare: ${listings.length} listings, ${pages.length} pages, ${details.size} enriched`);

  return {
    result,
    listings,
    meta: {
      location,
      loggedIn,
      pagesLoaded: pages.length - fromCache,
      pagesFromCache: fromCache,
      pagesSkipped: plan.length - pages.length,
      enriched: details.size,
      errors,
      newSinceLastSeen: seen.newIds.length,
      priceDrops: seen.priceDrops.filter((p) => analysedIds.has(p.id)),
      seconds: Math.round((Date.now() - started) / 1000),
    },
  };
}

/** A token-light view of a scored listing for the model to read. */
export function compactListing(x: ScoredListing, rank?: number): Record<string, unknown> {
  const b = x.benchmark;
  return {
    ...(rank !== undefined ? { rank } : {}),
    score: x.score,
    title: x.title,
    price: x.priceText || x.price,
    ...(x.previousPrice ? { wasPrice: x.previousPrice } : {}),
    variant: x.variant,
    city: x.city,
    ageDays: x.ageDays,
    ...(x.condition ? { condition: x.condition } : {}),
    ...(x.distanceKm !== null ? { distanceKm: x.distanceKm } : {}),
    ...(x.offer
      ? {
          verdict: `${x.offer.verdict} (${x.offer.vsMedianPct > 0 ? "+" : ""}${x.offer.vsMedianPct}% vs median)`,
          suggestedOpeningOffer: x.offer.opening,
          fairPrice: x.offer.fair,
        }
      : {}),
    ...(x.vsReferencePct !== null ? { vsReferencePct: x.vsReferencePct } : {}),
    benchmark: b ? `${b.level}:${b.key} n=${b.stats.n} median=${b.stats.median} p25=${b.stats.p25}` : "none",
    ...(x.flags.length ? { flags: x.flags.map((f) => `${f.severity}:${f.code} – ${f.message}`) } : {}),
    ...(x.repostCount ? { reposts: x.repostCount } : {}),
    id: x.id,
    url: x.url,
  };
}

export function compactRun(run: CompareRun): Record<string, unknown> {
  const r = run.result;
  return {
    currency: r.currency,
    counts: r.counts,
    overall: r.overall,
    groups: r.groups.map((g) => ({ variant: g.variant, count: g.count, stats: g.stats, outliersRemoved: g.outliersRemoved })),
    bestDeals: r.deals.map((d, i) => compactListing(d, i + 1)),
    suspicious: r.suspicious.map((d) => compactListing(d)),
    placeholderPrices: r.placeholders,
    notes: r.notes,
    meta: run.meta,
  };
}

export interface WatchCheck {
  watch: string;
  newListings: Array<Record<string, unknown>>;
  priceDrops: PriceChange[];
  hitsAtOrBelowTarget: Array<Record<string, unknown>>;
  best: Record<string, unknown> | null;
  baseline: boolean;
}

/** Re-run a saved watch and report only what changed since its last check. */
export async function runWatchCheck(session: MarketplaceSession, store: Store, watch: Watch): Promise<WatchCheck> {
  const s = watch.spec;
  const run = await runCompare(session, store, {
    queries: s.queries,
    location: s.location,
    minPrice: s.minPrice,
    maxPrice: s.maxPrice,
    mustInclude: s.mustInclude,
    exclude: s.exclude,
    conditions: s.conditions as Condition[] | undefined,
    sorts: ["newest", "price_asc"],
    enrichTop: 2,
    // Every ranked listing, not just the top 10: a new arrival at rank 11 is still news.
    topN: Number.MAX_SAFE_INTEGER,
  });
  const scored = [...run.result.deals, ...run.result.suspicious];
  const byId = new Map(scored.map((x) => [x.id, x]));
  const relevant = run.listings.filter((l) => byId.has(l.id));
  const baseline = watch.lastChecked === null;
  const seen = store.markWatchSeen(watch.name, relevant);
  const clean = (id: string) => byId.get(id)?.flags.every((f) => f.severity !== "high") ?? false;
  // Only listings that changed since the last check, so the same hit is not re-alerted daily.
  const changed = new Set([...seen.newIds, ...seen.priceDrops.map((p) => p.id)]);
  return {
    watch: watch.name,
    newListings: seen.newIds.filter(clean).map((id) => compactListing(byId.get(id)!)),
    priceDrops: seen.priceDrops.filter((p) => clean(p.id)),
    hitsAtOrBelowTarget: s.targetPrice
      ? run.result.deals.filter((d) => changed.has(d.id) && d.price !== null && d.price <= s.targetPrice!).map((d) => compactListing(d))
      : [],
    best: run.result.deals[0] ? compactListing(run.result.deals[0], 1) : null,
    baseline,
  };
}
