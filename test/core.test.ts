import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { currencyFromText, extractDetail, extractListings, parseGraphqlPayload, parseJsonBlocks } from "../src/core/extract.js";
import { extractSpecs, isRelevant, normalizeText, specKey } from "../src/core/specs.js";
import { compareListings, roundNice, suggestOffer } from "../src/core/analyze.js";
import { haversineKm, madOutliers, priceStats } from "../src/core/stats.js";
import { redFlags } from "../src/core/flags.js";
import type { Listing, ListingDetail } from "../src/core/types.js";

const searchHtml = readFileSync(new URL("./fixtures/search-iphone13.html", import.meta.url), "utf8");
const itemHtml = readFileSync(new URL("./fixtures/item-detail.html", import.meta.url), "utf8");

const mk = (over: Partial<Listing>): Listing => ({
  id: "1",
  url: "u",
  title: "iPhone 13",
  price: 1000,
  currency: "ILS",
  priceText: "1,000 ₪",
  previousPrice: null,
  city: "תל אביב",
  imageUrl: null,
  createdAt: 1_790_000_000,
  isSold: false,
  isPending: false,
  sellerName: null,
  sellerId: null,
  deliveryTypes: ["IN_PERSON"],
  categoryId: null,
  ...over,
});

describe("extract", () => {
  it("reads all 24 listings from the real search page JSON", () => {
    const ls = extractListings(parseJsonBlocks(searchHtml));
    expect(ls).toHaveLength(24);
    for (const l of ls) {
      expect(l.title).toBeTruthy();
      expect(l.price).toBeGreaterThan(0);
      expect(l.currency).toBe("ILS");
      expect(l.city).toBeTruthy();
    }
    const dropped = ls.find((l) => l.id === "9000000000000005")!;
    expect(dropped.price).toBe(1000);
    expect(dropped.previousPrice).toBe(1300);
  });

  it("selects the focal listing on the item page by id", () => {
    const d = extractDetail(parseJsonBlocks(itemHtml), "9000000000000001")!;
    expect(d.title).toContain("iPhone 13 256GB");
    expect(d.price).toBe(1000);
    expect(d.currency).toBe("ILS");
    expect(d.description).toContain("בריאות הסוללה: 85%");
    expect(d.condition).toBe("used_like_new");
    expect(d.latitude).toBeCloseTo(32.47, 1);
    expect(d.photos.length).toBe(5);
    expect(d.status).toBe("AVAILABLE");
  });

  it("returns null for an id that is not on the page", () => {
    expect(extractDetail(parseJsonBlocks(itemHtml), "999")).toBeNull();
  });

  it("parses for(;;)-prefixed newline-delimited GraphQL payloads", () => {
    const payload =
      'for (;;);{"data":{"x":{"id":"5","marketplace_listing_title":"A","listing_price":{"amount":"10.00","formatted_amount":"₪10"}}}}\n{"extensions":{}}';
    const ls = extractListings(parseGraphqlPayload(payload));
    expect(ls).toEqual([expect.objectContaining({ id: "5", price: 10, currency: "ILS" })]);
  });

  it("infers currency from symbols", () => {
    expect(currencyFromText("$427")).toBe("USD");
    expect(currencyFromText("1,000 ₪")).toBe("ILS");
    expect(currencyFromText("€5")).toBe("EUR");
    expect(currencyFromText("1000")).toBeNull();
  });
});

describe("specs", () => {
  it("folds Hebrew aliases and glued tokens", () => {
    expect(normalizeText("אייפון 13פרו")).toBe("iphone 13 פרו");
    expect(normalizeText("Iphone+13+256+Gb")).toBe("iphone 13 256 gb");
  });

  it.each([
    ["iPhone 13 Pro 256gb אייפון 13 פרו", "pro · 256GB"],
    ["iPhone 13 Pro 256go", "pro · 256GB"],
    ["אייפון iPhone 13. 129gb", "128GB"],
    ["למכירה אייפון 13 (256)", "256GB"],
    ["iPhone 13 mini 512GB", "mini · 512GB"],
    ["iPhone 13 Pro Max 256", "max · pro · 256GB"],
    ["אייפון 13 128 גיגה", "128GB"],
    ["MacBook Air 1TB", "air · 1TB"],
    ['Samsung TV 55"', '55"'],
    ["iPhone 13", "base"],
    ["PS5 פרוץ", "base"],
    ["פלייסטיישן 5 סלים דיגיטלי", "digital · slim"],
  ])("%s -> %s", (title, key) => {
    expect(specKey(extractSpecs(title))).toBe(key);
  });

  it("matches relevance by whole tokens across languages", () => {
    expect(isRelevant("אייפון 13 128GB", ["iphone 13"])).toBe(true);
    expect(isRelevant("iPhone 130 case", ["iphone 13"])).toBe(false);
    expect(isRelevant("אייפון", ["iphone 13"])).toBe(false);
    expect(isRelevant("Galaxy S23", ["iphone 13", "galaxy s23"])).toBe(true);
    expect(isRelevant("iPhone 13 mini", ["iphone 13"], ["mini"])).toBe(true);
    expect(isRelevant("iPhone 13", ["iphone 13"], ["mini"])).toBe(false);
  });
});

