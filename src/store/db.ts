// Local price history and saved watches, in Node's built-in SQLite (no native
// build step on Windows). Everything stays on this machine.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Listing } from "../core/types.js";

export interface PriceChange {
  id: string;
  title: string;
  from: number;
  to: number;
  url: string;
}

export interface SeenResult {
  newIds: string[];
  priceDrops: PriceChange[];
}

export interface WatchSpec {
  queries: string[];
  location: string;
  minPrice?: number;
  maxPrice?: number;
  mustInclude?: string[];
  exclude?: string[];
  conditions?: string[];
  /** Alert only when a deal is at or below this price. */
  targetPrice?: number;
}

export interface Watch {
  name: string;
  spec: WatchSpec;
  createdAt: number;
  lastChecked: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL, currency TEXT, city TEXT,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, last_price REAL, min_price REAL
);
CREATE TABLE IF NOT EXISTS prices (
  id TEXT NOT NULL, seen_at INTEGER NOT NULL, price REAL NOT NULL, PRIMARY KEY (id, seen_at)
);
CREATE TABLE IF NOT EXISTS watches (
  name TEXT PRIMARY KEY, spec TEXT NOT NULL, created_at INTEGER NOT NULL, last_checked INTEGER
);
CREATE TABLE IF NOT EXISTS watch_seen (
  watch TEXT NOT NULL, id TEXT NOT NULL, first_seen INTEGER NOT NULL, last_price REAL,
  PRIMARY KEY (watch, id)
);
`;

export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // The MCP server and a scheduled CLI run may share this file.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  /** Record a batch; report listings never seen before and price drops since the last sighting. */
  recordListings(listings: Listing[], now = Date.now()): SeenResult {
    const get = this.db.prepare("SELECT last_price FROM listings WHERE id = ?");
    const insert = this.db.prepare(
      "INSERT INTO listings (id, title, url, currency, city, first_seen, last_seen, last_price, min_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const update = this.db.prepare(
      // A missing price (extraction miss, "contact seller") must not erase the known one.
      "UPDATE listings SET title = ?, last_seen = ?, last_price = COALESCE(?, last_price), min_price = CASE WHEN ? IS NULL THEN min_price ELSE MIN(COALESCE(min_price, ?), ?) END WHERE id = ?",
    );
    const addPrice = this.db.prepare("INSERT OR IGNORE INTO prices (id, seen_at, price) VALUES (?, ?, ?)");
    const result: SeenResult = { newIds: [], priceDrops: [] };
    this.db.exec("BEGIN");
    try {
      for (const l of listings) {
        const row = get.get(l.id) as { last_price: number | null } | undefined;
        if (!row) {
          insert.run(l.id, l.title, l.url, l.currency, l.city, now, now, l.price, l.price);
          result.newIds.push(l.id);
          if (l.price !== null) addPrice.run(l.id, now, l.price);
          continue;
        }
        if (l.price !== null && row.last_price !== null && l.price < row.last_price) {
          result.priceDrops.push({ id: l.id, title: l.title, from: row.last_price, to: l.price, url: l.url });
        }
        if (l.price !== null && l.price !== row.last_price) addPrice.run(l.id, now, l.price);
        update.run(l.title, now, l.price, l.price, l.price, l.price, l.id);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return result;
  }

  history(id: string): { listing: Record<string, unknown> | null; prices: Array<{ seenAt: string; price: number }> } {
    const listing = (this.db.prepare("SELECT * FROM listings WHERE id = ?").get(id) as Record<string, unknown>) ?? null;
    const prices = (this.db.prepare("SELECT seen_at, price FROM prices WHERE id = ? ORDER BY seen_at").all(id) as Array<{
      seen_at: number;
      price: number;
    }>).map((r) => ({ seenAt: new Date(r.seen_at).toISOString(), price: r.price }));
    return { listing, prices };
  }

  searchHistory(text: string, limit = 50): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT id, title, url, city, last_price, min_price, first_seen, last_seen FROM listings WHERE title LIKE ? ORDER BY last_seen DESC LIMIT ?")
      .all(`%${text}%`, limit) as Array<Record<string, unknown>>;
  }

  saveWatch(name: string, spec: WatchSpec, now = Date.now()): void {
    this.db
      .prepare("INSERT INTO watches (name, spec, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET spec = excluded.spec")
      .run(name, JSON.stringify(spec), now);
  }

  removeWatch(name: string): boolean {
    this.db.prepare("DELETE FROM watch_seen WHERE watch = ?").run(name);
    return Number(this.db.prepare("DELETE FROM watches WHERE name = ?").run(name).changes) > 0;
  }

  listWatches(): Watch[] {
    return (this.db.prepare("SELECT * FROM watches ORDER BY name").all() as Array<Record<string, any>>).map((r) => ({
      name: r.name,
      spec: JSON.parse(r.spec),
      createdAt: r.created_at,
      lastChecked: r.last_checked ?? null,
    }));
  }

  /** Per-watch novelty: new to this watch, or cheaper than when this watch last saw it. */
  markWatchSeen(watch: string, listings: Listing[], now = Date.now()): SeenResult {
    const get = this.db.prepare("SELECT last_price FROM watch_seen WHERE watch = ? AND id = ?");
    const upsert = this.db.prepare(
      "INSERT INTO watch_seen (watch, id, first_seen, last_price) VALUES (?, ?, ?, ?) ON CONFLICT(watch, id) DO UPDATE SET last_price = COALESCE(excluded.last_price, last_price)",
    );
    const firstRun = !(this.db.prepare("SELECT last_checked FROM watches WHERE name = ?").get(watch) as any)?.last_checked;
    const result: SeenResult = { newIds: [], priceDrops: [] };
    this.db.exec("BEGIN");
    try {
      for (const l of listings) {
        const row = get.get(watch, l.id) as { last_price: number | null } | undefined;
        if (!row) result.newIds.push(l.id);
        else if (l.price !== null && row.last_price !== null && l.price < row.last_price) {
          result.priceDrops.push({ id: l.id, title: l.title, from: row.last_price, to: l.price, url: l.url });
        }
        upsert.run(watch, l.id, now, l.price);
      }
      this.db.prepare("UPDATE watches SET last_checked = ? WHERE name = ?").run(now, watch);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    // The first check establishes a baseline; everything would otherwise look "new".
    return firstRun ? { newIds: [], priceDrops: [] } : result;
  }

  stats(): { listings: number; watches: number } {
    const n = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n);
    return { listings: n("SELECT COUNT(*) AS n FROM listings"), watches: n("SELECT COUNT(*) AS n FROM watches") };
  }

  close(): void {
    this.db.close();
  }
}
