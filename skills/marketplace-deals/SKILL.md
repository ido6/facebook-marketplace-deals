---
name: marketplace-deals
description: Hunt the best-priced deal on Facebook Marketplace via the facebook-marketplace MCP tools. Use when the user wants to buy something used / second-hand, compare Marketplace prices, find "the cheapest X near me", check whether a listing is a fair price or a scam, or watch for new listings and price drops (also Hebrew: יד שנייה, מרקטפלייס, הכי זול, מחיר הוגן).
---

# Marketplace deals

Turn "find me a good X" into a ranked, scam-screened shortlist with fair prices and opening offers. All data comes from the `facebook-marketplace` MCP server (tools `marketplace_*`). If those tools are missing, tell the user the server is not connected (`claude mcp get facebook-marketplace`) and stop.

Hard guardrails: the user types their own Facebook password (`marketplace_login` only opens the window); Claude drafts messages but the user sends them and pays. Never recommend paying a deposit or paying before seeing the item.

## Steps

1. **Pin the target.** Product, exact variant (model, storage, size, year), budget, city, acceptable condition. Ask one short question only when the variant changes the price a lot and the user left it open (e.g. "iPhone 13 or 13 Pro? 128 or 256GB?"); otherwise default: city `telaviv` (or the user's city slug), any condition. Done when you can name the variant in one line.

2. **Write the queries the way sellers write titles.** 2–4 variants mixing Hebrew and English plus common spellings: `["iphone 13 pro", "אייפון 13 פרו"]`, `["ps5", "playstation 5", "פלייסטיישן 5"]`. Add `exclude` for accessories and junk (`case`, `כיסוי`, `box`, `קופסה`, `parts`, `לחלקים`), `must_include` for a tier word when the user wants that tier only, and a `min_price` that cuts accessories. More examples: [reference.md](reference.md#queries).

3. **Get a market baseline outside Marketplace.** WebSearch the new retail price (zap.co.il, KSP, Ivory, Bug for Israel; the official store elsewhere) and, if findable, a typical used price. Pass that used price as `reference_price` only when the queries target a single variant; mixed variants would make it misfire.

4. **Run `marketplace_compare`** with the queries, filters, `reference_price`, `export_report: true`. Done when `counts.analysed` ≥ 15. If it is lower, widen once: more spellings, drop `must_include`/`conditions`, raise `max_price`, or try a neighbouring city slug; then accept what you have and say the sample is thin.

5. **Inspect the shortlist.** For the top 3–5 `bestDeals` (skip any whose flags you would already reject), call `marketplace_listing` with `include_photos: 3`. Look at the photos yourself: does the item match the title and variant, real photo or stock/catalogue image, visible damage, screen burn, serial/model visible? Read the description for battery health, warranty, receipt, reason for selling, accessories included. Done when every shortlisted listing has a verdict: buy-worthy, ask-first (with the exact question), or reject (with the reason).

6. **Report** using the layout in [reference.md](reference.md#report): market snapshot per variant, the shortlist table, what to avoid and why, opening offer + fair price per pick, a ready-to-paste Hebrew (or English) message per pick, the retail baseline ("used saves N% vs new"), and the HTML/CSV report paths. State that medians are asking prices, not sold prices.

7. **Offer a watch.** If nothing is great yet, or the user is not in a hurry, offer `marketplace_watch` (`action: add`) carrying the same `queries`, `exclude`, `must_include`, `min_price` and `location` as the compare, with `target_price` = the fair price of the variant they want. Run `marketplace_check_watches` once to set the baseline; later checks report only new listings, price drops and new target hits. For recurring checks see [reference.md](reference.md#scheduling).

## Reading the compare output

- Return up to four best deals by default. Inspect every final pick; if a candidate fails inspection, fetch more candidates with `top_n` and inspect replacements. Never pad the shortlist with unsuitable listings. State when fewer than four qualify. Respect an explicit user-requested count.

- `groups` are like-for-like variants (`pro · 256GB`); compare a listing only against its own variant. `benchmark.level` = `tier` or `all` means its variant was too thin and the median is a rougher yardstick.
- `suspicious` holds high-severity flags (too cheap vs the group or reference, prepayment/deposit, parts/broken/locked, replica, buy requests, sold). Mention the pattern, do not shortlist them.
- `placeholderPrices` (₪1, ₪123…) are sellers gaming the sort; real price unknown, only worth a message if the item is rare.
- `reposts` > 0 means the seller keeps re-listing: often room to negotiate.
- `meta.loggedIn: false` caps each page at ~24 results; if coverage looks thin, suggest `marketplace_login` (one-time, the user logs in in the window).
- `meta.priceDrops` and `marketplace_price_history` show listings that got cheaper since earlier runs.