describe("stats", () => {
  it("computes quartiles", () => {
    expect(priceStats([100, 200, 300, 400, 500])).toMatchObject({ n: 5, min: 100, median: 300, p25: 200, p75: 400, max: 500 });
    expect(priceStats([])).toBeNull();
  });

  it("flags MAD outliers only with enough points", () => {
    expect([...madOutliers([800, 900, 950, 1000, 1000, 5550])]).toEqual([5550]);
    expect(madOutliers([1, 1000, 1000]).size).toBe(0);
  });

  it("haversine Tel Aviv -> Jerusalem is about 54 km", () => {
    const km = haversineKm(32.0853, 34.7818, 31.7683, 35.2137);
    expect(km).toBeGreaterThan(50);
    expect(km).toBeLessThan(58);
  });
});

describe("flags", () => {
  const detail = (description: string): ListingDetail =>
    ({ ...mk({}), description, photos: ["a", "b"], status: "AVAILABLE" }) as ListingDetail;

  it("flags too-good-to-be-true against the group median", () => {
    const f = redFlags(mk({ price: 300 }), { groupMedian: 1000 });
    expect(f.map((x) => x.code)).toContain("too_good_to_be_true");
  });

  it("flags buy requests, parts, prepayment and placeholders", () => {
    expect(redFlags(mk({ title: "מחפש אייפון 13" }), { groupMedian: null }).map((x) => x.code)).toContain("wanted_post");
    expect(redFlags(mk({ title: "iPhone 13 לחלקים" }), { groupMedian: null }).map((x) => x.code)).toContain("parts_or_broken");
    expect(redFlags(mk({ price: 1, priceText: "1 ₪" }), { groupMedian: 1000 }).map((x) => x.code)).toContain("placeholder_price");
    const codes = redFlags(mk({}), { groupMedian: 1000, detail: detail("שולח עם שליח, מקדמה בביט") }).map((x) => x.code);
    expect(codes).toContain("prepayment");
  });

  it("flags prices far below a supplied reference market price", () => {
    expect(redFlags(mk({ price: 700 }), { groupMedian: 800, referencePrice: 1800 }).map((x) => x.code)).toContain("far_below_reference");
    expect(redFlags(mk({ price: 1500 }), { groupMedian: 1500, referencePrice: 1800 })).toEqual([]);
  });

  it("flags accessories made for the product and modded consoles", () => {
    const codes = (title: string) => redFlags(mk({ title }), { groupMedian: 1000, productToken: "playstation" }).map((x) => x.code);
    expect(codes(normalizeText("כונן SSD 2TB למחשב ול-PS5"))).toContain("accessory_for_product");
    expect(codes(normalizeText("SSD for PS5"))).toContain("accessory_for_product");
    expect(codes(normalizeText("PS5 Slim 1TB"))).not.toContain("accessory_for_product");
    expect(codes("PS5 פרוץ")).toContain("modded");
    expect(codes(normalizeText("מעוניין בהחלפה על פלייסטיישן 5 פרו"))).toContain("trade_offer");
    expect(redFlags(mk({ title: normalizeText("מגן מסך לאייפון 13") }), { groupMedian: 1000, productToken: "iphone" }).map((x) => x.code)).toContain(
      "accessory_for_product",
    );
  });

  it("does not flag a normal listing", () => {
    expect(redFlags(mk({}), { groupMedian: 1000 })).toEqual([]);
    expect(redFlags(mk({}), { groupMedian: 1000, detail: detail("שמור מאוד, הקונה מקבל קופסה") })).toEqual([]);
  });
});

