#!/usr/bin/env node
// Turn a saved Marketplace page into a test fixture that is safe to commit.
//
// Raw pages carry session tokens, signed CDN URLs, real listing ids, seller
// identities and exact pickup coordinates. This keeps only the listing fields
// the parser reads, swaps every id for a fake one, replaces photo URLs with
// placeholders, rounds coordinates to ~1 km, and drops seller data.
//
//   node scripts/sanitize-fixture.mjs <raw.html> <out.html> [focalListingId] [--description "synthetic text"]

import fs from "node:fs";

const [input, output, focalId] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const descIdx = process.argv.indexOf("--description");
const syntheticDescription = descIdx > 0 ? process.argv[descIdx + 1] : null;
if (!input || !output) {
  process.stderr.write("usage: sanitize-fixture.mjs <raw.html> <out.html> [focalListingId] [--description text]\n");
  process.exit(1);
}

const html = fs.readFileSync(input, "utf8");
const docs = [...html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => {
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const fakeIds = new Map();
const fakeId = (real) => {
  if (!fakeIds.has(real)) fakeIds.set(real, String(9000000000000000 + fakeIds.size + 1));
  return fakeIds.get(real);
};
if (focalId) fakeId(focalId); // focal listing becomes 9000000000000001

let photo = 0;
const placeholder = () => `https://scontent.example.fbcdn.net/fixture/photo-${++photo}.jpg`;
const round = (n) => (typeof n === "number" ? Math.round(n * 100) / 100 : null);
const price = (p) =>
  p && {
    amount: p.amount ?? null,
    formatted_amount: p.formatted_amount ?? p.formatted_amount_zeros_stripped ?? null,
    ...(p.currency ? { currency: p.currency } : {}),
  };

function sanitizeListing(o) {
  const geo = o.location?.reverse_geocode;
  const out = {
    id: fakeId(o.id),
    marketplace_listing_title: o.marketplace_listing_title,
    listing_price: price(o.listing_price),
    strikethrough_price: price(o.strikethrough_price) ?? null,
    location: geo
      ? { reverse_geocode: { city: geo.city ?? null, city_page: geo.city_page ? { display_name: geo.city_page.display_name } : null } }
      : null,
    primary_listing_photo: o.primary_listing_photo ? { image: { uri: placeholder() } } : null,
    creation_time: o.creation_time ?? null,
    is_sold: Boolean(o.is_sold),
    is_pending: Boolean(o.is_pending),
    marketplace_listing_seller: null,
    delivery_types: o.delivery_types ?? [],
    marketplace_listing_category_id: o.marketplace_listing_category_id ?? null,
  };
  return out;
}

function sanitizeFocal(merged) {
  const coords = merged.location?.latitude !== undefined ? merged.location : merged.item_location;
  return {
    ...sanitizeListing({ ...merged, location: null }),
    location: coords ? { latitude: round(coords.latitude), longitude: round(coords.longitude) } : null,
    location_text: merged.location_text ? { text: merged.location_text.text } : null,
    redacted_description: { text: syntheticDescription ?? "(description removed from fixture)" },
    attribute_data: (merged.attribute_data ?? []).map((a) => ({ attribute_name: a.attribute_name, value: a.value, label: a.label })),
    listing_photos: (merged.listing_photos ?? []).map(() => ({ image: { uri: placeholder() } })),
    is_shipping_offered: Boolean(merged.is_shipping_offered),
    renderable_listing_status: merged.renderable_listing_status ?? null,
  };
}

const walk = (n, visit) => {
  if (!n || typeof n !== "object") return;
  if (Array.isArray(n)) return n.forEach((x) => walk(x, visit));
  visit(n);
  for (const k in n) walk(n[k], visit);
};

const listings = new Map();
const focal = {};
for (const doc of docs) {
  walk(doc, (o) => {
    if (typeof o.id !== "string") return;
    if (focalId && o.id === focalId) {
      for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && focal[k] === undefined) focal[k] = v;
      return;
    }
    if (typeof o.marketplace_listing_title === "string" && !listings.has(o.id)) listings.set(o.id, sanitizeListing(o));
  });
}

const blocks = [];
if (focalId) {
  if (!focal.marketplace_listing_title) throw new Error(`focal listing ${focalId} not found in ${input}`);
  blocks.push({ data: { focal: sanitizeFocal({ ...focal, id: focalId }) } });
}
blocks.push({ data: { listings: [...listings.values()] } });

const body = blocks.map((b) => `<script type="application/json">${JSON.stringify(b)}</script>`).join("\n");
fs.writeFileSync(output, `<html><body>\n${body}\n</body></html>\n`);
process.stderr.write(`wrote ${output}: ${listings.size} listings${focalId ? " + focal" : ""}, ${photo} placeholder photos\n`);
