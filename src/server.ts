// MCP tool surface. Tool descriptions are written for the model: they say when
// to use each tool, not just what it returns.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "./config.js";
import { MarketplaceSession } from "./browser/session.js";
import { buildSearchUrl } from "./browser/urls.js";
import { Store } from "./store/db.js";
import { compactRun, runCompare, runWatchCheck } from "./service.js";
import { writeReports } from "./report.js";
import { log } from "./log.js";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] });

function failure(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  log.error(msg);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

const sort = z.enum(["relevance", "price_asc", "price_desc", "newest", "nearest"]);
const condition = z.enum(["new", "used_like_new", "used_good", "used_fair"]);
const location = z
  .string()
  .min(2)
  .max(40)
  .optional()
  .describe(
    `Israeli city name in English or Hebrew (Tel Aviv, ירושלים, Petah Tikva, Holon, Beersheba...), a Marketplace slug, or the numeric id from a Marketplace URL. Default: ${config.location}.`,
  );
const days = z.union([z.literal(1), z.literal(7), z.literal(30)]).optional().describe("Only listings from the last N days.");

export function createServer(): { server: McpServer; shutdown: () => Promise<void> } {
  const session = new MarketplaceSession();
  const store = new Store(config.dbPath);
  const server = new McpServer(
    { name: "facebook-marketplace", version: "1.0.0" },
    {
      instructions: [
        "Facebook Marketplace, read-only.",
        "For any best price / cheapest / good deal / is-this-fair / should-I-buy request, load the `marketplace-deals` skill if available and call marketplace_compare",
        "(several Hebrew + English query variants): it sweeps sorts, groups like-for-like variants, ranks deals and flags scams.",
        "marketplace_search is only for a quick raw look at one query.",
        "Never type Facebook credentials: marketplace_login opens a window where the user logs in.",
      ].join(" "),
    },
  );

  server.registerTool(
    "marketplace_status",
    {
      description: "Check whether the Marketplace browser session is logged in, plus the active configuration. Call first if other tools fail.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return json({
          loggedIn: await session.isLoggedIn(),
          profileLocked: session.profileLocked,
          note: "Logged out still works (about 24 results per search page). Logging in adds scrolling for more results and seller names.",
          location: config.location,
          locale: config.locale,
          home: config.home,
          profileDir: config.profileDir,
          reportsDir: config.reportsDir,
          db: store.stats(),
        });
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "marketplace_login",
    {
      description:
        "Open a visible browser window on Facebook so the USER can log in by hand (Claude never types credentials). Waits until login completes or the timeout passes. Optional: search works logged out.",
      inputSchema: { timeout_minutes: z.number().min(1).max(15).default(5) },
    },
    async ({ timeout_minutes }) => {
      try {
        const ok = await session.login(timeout_minutes * 60 * 1000);
        return json({ loggedIn: ok, message: ok ? "Logged in. The session is saved in the dedicated profile." : "Login not detected before the timeout." });
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "marketplace_search",
    {
      description:
        "Raw Marketplace search for one query. Use for quick looks; for price comparison or 'find me the best deal' use marketplace_compare instead. Write queries the way local sellers write titles (Hebrew and/or English).",
      inputSchema: {
        query: z.string().min(1).max(120),
        location,
        min_price: z.number().min(0).optional(),
        max_price: z.number().min(0).optional(),
        sort: sort.default("relevance"),
        conditions: z.array(condition).optional(),
        days_since_listed: days,
        radius_km: z.number().min(1).max(500).optional(),
        max_results: z.number().int().min(1).max(100).default(24),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => {
      try {
        const url = buildSearchUrl({
          query: a.query,
          location: a.location ?? config.location,
          minPrice: a.min_price,
          maxPrice: a.max_price,
          sort: a.sort,
          conditions: a.conditions,
          daysSinceListed: a.days_since_listed,
          radiusKm: a.radius_km,
        });
        const page = await session.search(url, a.max_results);
        store.recordListings(page.listings);
        return json({
          url,
          loggedIn: page.loggedIn,
          count: page.listings.length,
          listings: page.listings.map((l) => ({
            id: l.id,
            title: l.title,
            price: l.priceText || l.price,
            ...(l.previousPrice ? { wasPrice: l.previousPrice } : {}),
            city: l.city,
            listedDaysAgo: l.createdAt ? Math.round((Date.now() / 1000 - l.createdAt) / 8640) / 10 : null,
            ...(l.isSold || l.isPending ? { status: l.isSold ? "sold" : "pending" } : {}),
            ...(l.sellerName ? { seller: l.sellerName } : {}),
            url: l.url,
          })),
        });
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "marketplace_listing",
    {
      description:
        "Full detail for one listing: description, condition, exact pickup area, delivery options, all photos. Set include_photos to SEE the real photos (check the item matches the title, spot stock photos, damage, serial numbers).",
      inputSchema: {
        listing: z.string().min(6).describe("Listing id or Marketplace item URL."),
        include_photos: z.number().int().min(0).max(6).default(0).describe("How many photos to return as images."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ listing, include_photos }) => {
      try {
        const d = await session.detail(listing);
        const content: Content[] = [{ type: "text", text: JSON.stringify({ ...d, photoCount: d.photos.length }, null, 1) }];
        if (include_photos > 0) {
          for (const img of await session.photos(d.photos.slice(0, include_photos))) {
            content.push({ type: "image", data: img.data, mimeType: img.mimeType });
          }
        }
        return { content };
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "marketplace_compare",
    {
      description: [
        "Find the best-priced listings for a product and benchmark the market. Sweeps every query variant × sort order, merges,",
        "drops irrelevant/sold/reposted listings, groups like-for-like (e.g. 'pro · 256GB'), computes price stats per variant,",
        "ranks deals (price vs variant, price drops, recency, condition, distance), opens the top few for details,",
        "flags scams (too cheap, prepayment, parts/broken, buy requests, placeholder ₪1 prices) and suggests an opening offer.",
        "Pass several query variants: Hebrew + English + model spellings, e.g. ['iphone 13', 'אייפון 13'].",
        "Takes about 5-8 s per page; default 3 sorts per query, capped at 12 pages.",
      ].join(" "),
      inputSchema: {
        queries: z.array(z.string().min(1).max(120)).min(1).max(6),
        location,
        min_price: z.number().min(0).optional().describe("Also useful to cut accessories and placeholder prices."),
        max_price: z.number().min(0).optional(),
        conditions: z.array(condition).optional(),
        days_since_listed: days,
        radius_km: z.number().min(1).max(500).optional(),
        sorts: z.array(sort).max(4).optional().describe("Default ['relevance','price_asc','newest']."),
        must_include: z.array(z.string()).optional().describe("Every title must contain these words (e.g. ['pro'])."),
        exclude: z.array(z.string()).optional().describe("Drop titles containing these words (e.g. ['case','כיסוי'])."),
        reference_price: z.number().positive().optional().describe("Known fair USED price from outside Marketplace; enables vsReferencePct and a scam check."),
        home_lat: z.number().min(-90).max(90).optional(),
        home_lng: z.number().min(-180).max(180).optional(),
        enrich_top: z.number().int().min(0).max(8).default(3),
        top_n: z.number().int().min(1).max(30).default(10),
        export_report: z.boolean().default(false).describe("Also write CSV + HTML reports and return their paths."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (a) => {
      try {
        const run = await runCompare(session, store, {
          queries: a.queries,
          location: a.location,
          minPrice: a.min_price,
          maxPrice: a.max_price,
          conditions: a.conditions,
          daysSinceListed: a.days_since_listed,
          radiusKm: a.radius_km,
          sorts: a.sorts,
          mustInclude: a.must_include,
          exclude: a.exclude,
          referencePrice: a.reference_price,
          home: a.home_lat !== undefined && a.home_lng !== undefined ? { lat: a.home_lat, lng: a.home_lng } : undefined,
          enrichTop: a.enrich_top,
          topN: a.top_n,
        });
        const out = compactRun(run);
        if (a.export_report) out.reports = writeReports(run, config.reportsDir, a.queries[0]);
        return json(out);
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "marketplace_watch",
    {
      description:
        "Save, list or remove a watch: a saved comparison that marketplace_check_watches re-runs to report NEW listings, PRICE DROPS and hits at or below a target price.",
      inputSchema: {
        action: z.enum(["add", "list", "remove"]),
        name: z.string().regex(/^[\w֐-׿ -]{1,40}$/).optional(),
        queries: z.array(z.string().min(1).max(120)).min(1).max(4).optional(),
        location,
        min_price: z.number().min(0).optional(),
        max_price: z.number().min(0).optional(),
        target_price: z.number().positive().optional(),
        must_include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
        conditions: z.array(condition).optional(),
      },
    },
    async (a) => {
      try {
        if (a.action === "list") return json(store.listWatches());
        if (!a.name) throw new Error("name is required for add/remove.");
        if (a.action === "remove") return json({ removed: store.removeWatch(a.name) });
        if (!a.queries?.length) throw new Error("queries are required to add a watch.");
        store.saveWatch(a.name, {
          queries: a.queries,
          location: a.location ?? config.location,
          minPrice: a.min_price,
          maxPrice: a.max_price,
          targetPrice: a.target_price,
          mustInclude: a.must_include,
          exclude: a.exclude,
          conditions: a.conditions,
        });
        return json({ saved: a.name, next: "Run marketplace_check_watches now to set the baseline, then later to see what changed." });
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "marketplace_check_watches",
    {
      description: "Re-run saved watches and report only what changed since each one's last check: new listings, price drops, target-price hits. The first check of a watch sets a baseline.",
      inputSchema: { name: z.string().optional().describe("One watch; omit for all.") },
      annotations: { openWorldHint: true },
    },
    async ({ name }) => {
      try {
        const watches = store.listWatches().filter((w) => !name || w.name === name);
        if (!watches.length) throw new Error(name ? `No watch named "${name}".` : "No watches saved yet.");
        const results = [];
        for (const w of watches) results.push(await runWatchCheck(session, store, w));
        return json(results);
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "marketplace_price_history",
    {
      description: "Local price history recorded by earlier searches: one listing's price changes (by id/URL) or past listings whose title matches some text. Useful for 'has this dropped?' and 'what did these go for last month?'.",
      inputSchema: {
        listing: z.string().optional(),
        title_contains: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ listing, title_contains }) => {
      try {
        if (listing) {
          const id = listing.match(/\d{6,25}/)?.[0];
          if (!id) throw new Error("Could not read a listing id.");
          return json(store.history(id));
        }
        if (title_contains) return json(store.searchHistory(title_contains));
        throw new Error("Give listing or title_contains.");
      } catch (e) {
        return failure(e);
      }
    },
  );

  const shutdown = async () => {
    await session.close();
    store.close();
  };
  return { server, shutdown };
}