describe("compare", () => {
  it("groups the real fixture like-for-like and ranks deals", () => {
    const ls = extractListings(parseJsonBlocks(searchHtml));
    const r = compareListings(ls, { queries: ["iphone 13"], nowSec: 1_791_000_000 });
    expect(r.currency).toBe("ILS");
    expect(r.counts.fetched).toBe(24);
    // A bare "אייפון" title is not "iphone 13".
    expect(r.counts.irrelevant).toBeGreaterThanOrEqual(1);
    const variants = r.groups.map((g) => g.variant);
    expect(variants).toContain("pro · 256GB");
    expect(variants).toContain("mini · 512GB");
    expect(r.deals.length).toBeGreaterThan(0);
    for (let i = 1; i < r.deals.length; i++) expect(r.deals[i - 1].score).toBeGreaterThanOrEqual(r.deals[i].score);
    expect(r.notes.join(" ")).toMatch(/asking prices/);
  });

  it("excludes sold, excluded words, other currencies and collapses reposts", () => {
    const ls = [
      mk({ id: "a", price: 900 }),
      mk({ id: "b", price: 900, createdAt: 1_790_000_100 }), // repost of a
      mk({ id: "c", price: 1100, isSold: true }),
      mk({ id: "d", title: "iPhone 13 case", price: 50 }),
      mk({ id: "e", price: 300, currency: "USD" }),
      mk({ id: "f", price: 1000 }),
      mk({ id: "g", price: 1050, city: "x" }),
      mk({ id: "h", price: 1200, city: "y" }),
    ];
    const r = compareListings(ls, { queries: ["iphone 13"], exclude: ["case"], nowSec: 1_790_100_000 });
    expect(r.counts).toMatchObject({ unavailable: 1, excluded: 1, otherCurrency: 1, reposts: 1, analysed: 4 });
    const hebrew = compareListings([mk({ id: "x", title: "iPhone 13 + שלטים ומשחקים" }), mk({ id: "y" })], {
      queries: ["iphone 13"],
      exclude: ["משחק"],
    });
    expect(hebrew.counts.excluded).toBe(1);
    expect(r.deals[0].id).toBe("b");
    expect(r.deals[0].repostCount).toBe(1);
  });

  it("falls back to a tier benchmark for thin variants", () => {
    const ls = [
      mk({ id: "1", title: "iPhone 13 128GB", price: 1000 }),
      mk({ id: "2", title: "iPhone 13 128GB", price: 1100, city: "a" }),
      mk({ id: "3", title: "iPhone 13 256GB", price: 1200, city: "b" }),
      mk({ id: "4", title: "iPhone 13", price: 1050, city: "c" }),
    ];
    const r = compareListings(ls, { queries: ["iphone 13"] });
    expect(r.deals.find((d) => d.id === "3")!.benchmark?.level).toBe("tier");
  });

  it("does not call cheap items scams when the group mixes different products", () => {
    const prices = [200, 250, 300, 400, 500, 800, 900, 1200, 1500, 1800, 2500];
    const ls = prices.map((p, i) => mk({ id: `s${i}`, title: "ספה", price: p, city: `c${i}` }));
    const r = compareListings(ls, { queries: ["ספה"], topN: 30 });
    expect(r.suspicious).toEqual([]);
    expect(r.deals[0].price).toBe(200);
    expect(r.deals.at(-1)!.price).toBe(2500);
    expect(r.notes.join(" ")).toMatch(/spread widely/);
  });

  it("ranks a cheaper listing above a pricier one with a price cut", () => {
    const ls = [
      mk({ id: "cheap", price: 900, city: "a" }),
      mk({ id: "cut", price: 1150, previousPrice: 1600, city: "b" }),
      ...[1000, 1050, 1100, 1200].map((p, i) => mk({ id: `n${i}`, price: p, city: `n${i}` })),
    ];
    const r = compareListings(ls, { queries: ["iphone 13"] });
    expect(r.deals.findIndex((d) => d.id === "cheap")).toBeLessThan(r.deals.findIndex((d) => d.id === "cut"));
  });

  it("ranks a real discount above the cheapest of a thin, at-market group", () => {
    const ls = [
      // thin group: cheapest is only ~3% under its median
      mk({ id: "max1", title: "iPhone 13 Pro Max 256GB", price: 1450, city: "a" }),
      mk({ id: "max2", title: "iPhone 13 Pro Max 256GB", price: 1500, city: "b" }),
      mk({ id: "max3", title: "iPhone 13 Pro Max 256GB", price: 1550, city: "c" }),
      // bigger group with a genuine 20% discount
      ...[800, 1000, 1000, 1050, 1100, 1150].map((p, i) => mk({ id: `pro${i}`, title: "iPhone 13 Pro", price: p, city: `p${i}` })),
    ];
    const r = compareListings(ls, { queries: ["iphone 13"] });
    expect(r.deals[0].id).toBe("pro0");
  });

  it("moves high-severity listings to suspicious", () => {
    const ls = [mk({ id: "s", price: 200 }), ...[1, 2, 3, 4].map((i) => mk({ id: `n${i}`, price: 1000 + i * 50, city: `c${i}` }))];
    const r = compareListings(ls, { queries: ["iphone 13"] });
    expect(r.suspicious.map((s) => s.id)).toEqual(["s"]);
    expect(r.deals.map((d) => d.id)).not.toContain("s");
  });
});

describe("offer", () => {
  it("rounds to human prices and never offers above asking", () => {
    expect(roundNice(1234)).toBe(1250);
    expect(roundNice(187)).toBe(185);
    const o = suggestOffer(900, { n: 5, min: 800, p25: 900, median: 1000, p75: 1100, max: 1200, mean: 1000 });
    expect(o.verdict).toBe("below market");
    expect(o.fair).toBe(900);
    expect(o.opening).toBeLessThanOrEqual(900);
  });
});
