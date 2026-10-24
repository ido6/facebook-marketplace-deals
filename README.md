# Facebook Marketplace deal finder (MCP server + Claude skill)

Search Facebook Marketplace from Claude, compare prices like-for-like, flag scams, suggest opening offers, and watch for new listings and price drops. Built for Israel (Hebrew + English titles, ₪), works anywhere.

- **MCP server** (`dist/index.js`): 8 `marketplace_*` tools, registered in Claude Code as `facebook-marketplace`.
- **Skill** `marketplace-deals` (`skills/marketplace-deals/`, install into `~/.claude/skills/`): the buying workflow (queries → baseline → compare → photo check → report → watch).
- **CLI** (`dist/cli.js`): the same engine without an AI, for Windows Task Scheduler.

## How it works

A dedicated Playwright Chromium profile (`~/.fb-marketplace-mcp/profile`, not your everyday Chrome) loads Marketplace pages at human pace (2.5–5 s jitter, one tab, no parallelism). Listings are read from Facebook's embedded Relay JSON (`marketplace_listing_title`, `listing_price`, …) rather than the DOM, so extraction does not depend on the UI language. Item pages select the focal listing by id, so the "related listings" rail cannot pollute details or photos.

Logged out, each search page returns about 24 listings, so `marketplace_compare` sweeps every query variant × sort order (relevance, cheapest, newest) and merges: typically 100+ unique listings from 6 pages. Logging in (optional, once) adds scroll pagination and seller names.

Built on lessons from [jdcodes1/facebook-marketplace-mcp](https://github.com/jdcodes1/facebook-marketplace-mcp) (macOS-only Chrome cookie extraction; per the car-hunter fork, its GraphQL `doc_id` search started returning empty listings), the [car-hunter fork](https://github.com/Abercrombie35/car-hunter) (switched to embedded-JSON parsing, focal-object detail fix) and [weimar-torres-herrera/facebook-marketplace-mcp](https://github.com/weimar-torres-herrera/facebook-marketplace-mcp) (Playwright persistent profile; DOM parsing with six known defects). Ideas reimplemented, no code copied.

## Tools

| Tool | Use |
|---|---|
| `marketplace_status` | Login state, config, DB size |
| `marketplace_login` | Opens a window; **you** log in (credentials are never typed by Claude) |
| `marketplace_search` | One raw search with filters (price, condition, days, sort) |
| `marketplace_listing` | Full detail + photos returned as images for Claude to inspect |
| `marketplace_compare` | The main tool: sweep, relevance filter, like-for-like groups (`pro · 256GB`), stats per variant, deal score, scam flags, opening offer, CSV/HTML report |
| `marketplace_watch` | Save / list / remove a watch with a target price |
| `marketplace_check_watches` | New listings, price drops, target hits since the last check |
| `marketplace_price_history` | Local price history per listing or by title |

Scam / quality flags: too cheap vs a tight group or a supplied reference price, deposit / prepayment, parts / broken / iCloud-locked, replica, jailbroken, "accessory for X", buy requests ("מחפש"), placeholder prices (₪1, ₪123), sold/pending, few photos, far pickup-only, reposts.

## Setup

Requires Node.js 22.13+ (uses the built-in `node:sqlite`).

```bash
git clone https://github.com/ido6/facebook-marketplace-deals.git
cd facebook-marketplace-deals
npm install
npx playwright install chromium
npm run build
claude mcp add --scope user facebook-marketplace -e FBMP_LOCATION=telaviv -- node "/absolute/path/to/facebook-marketplace-deals/dist/index.js"
```

Install the skill by copying `skills/marketplace-deals/` into `~/.claude/skills/` (Windows: `%USERPROFILE%\.claude\skills\`). Start a new Claude Code session so the tools and skill load, then ask e.g. "find me the best used PS5 in Tel Aviv".

Optional login (more results, seller names): ask Claude to run `marketplace_login`, or `node dist/cli.js login`.

### Configuration (env)

| Variable | Default | |
|---|---|---|
| `FBMP_LOCATION` | `telaviv` | City name (English/Hebrew), slug, or numeric id |
| `FBMP_HOME_LAT` / `FBMP_HOME_LNG` | – | Your location, for distance scoring |
| `FBMP_HEADLESS` | `1` | `0` to watch the browser |
| `FBMP_LOCALE` / `FBMP_TIMEZONE` | `he-IL` / `Asia/Jerusalem` | |
| `FBMP_MIN_DELAY_MS` / `FBMP_MAX_DELAY_MS` | `2500` / `5000` | Keep them; human pace is the point |
| `FBMP_MAX_PAGES` | `12` | Page-load cap per compare |
| `FBMP_HOME` | `~/.fb-marketplace-mcp` | Profile, SQLite DB, reports |

Locations: Facebook has vanity slugs only for some cities (`telaviv`, `jerusalem`, `beersheba`, `ashdod`, `netanya`, `raanana`, `rehovot`, `modiin`, `eilat`); others are mapped to numeric city ids in `src/browser/urls.ts` (Petah Tikva, Rishon, Ramat Gan, Holon, Herzliya, Kfar Saba, …). For any other city, open Marketplace, set the location, and copy the number from `facebook.com/marketplace/<id>/`. An unknown slug fails fast with that hint.

## CLI

Comparisons return the four highest-ranked qualifying deals by default, or fewer when fewer qualify. All fetched qualifying listings still contribute to the price benchmarks. The first four candidates receive detail checks before re-ranking; final replacements may not have detail checks. MCP callers can override `top_n` and `enrich_top`. Watch checks continue to process every ranked listing.

```bash
node dist/cli.js compare "iphone 13 pro" "אייפון 13 פרו" --location "Tel Aviv" --min 800 --exclude כיסוי --report
node dist/cli.js check-watches
```

Exit code 2 = Facebook session expired / security check (run `login`); 1 = other error.

## Development

```bash
npm test           # vitest, fixtures captured from the live site
npm run typecheck
npm run build
```

`src/core` is pure (no I/O) and fixture-tested; `src/browser` is the only Playwright code; stdout belongs to MCP, so logs go to stderr (`src/log.ts`).

## Limits and risk

- Automating Facebook is against its Terms of Service. This tool is read-only, slow by design, and uses no stealth tricks; the account risk is low but not zero. Heavy use can trigger security checks.
- Facebook changes its payload occasionally. Extraction keys off stable JSON field names; if results go empty, save a fresh search page's HTML and turn it into a fixture with `node scripts/sanitize-fixture.mjs raw.html test/fixtures/new.html` (strips tokens, real ids, seller data, photo URLs and exact coordinates; never commit raw pages), then run the tests.
- Prices are asking prices, not sold prices. Benchmarks need several listings per variant; thin variants fall back to tier-level or overall medians (`benchmark.level`).
- Messaging sellers and paying stay with you: Claude only drafts messages.

## License

MIT. Not affiliated with or endorsed by Meta. Use it for your own shopping, at your own risk.
