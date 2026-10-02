// One persistent Chromium profile shared by every tool.
//
// The profile is dedicated (not the user's everyday Chrome): the user logs in
// by hand once via `login()`, and cookies live in that directory. We never
// read, decrypt or type credentials. Logged out still works for search (24
// results per page); logged in adds scroll pagination and seller names.

import fs from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright";
import { config } from "../config.js";
import { extractDetail, extractListings, parseGraphqlPayload, parseJsonBlocks } from "../core/extract.js";
import type { Listing, ListingDetail } from "../core/types.js";
import { log } from "../log.js";
import { itemUrl, normalizeListingId } from "./urls.js";

export class NotAuthenticatedError extends Error {}
export class BlockedError extends Error {}
export class UnknownLocationError extends Error {}

const SCROLL_PAUSE_MS = 2200;
const LOGIN_POLL_MS = 2000;
const IDLE_CLOSE_MS = 2 * 60 * 1000;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

interface CacheEntry<T> {
  at: number;
  value: T;
}

export interface SearchPage {
  url: string;
  listings: Listing[];
  loggedIn: boolean;
  fromCache: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MarketplaceSession {
  private ctx: BrowserContext | null = null;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private lastNav = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private searchCache = new Map<string, CacheEntry<Listing[]>>();
  private detailCache = new Map<string, CacheEntry<ListingDetail>>();
  private idleTimer: NodeJS.Timeout | null = null;
  private closing = false;
  /** True when another process (CLI run, second Claude session) holds the profile and we fell back to a fresh logged-out browser. */
  profileLocked = false;

  /**
   * Serialise all browser work: one tab, human pace, never parallel. After
   * IDLE_CLOSE_MS without work the browser closes, releasing the profile so a
   * scheduled CLI run or another Claude session can use it.
   */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Marketplace session is shutting down."));
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined).then(() => this.armIdleClose());
    return run;
  }

  private armIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.ctx) return;
    this.idleTimer = setTimeout(() => void this.exclusive(() => this.closeNow()).catch(() => undefined), IDLE_CLOSE_MS);
    this.idleTimer.unref();
  }

  private async context(): Promise<BrowserContext> {
    if (this.ctx) return this.ctx;
    fs.mkdirSync(config.profileDir, { recursive: true });
    const options = {
      headless: config.headless,
      locale: config.locale,
      timezoneId: config.timezone,
      viewport: { width: 1366, height: 900 },
    };
    try {
      this.ctx = await chromium.launchPersistentContext(config.profileDir, options);
      this.profileLocked = false;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/Executable doesn't exist/i.test(msg)) {
        throw new Error("Chromium is not installed. Run: npx playwright install chromium");
      }
      if (!/ProcessSingleton|in use|lock|already running/i.test(msg)) throw e;
      // Profile held elsewhere: degrade to a throwaway logged-out browser, which still searches fine.
      log.warn("profile in use by another process; using a temporary logged-out browser");
      this.browser = await chromium.launch({ headless: config.headless });
      this.ctx = await this.browser.newContext(options);
      this.profileLocked = true;
    }
    this.ctx.setDefaultTimeout(config.navTimeoutMs);
    this.ctx.on("close", () => {
      this.ctx = null;
      this.page = null;
    });
    return this.ctx;
  }

  private async tab(): Promise<Page> {
    const ctx = await this.context();
    if (!this.page || this.page.isClosed()) this.page = ctx.pages()[0] ?? (await ctx.newPage());
    return this.page;
  }

  private async throttle(): Promise<void> {
    const wait = config.minDelayMs + Math.random() * (config.maxDelayMs - config.minDelayMs);
    const elapsed = Date.now() - this.lastNav;
    if (elapsed < wait) await sleep(wait - elapsed);
    this.lastNav = Date.now();
  }

  /** Must run inside exclusive(): it may launch the browser. */
  private async loggedInNow(): Promise<boolean> {
    const ctx = await this.context();
    const cookies = await ctx.cookies("https://www.facebook.com");
    return cookies.some((c) => c.name === "c_user");
  }

  isLoggedIn(): Promise<boolean> {
    return this.exclusive(() => this.loggedInNow());
  }

  private async goto(url: string): Promise<{ page: Page; html: string }> {
    await this.throttle();
    const page = await this.tab();
    log.info(`GET ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.navTimeoutMs });
    await page.waitForTimeout(1500);
    const finalUrl = page.url();
    if (/\/(login|checkpoint|recover)\b/.test(finalUrl)) {
      throw new NotAuthenticatedError(
        `Facebook redirected to ${finalUrl}. Run the marketplace_login tool and log in again in the window that opens.`,
      );
    }
    const html = await page.content();
    if (/captcha|security check|temporarily blocked|you.re temporarily/i.test(await page.title())) {
      throw new BlockedError("Facebook is showing a security check. Stop for a while, then log in manually via marketplace_login.");
    }
    return { page, html };
  }

  /**
   * One search page. Logged in, scroll to pull more results from the GraphQL
   * feed until `maxResults` or the feed stops growing. Logged out, Facebook
   * shows a login wall on scroll, so we take the first page only.
   */
  search(url: string, maxResults = 24): Promise<SearchPage> {
    return this.exclusive(async () => {
      const key = `${maxResults}|${url}`;
      const hit = this.searchCache.get(key);
      if (hit && Date.now() - hit.at < config.cacheTtlMs) {
        return { url, listings: hit.value, loggedIn: await this.loggedInNow(), fromCache: true };
      }
      const graphqlDocs: unknown[] = [];
      const onResponse = async (r: Response) => {
        if (!r.url().includes("/api/graphql")) return;
        try {
          const text = await r.text();
          if (text.includes("marketplace_listing_title")) graphqlDocs.push(...parseGraphqlPayload(text));
        } catch {
          // Body unavailable (navigation raced it): harmless.
        }
      };
      const page = await this.tab();
      page.on("response", onResponse);
      try {
        const { html } = await this.goto(url);
        if (/\/marketplace\/category\/search/.test(page.url()) && !url.includes("/category/")) {
          throw new UnknownLocationError(
            `Facebook does not recognise the location in ${url} (it redirected to an empty page). Use a numeric location id from a Marketplace URL.`,
          );
        }
        const loggedIn = await this.loggedInNow();
        const initialDocs = parseJsonBlocks(html);
        let listings = extractListings([...initialDocs, ...graphqlDocs]);
        if (loggedIn) {
          let stale = 0;
          while (listings.length < maxResults && stale < 2) {
            await page.mouse.wheel(0, 4000);
            await page.waitForTimeout(SCROLL_PAUSE_MS + Math.random() * 800);
            const next = extractListings([...initialDocs, ...graphqlDocs]);
            stale = next.length > listings.length ? 0 : stale + 1;
            listings = next;
          }
        }
        listings = listings.slice(0, maxResults);
        this.searchCache.set(key, { at: Date.now(), value: listings });
        return { url, listings, loggedIn, fromCache: false };
      } finally {
        page.off("response", onResponse);
      }
    });
  }

  detail(target: string): Promise<ListingDetail> {
    const id = normalizeListingId(target);
    return this.exclusive(async () => {
      const hit = this.detailCache.get(id);
      if (hit && Date.now() - hit.at < config.cacheTtlMs) return hit.value;
      const { html } = await this.goto(itemUrl(id));
      const d = extractDetail(parseJsonBlocks(html), id);
      if (!d) throw new Error(`Listing ${id} not found: it may be removed, sold, or restricted to logged-in users.`);
      this.detailCache.set(id, { at: Date.now(), value: d });
      return d;
    });
  }

  /** Download photos with the session's cookies. Returns base64 JPEG/PNG/WebP. */
  photos(urls: string[]): Promise<Array<{ data: string; mimeType: string }>> {
    return this.exclusive(async () => {
      const ctx = await this.context();
      const out: Array<{ data: string; mimeType: string }> = [];
      for (const u of urls) {
        if (!/^https:\/\/[a-z0-9.-]+\.fbcdn\.net\//i.test(u)) continue; // only Facebook's CDN
        const r = await ctx.request.get(u, { timeout: 30000, maxRedirects: 0 });
        if (!r.ok() || Number(r.headers()["content-length"] ?? 0) > MAX_PHOTO_BYTES) {
          log.warn(`photo ${r.status()} ${u.slice(0, 80)}`);
          continue;
        }
        const mimeType = (r.headers()["content-type"] ?? "image/jpeg").split(";")[0];
        out.push({ data: (await r.body()).toString("base64"), mimeType });
      }
      return out;
    });
  }

  /**
   * Open a visible window so the user can log in themselves. Resolves once the
   * session cookie appears or the timeout passes. We never touch the form.
   */
  login(timeoutMs = 5 * 60 * 1000): Promise<boolean> {
    return this.exclusive(async () => {
      await this.closeNow();
      fs.mkdirSync(config.profileDir, { recursive: true });
      const ctx = await chromium.launchPersistentContext(config.profileDir, {
        headless: false,
        locale: config.locale,
        timezoneId: config.timezone,
        viewport: { width: 1200, height: 860 },
      });
      try {
        const page = ctx.pages()[0] ?? (await ctx.newPage());
        await page.goto("https://www.facebook.com/marketplace/", { waitUntil: "domcontentloaded" });
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (page.isClosed()) return false; // user closed the window
          const cookies = await ctx.cookies("https://www.facebook.com").catch(() => []);
          if (cookies.some((c) => c.name === "c_user")) {
            await page.waitForTimeout(3000); // let Facebook finish writing the session
            return true;
          }
          await sleep(LOGIN_POLL_MS);
        }
        return false;
      } finally {
        await ctx.close().catch(() => undefined);
      }
    });
  }

  private async closeNow(): Promise<void> {
    const ctx = this.ctx;
    const browser = this.browser;
    this.ctx = null;
    this.browser = null;
    this.page = null;
    if (ctx) await ctx.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
  }

  /** Final shutdown: finish the in-flight call, then refuse new work. */
  async close(): Promise<void> {
    const done = this.exclusive(() => this.closeNow());
    this.closing = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await done;
  }
}
