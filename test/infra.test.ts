import { describe, expect, it } from "vitest";
import { buildSearchUrl, itemUrl, normalizeListingId, resolveLocation } from "../src/browser/urls.js";
import { Store } from "../src/store/db.js";
import { toCsv, toHtml } from "../src/report.js";
import { compareListings } from "../src/core/analyze.js";
import type { Listing } from "../src/core/types.js";
import type { CompareRun } from "../src/service.js";

const mk = (id: string, price: number, title = "iPhone 13"): Listing => ({
  id,
  url: `https://www.facebook.com/marketplace/item/${id}/`,
  title,
  price,
  currency: "ILS",
  priceText: `${price} ₪`,
  previousPrice: null,
  city: `c${id}`,
  imageUrl: null,
  createdAt: 1_790_000_000,
  isSold: false,
  isPending: false,
  sellerName: null,
  sellerId: null,
  deliveryTypes: [],
  categoryId: null,
});

describe("urls", () => {
  it("builds a filtered search URL", () => {
    const u = new URL(buildSearchUrl({ query: "אייפון 13", location: "TelAviv", minPrice: 800, maxPrice: 1500.4, sort: "price_asc", conditions: ["new", "used_like_new"], daysSinceListed: 7 }));
    expect(u.pathname).toBe("/marketplace/telaviv/search");
    expect(u.searchParams.get("query")).toBe("אייפון 13");
    expect(u.searchParams.get("maxPrice")).toBe("1501");
    expect(u.searchParams.get("sortBy")).toBe("price_ascend");
    expect(u.searchParams.get("itemCondition")).toBe("new,used_like_new");
    expect(u.searchParams.get("daysSinceListed")).toBe("7");
  });

  it("rejects location injection", () => {
    expect(() => buildSearchUrl({ query: "x", location: "../login" })).toThrow(/Unknown location/);
  });

  it("resolves bilingual city names to slugs or numeric ids", () => {
    expect(resolveLocation("Tel Aviv")).toBe("telaviv");
    expect(resolveLocation("פתח תקווה")).toBe("104047936296918");
    expect(resolveLocation(" Holon ")).toBe("114283675255321");
    expect(resolveLocation("106401656063896")).toBe("106401656063896");
    expect(() => resolveLocation("חיפה")).toThrow(/numeric id/);
  });

  it("normalises ids from URLs", () => {
    expect(normalizeListingId("https://www.facebook.com/marketplace/item/1234567890123456/?ref=x")).toBe("1234567890123456");
    expect(itemUrl("1234567890123456")).toBe("https://www.facebook.com/marketplace/item/1234567890123456/");
    expect(() => normalizeListingId("hello")).toThrow();
  });
});

describe("store", () => {
  it("detects new listings and price drops", () => {
    const s = new Store(":memory:");
    expect(s.recordListings([mk("100001", 1000)], 1).newIds).toEqual(["100001"]);
    const second = s.recordListings([mk("100001", 900), mk("100002", 500)], 2);
    expect(second.newIds).toEqual(["100002"]);
    expect(second.priceDrops).toEqual([expect.objectContaining({ id: "100001", from: 1000, to: 900 })]);
    expect(s.history("100001").prices.map((p) => p.price)).toEqual([1000, 900]);
    expect(s.searchHistory("iPhone").length).toBe(2);
  });

  it("keeps the known price when a later sighting has none", () => {
    const s = new Store(":memory:");
    s.recordListings([mk("100001", 1000)], 1);
    s.recordListings([{ ...mk("100001", 0), price: null }], 2);
    const drop = s.recordListings([mk("100001", 900)], 3);
    expect(drop.priceDrops).toEqual([expect.objectContaining({ from: 1000, to: 900 })]);
    expect(s.history("100001").listing).toMatchObject({ last_price: 900, min_price: 900 });
  });

  it("watches set a baseline first, then report changes", () => {
    const s = new Store(":memory:");
    s.saveWatch("w", { queries: ["iphone 13"], location: "telaviv" });
    expect(s.markWatchSeen("w", [mk("100001", 1000)], 1)).toEqual({ newIds: [], priceDrops: [] });
    const next = s.markWatchSeen("w", [mk("100001", 950), mk("100003", 800)], 2);
    expect(next.newIds).toEqual(["100003"]);
    expect(next.priceDrops[0]).toMatchObject({ from: 1000, to: 950 });
    expect(s.listWatches()[0].lastChecked).toBe(2);
    expect(s.removeWatch("w")).toBe(true);
  });
});

describe("report", () => {
  const ls = [mk("1", 900), mk("2", 1000), mk("3", 1100), mk("4", 1200, "=HYPERLINK(\"x\") iPhone 13 <script>")];
  const run = {
    result: compareListings(ls, { queries: ["iphone 13"] }),
    listings: ls,
    meta: {} as CompareRun["meta"],
  } as CompareRun;

  it("writes Excel-friendly, injection-safe CSV", () => {
    const csv = toCsv(run);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("\"'=HYPERLINK(\"\"x\"\") iPhone 13 <script>\"");
  });

  it("escapes HTML", () => {
    const html = toHtml(run, "iphone <13>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("iphone &lt;13&gt;");
  });
});
