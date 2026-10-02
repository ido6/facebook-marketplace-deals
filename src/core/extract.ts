// Pulls Marketplace listings out of Facebook's own embedded Relay JSON.
//
// We deliberately avoid the DOM and visible text: Facebook localises every UI
// string (Hebrew here) and reshuffles markup often, but the JSON payload keeps
// stable keys like `marketplace_listing_title` and `listing_price`. Reading it
// makes extraction locale-independent and immune to related-listing rails
// polluting the detail view (we select the focal object by id).

import type { Listing, ListingDetail } from "./types.js";

type Json = unknown;
type Obj = Record<string, any>;

const SCRIPT_JSON_RE = /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;

const SYMBOL_CURRENCY: Array<[RegExp, string]> = [
  [/₪|\bILS\b|ש"ח|ש״ח/, "ILS"],
  [/€|\bEUR\b/, "EUR"],
  [/£|\bGBP\b/, "GBP"],
  [/\bUSD\b|US\$|\$/, "USD"],
];

export function parseJsonBlocks(html: string): Json[] {
  const out: Json[] = [];
  for (const m of html.matchAll(SCRIPT_JSON_RE)) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      // Non-JSON or truncated block: irrelevant for listings.
    }
  }
  return out;
}

/** GraphQL responses arrive as `for (;;);`-prefixed, newline-delimited JSON documents. */
export function parseGraphqlPayload(text: string): Json[] {
  const out: Json[] = [];
  const body = text.replace(/^for\s*\(;;\);/, "");
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // Partial chunk: skip.
    }
  }
  return out;
}

function walk(node: Json, visit: (o: Obj) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) walk(x, visit);
    return;
  }
  visit(node as Obj);
  for (const k in node as Obj) walk((node as Obj)[k], visit);
}

export function currencyFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const [re, code] of SYMBOL_CURRENCY) if (re.test(text)) return code;
  return null;
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function priceFrom(p: Obj | null | undefined): { amount: number | null; text: string; currency: string | null } {
  if (!p) return { amount: null, text: "", currency: null };
  const text = String(p.formatted_amount ?? p.formatted_amount_zeros_stripped ?? "");
  let amount = toNumber(p.amount);
  if (amount === null && text) {
    const digits = text.replace(/[^\d.]/g, "");
    amount = toNumber(digits);
  }
  return { amount, text, currency: p.currency ? String(p.currency) : currencyFromText(text) };
}

function isListingObject(o: Obj): boolean {
  return typeof o.marketplace_listing_title === "string" && typeof o.id === "string";
}

export function toListing(o: Obj): Listing {
  const price = priceFrom(o.listing_price);
  const prev = priceFrom(o.strikethrough_price);
  const geo = o.location?.reverse_geocode;
  return {
    id: o.id,
    url: `https://www.facebook.com/marketplace/item/${o.id}/`,
    title: String(o.marketplace_listing_title).replace(/^‏/, "").trim(),
    price: price.amount,
    currency: price.currency,
    priceText: price.text,
    previousPrice: prev.amount,
    city: geo?.city_page?.display_name ?? geo?.city ?? null,
    imageUrl: o.primary_listing_photo?.image?.uri ?? null,
    createdAt: toNumber(o.creation_time),
    isSold: Boolean(o.is_sold),
    isPending: Boolean(o.is_pending),
    sellerName: o.marketplace_listing_seller?.name ?? null,
    sellerId: o.marketplace_listing_seller?.id ?? null,
    deliveryTypes: Array.isArray(o.delivery_types) ? o.delivery_types.map(String) : [],
    categoryId: o.marketplace_listing_category_id ?? null,
  };
}

/** Every distinct listing in the given JSON documents, in first-seen order. */
export function extractListings(docs: Json[]): Listing[] {
  const seen = new Map<string, Listing>();
  for (const doc of docs) {
    walk(doc, (o) => {
      if (isListingObject(o) && !seen.has(o.id)) seen.set(o.id, toListing(o));
    });
  }
  return [...seen.values()];
}

/** Merge every fragment describing `id`; a later null never erases an earlier value. */
function mergeFocal(docs: Json[], id: string): Obj {
  const merged: Obj = {};
  for (const doc of docs) {
    walk(doc, (o) => {
      if (o.id !== id) return;
      if (!("marketplace_listing_title" in o) && !("listing_photos" in o) && !("redacted_description" in o)) return;
      for (const [k, v] of Object.entries(o)) {
        if (v !== null && v !== undefined && merged[k] === undefined) merged[k] = v;
      }
    });
  }
  return merged;
}

export function extractDetail(docs: Json[], id: string): ListingDetail | null {
  const o = mergeFocal(docs, id);
  if (!o.marketplace_listing_title) return null;
  const base = toListing({ ...o, id });
  const attrs: ListingDetail["attributes"] = Array.isArray(o.attribute_data)
    ? o.attribute_data.map((a: Obj) => ({
        name: String(a.attribute_name ?? "").replace(/[‎‏]/g, ""),
        value: String(a.value ?? ""),
        label: String(a.label ?? ""),
      }))
    : [];
  const cond = attrs.find((a) => /^(new|used|refurbished)/i.test(a.value));
  const coords = o.location?.latitude !== undefined ? o.location : o.item_location;
  const photos: string[] = Array.isArray(o.listing_photos)
    ? o.listing_photos.map((p: Obj) => p?.image?.uri).filter(Boolean)
    : [];
  return {
    ...base,
    city: base.city ?? null,
    description: String(o.redacted_description?.text ?? ""),
    condition: cond?.value ?? null,
    conditionLabel: cond?.label ?? null,
    attributes: attrs,
    latitude: toNumber(coords?.latitude),
    longitude: toNumber(coords?.longitude),
    locationText: o.location_text?.text ?? null,
    photos,
    shippingOffered: Boolean(o.is_shipping_offered),
    status: o.renderable_listing_status ?? null,
  };
}
