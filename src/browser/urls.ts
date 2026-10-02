// Marketplace URL construction. Parameter names verified against the live site
// (2026-10-02): minPrice/maxPrice/sortBy/itemCondition/daysSinceListed are honoured.
// radius is passed in km; Facebook ignores it for logged-out sessions.

export type SortOrder = "relevance" | "price_asc" | "price_desc" | "newest" | "nearest";
export type Condition = "new" | "used_like_new" | "used_good" | "used_fair";

const SORT_PARAM: Record<SortOrder, string | null> = {
  relevance: null,
  price_asc: "price_ascend",
  price_desc: "price_descend",
  newest: "creation_time_descend",
  nearest: "distance_ascend",
};

export interface SearchParams {
  query: string;
  location: string;
  minPrice?: number;
  maxPrice?: number;
  sort?: SortOrder;
  conditions?: Condition[];
  daysSinceListed?: 1 | 7 | 30;
  radiusKm?: number;
}

const LOCATION_RE = /^[a-z0-9-]{2,40}$/i;

// Verified against the live site on 2026-10-02. Facebook only has vanity slugs
// for some cities; an unknown slug silently redirects to an empty category
// page, so every other city goes by its numeric city-page id.
const CITY_LOCATIONS: Array<[string[], string]> = [
  [["telaviv", "tel aviv", "tel-aviv", "תל אביב", "תל אביב-יפו", "תל אביב יפו"], "telaviv"],
  [["jerusalem", "ירושלים"], "jerusalem"],
  [["beersheba", "beer sheva", "beersheva", "באר שבע"], "beersheba"],
  [["ashdod", "אשדוד"], "ashdod"],
  [["netanya", "נתניה"], "netanya"],
  [["raanana", "רעננה"], "raanana"],
  [["rehovot", "רחובות"], "rehovot"],
  [["modiin", "מודיעין"], "modiin"],
  [["eilat", "אילת"], "eilat"],
  [["petah tikva", "petahtikva", "petah tiqwa", "פתח תקווה", "פתח תקוה"], "104047936296918"],
  [["rishon lezion", "rishonlezion", "rishon", "ראשון לציון"], "109394745753748"],
  [["ramat gan", "ramatgan", "רמת גן"], "112604772085346"],
  [["holon", "חולון"], "114283675255321"],
  [["herzliya", "הרצליה"], "110681962293188"],
  [["kfar saba", "kfarsaba", "כפר סבא"], "114269838585202"],
  [["bat yam", "batyam", "בת ים"], "103113623062213"],
  [["givatayim", "גבעתיים"], "103762516328742"],
  [["hod hasharon", "הוד השרון"], "108132892547596"],
  [["ramat hasharon", "רמת השרון"], "112393695438740"],
  [["ness ziona", "נס ציונה"], "104039899632072"],
  [["rosh haayin", "ראש העין"], "109026929117784"],
  [["lod", "לוד"], "110566075631241"],
  [["kiryat ono", "קריית אונו", "קרית אונו"], "115137745166546"],
  [["shoham", "שוהם"], "104339746270495"],
];

const CITY_INDEX = new Map(CITY_LOCATIONS.flatMap(([names, loc]) => names.map((n) => [n, loc] as const)));

/** Accepts a known city name (English or Hebrew), a Marketplace slug, or a numeric location id. */
export function resolveLocation(input: string): string {
  const key = input.trim().toLowerCase().replace(/\s+/g, " ");
  const known = CITY_INDEX.get(key);
  if (known) return known;
  if (!LOCATION_RE.test(key)) {
    throw new Error(
      `Unknown location "${input}". Use a known Israeli city name, a Marketplace slug like "telaviv", or the numeric id from a Marketplace URL (facebook.com/marketplace/<id>/...).`,
    );
  }
  return key;
}

export function assertLocation(location: string): string {
  return resolveLocation(location);
}

export function buildSearchUrl(p: SearchParams): string {
  const q = new URLSearchParams({ query: p.query.trim(), exact: "false" });
  if (p.minPrice !== undefined) q.set("minPrice", String(Math.max(0, Math.floor(p.minPrice))));
  if (p.maxPrice !== undefined) q.set("maxPrice", String(Math.max(0, Math.ceil(p.maxPrice))));
  const sort = SORT_PARAM[p.sort ?? "relevance"];
  if (sort) q.set("sortBy", sort);
  if (p.conditions?.length) q.set("itemCondition", p.conditions.join(","));
  if (p.daysSinceListed) q.set("daysSinceListed", String(p.daysSinceListed));
  if (p.radiusKm) q.set("radius", String(Math.round(p.radiusKm)));
  return `https://www.facebook.com/marketplace/${assertLocation(p.location)}/search?${q.toString()}`;
}

const ITEM_ID_RE = /marketplace\/item\/(\d{6,25})/;

/** Accepts a bare id or any Marketplace item URL. */
export function normalizeListingId(target: string): string {
  const t = target.trim();
  if (/^\d{6,25}$/.test(t)) return t;
  const m = t.match(ITEM_ID_RE);
  if (m) return m[1];
  throw new Error(`Could not read a Marketplace listing id from "${target}".`);
}

export function itemUrl(id: string): string {
  return `https://www.facebook.com/marketplace/item/${normalizeListingId(id)}/`;
}
