#!/usr/bin/env node
// Command line entry for runs without an AI in the loop (e.g. Windows Task
// Scheduler checking watches every morning). Output goes to stdout as text;
// reports are written to the reports directory.
//
//   fbmp login
//   fbmp status
//   fbmp compare "iphone 13" "אייפון 13" [--location telaviv] [--min 800] [--max 2500] [--exclude case] [--report]
//   fbmp check-watches [name]

import { parseArgs } from "node:util";
import { config } from "./config.js";
import { MarketplaceSession, NotAuthenticatedError, BlockedError } from "./browser/session.js";
import { Store } from "./store/db.js";
import { compactRun, runCompare, runWatchCheck } from "./service.js";
import { writeReports } from "./report.js";

const out = (s: string) => process.stdout.write(s + "\n");

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      location: { type: "string" },
      min: { type: "string" },
      max: { type: "string" },
      exclude: { type: "string", multiple: true },
      include: { type: "string", multiple: true },
      reference: { type: "string" },
      report: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const [cmd, ...args] = positionals;
  const session = new MarketplaceSession();
  const store = new Store(config.dbPath);
  try {
    switch (cmd) {
      case "login": {
        out("A browser window is opening. Log in to Facebook there; this waits up to 10 minutes.");
        out((await session.login(10 * 60 * 1000)) ? "Logged in. Session saved." : "Login not detected.");
        return 0;
      }
      case "status": {
        out(JSON.stringify({ loggedIn: await session.isLoggedIn(), ...store.stats(), location: config.location }, null, 1));
        return 0;
      }
      case "compare": {
        if (!args.length) throw new Error('Usage: compare "query one" ["query two" ...]');
        const num = (v?: string) => {
          if (v === undefined) return undefined;
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0) throw new Error(`Not a valid number: "${v}"`);
          return n;
        };
        const run = await runCompare(session, store, {
          queries: args,
          location: values.location,
          minPrice: num(values.min),
          maxPrice: num(values.max),
          exclude: values.exclude,
          mustInclude: values.include,
          referencePrice: num(values.reference),
        });
        if (values.json) out(JSON.stringify(compactRun(run), null, 1));
        else {
          const r = run.result;
          out(`${r.counts.analysed}/${r.counts.fetched} listings · overall median ${r.overall?.median ?? "?"} ${r.currency ?? ""}`);
          for (const g of r.groups) out(`  ${g.variant.padEnd(22)} n=${g.count}  median=${g.stats?.median ?? "-"}`);
          out("Best deals:");
          r.deals.forEach((d, i) =>
            out(`  ${i + 1}. [${d.score}] ${d.priceText} ${d.title} (${d.city ?? "?"}) ${d.offer ? `· ${d.offer.verdict}, open at ${d.offer.opening}` : ""}\n     ${d.url}`),
          );
          if (r.suspicious.length) out(`Suspicious: ${r.suspicious.length} (see report)`);
        }
        if (values.report) out(JSON.stringify(writeReports(run, config.reportsDir, args[0])));
        return 0;
      }
      case "check-watches": {
        const watches = store.listWatches().filter((w) => !args[0] || w.name === args[0]);
        if (!watches.length) throw new Error("No watches saved. Add one through the marketplace_watch MCP tool.");
        for (const w of watches) {
          const c = await runWatchCheck(session, store, w);
          out(`# ${c.watch}${c.baseline ? " (baseline set)" : ""}`);
          out(`  new: ${c.newListings.length}  price drops: ${c.priceDrops.length}  at/below target: ${c.hitsAtOrBelowTarget.length}`);
          for (const n of c.newListings) out(`  NEW  ${n.price} ${n.title}  ${n.url}`);
          for (const p of c.priceDrops) out(`  DROP ${p.from} -> ${p.to} ${p.title}  ${p.url}`);
          for (const h of c.hitsAtOrBelowTarget) out(`  HIT  ${h.price} ${h.title}  ${h.url}`);
        }
        return 0;
      }
      default:
        out("Commands: login | status | compare <queries...> [--location x --min n --max n --exclude w --include w --reference n --report --json] | check-watches [name]");
        return cmd ? 1 : 0;
    }
  } catch (e) {
    process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
    // Distinct exit code so a scheduler can tell "session expired" from "nothing found".
    return e instanceof NotAuthenticatedError || e instanceof BlockedError ? 2 : 1;
  } finally {
    await session.close();
    store.close();
  }
}

process.exit(await main());
