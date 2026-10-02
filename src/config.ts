import os from "node:os";
import path from "node:path";

const env = process.env;

function num(name: string, fallback: number): number {
  const v = Number(env[name]);
  return Number.isFinite(v) && env[name] !== "" && env[name] !== undefined ? v : fallback;
}

export const HOME_DIR = path.resolve(env.FBMP_HOME ?? path.join(os.homedir(), ".fb-marketplace-mcp"));

export const config = {
  homeDir: HOME_DIR,
  profileDir: path.join(HOME_DIR, "profile"),
  dbPath: path.join(HOME_DIR, "marketplace.db"),
  reportsDir: path.join(HOME_DIR, "reports"),
  /** Marketplace city slug (telaviv, jerusalem, haifa…) or numeric location id. */
  location: env.FBMP_LOCATION ?? "telaviv",
  locale: env.FBMP_LOCALE ?? "he-IL",
  timezone: env.FBMP_TIMEZONE ?? "Asia/Jerusalem",
  headless: !["0", "false"].includes((env.FBMP_HEADLESS ?? "1").toLowerCase()),
  /** Human-pace jitter between page loads. Do not lower: the point is to not look like a sweep. */
  minDelayMs: num("FBMP_MIN_DELAY_MS", 2500),
  maxDelayMs: num("FBMP_MAX_DELAY_MS", 5000),
  navTimeoutMs: num("FBMP_TIMEOUT_MS", 45000),
  cacheTtlMs: num("FBMP_CACHE_TTL_MS", 10 * 60 * 1000),
  /** Buyer's home, for distance scoring. Optional. */
  home:
    env.FBMP_HOME_LAT && env.FBMP_HOME_LNG
      ? { lat: Number(env.FBMP_HOME_LAT), lng: Number(env.FBMP_HOME_LNG) }
      : null,
  /** Hard cap on page loads per compare call, so one request can never turn into a crawl. */
  maxPagesPerCompare: num("FBMP_MAX_PAGES", 12),
};
