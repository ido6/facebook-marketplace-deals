// CSV (for Excel / Sheets) and a self-contained HTML page per comparison.

import fs from "node:fs";
import path from "node:path";
import type { ScoredListing } from "./core/analyze.js";
import type { CompareRun } from "./service.js";

const CSV_COLUMNS = [
  "bucket", "rank", "score", "title", "price", "wasPrice", "variant", "city", "ageDays", "condition",
  "distanceKm", "verdict", "vsMedianPct", "opening", "fair", "benchmarkMedian", "flags", "url",
] as const;

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  // Neutralise spreadsheet formula injection from seller-controlled titles.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function row(bucket: string, x: ScoredListing, rank: number | ""): string {
  return [
    bucket, rank, x.score, x.title, x.price, x.previousPrice, x.variant, x.city, x.ageDays, x.condition,
    x.distanceKm, x.offer?.verdict, x.offer?.vsMedianPct, x.offer?.opening, x.offer?.fair,
    x.benchmark?.stats.median, x.flags.map((f) => f.code).join(" "), x.url,
  ].map(csvCell).join(",");
}

export function toCsv(run: CompareRun): string {
  const lines = [CSV_COLUMNS.join(",")];
  run.result.deals.forEach((x, i) => lines.push(row("deal", x, i + 1)));
  run.result.suspicious.forEach((x) => lines.push(row("suspicious", x, "")));
  // BOM so Excel opens Hebrew correctly.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function card(x: ScoredListing, rank?: number): string {
  const flags = x.flags.map((f) => `<li class="${f.severity}">${esc(f.message)}</li>`).join("");
  const offer = x.offer
    ? `<p class="offer">${esc(x.offer.verdict)} (${x.offer.vsMedianPct > 0 ? "+" : ""}${x.offer.vsMedianPct}%) · open at <b>${x.offer.opening}</b> · fair ${x.offer.fair}</p>`
    : "";
  return `<article>
  <header><span class="score">${x.score}</span>${rank ? `<span class="rank">#${rank}</span>` : ""}
  <a dir="auto" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a></header>
  <p class="price">${esc(x.priceText || x.price)}${x.previousPrice ? ` <s>${x.previousPrice}</s>` : ""}</p>
  <p class="meta" dir="auto">${esc(x.variant)} · ${esc(x.city ?? "?")} · ${x.ageDays ?? "?"}d${x.condition ? ` · ${esc(x.condition)}` : ""}${x.distanceKm !== null ? ` · ${x.distanceKm} km` : ""}</p>
  ${offer}${flags ? `<ul class="flags">${flags}</ul>` : ""}
</article>`;
}

export function toHtml(run: CompareRun, title: string): string {
  const r = run.result;
  const groups = r.groups
    .map((g) => `<tr><td dir="auto">${esc(g.variant)}</td><td>${g.count}</td><td>${g.stats?.min ?? ""}</td><td>${g.stats?.p25 ?? ""}</td><td><b>${g.stats?.median ?? ""}</b></td><td>${g.stats?.p75 ?? ""}</td><td>${g.stats?.max ?? ""}</td></tr>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{--bg:#f6f4ef;--fg:#1d1b16;--muted:#6b665c;--card:#fff;--line:#e3ded3;--good:#1f7a4d;--bad:#b3261e;--warn:#9a6700}
@media (prefers-color-scheme:dark){:root{--bg:#15140f;--fg:#ece8df;--muted:#a39d90;--card:#1f1d17;--line:#36322a;--good:#5fd39a;--bad:#ff8a80;--warn:#f2c35b}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:24px 16px}
main{max-width:980px;margin:auto}h1{font-size:28px;margin:0 0 4px}h2{margin-top:32px;font-size:18px}
.sub{color:var(--muted);margin:0}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;background:var(--card)}
td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:start}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px}
article{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
article header{display:flex;gap:8px;align-items:baseline}article a{color:inherit;font-weight:600;text-decoration:none}
.score{background:var(--good);color:var(--bg);border-radius:6px;padding:0 6px;font-weight:700}.rank{color:var(--muted)}
.price{font-size:20px;font-weight:700;margin:6px 0 0}.meta{color:var(--muted);margin:2px 0}.offer{margin:6px 0 0}
.flags{margin:6px 0 0;padding-inline-start:18px}.high{color:var(--bad)}.medium{color:var(--warn)}.low{color:var(--muted)}
#sus .score{background:var(--bad)}</style></head><body><main>
<h1 dir="auto">${esc(title)}</h1>
<p class="sub">${r.counts.analysed} listings analysed of ${r.counts.fetched} fetched · ${esc(r.currency ?? "")} · ${new Date().toLocaleString("en-GB")} · asking prices, not sold prices</p>
<h2>Price by variant</h2><div class="scroll"><table><tr><th>Variant</th><th>n</th><th>min</th><th>p25</th><th>median</th><th>p75</th><th>max</th></tr>${groups}</table></div>
<h2>Best deals</h2><div class="grid">${r.deals.map((x, i) => card(x, i + 1)).join("")}</div>
<h2>Suspicious — avoid or verify in person</h2><div class="grid" id="sus">${r.suspicious.map((x) => card(x)).join("") || "<p>None.</p>"}</div>
</main></body></html>`;
}

export function writeReports(run: CompareRun, dir: string, title: string): { csv: string; html: string } {
  fs.mkdirSync(dir, { recursive: true });
  const slug = title.toLowerCase().replace(/[^a-z0-9֐-׿]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "compare";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const base = path.join(dir, `${stamp}-${slug}`);
  fs.writeFileSync(`${base}.csv`, toCsv(run), "utf8");
  fs.writeFileSync(`${base}.html`, toHtml(run, title), "utf8");
  return { csv: `${base}.csv`, html: `${base}.html` };
}
