// Title normalisation, relevance matching and spec extraction.
//
// Israeli listings mix Hebrew and English freely ("אייפון 13 פרו 256GB"), so
// every vocabulary here is bilingual. Specs drive like-for-like grouping: an
// "iPhone 13 Pro 256GB" must never be priced against an "iPhone 13 128GB".

import type { Specs } from "./types.js";

/** Hebrew / variant spellings folded onto one canonical English token. */
const ALIASES: Array<[RegExp, string]> = [
  [/אייפון|איפון/g, "iphone"],
  [/סמסונג/g, "samsung"],
  [/גלקסי/g, "galaxy"],
  [/שיאומי/g, "xiaomi"],
  [/פיקסל/g, "pixel"],
  [/אייפד|איפד/g, "ipad"],
  [/מקבוק/g, "macbook"],
  [/איירפודס|אירפודס/g, "airpods"],
  [/פלייסטיישן/g, "playstation"],
  [/\bps(\d)\b/g, "playstation $1"],
  [/נינטנדו/g, "nintendo"],
  [/סוויץ'?|סוויטש/g, "switch"],
  [/אקסבוקס/g, "xbox"],
  [/טלוויזיה|טלויזיה/g, "tv"],
  [/מחשב נייד|לפטופ/g, "laptop"],
  [/אופניים חשמליים/g, "ebike"],
  [/קורקינט/g, "scooter"],
];

// Hebrew words need explicit boundaries (\b is ASCII-only): "פרו" must not match "פרוץ" (jailbroken).
const tier = (en: string, heb: string) => new RegExp(`\\b${en}\\b|(?:^|\\s)(?:${heb})(?=\\s|$)`);

const TIER_WORDS: Array<[RegExp, string]> = [
  [tier("pro", "פרו"), "pro"],
  [tier("max", "מקס"), "max"],
  [tier("mini", "מיני"), "mini"],
  [tier("plus", "פלוס"), "plus"],
  [tier("ultra", "אולטרה"), "ultra"],
  [tier("air", "אייר"), "air"],
  [/\bse\b/, "se"],
  [tier("lite", "לייט"), "lite"],
  [/\bfe\b/, "fe"],
  [/\boled\b/, "oled"],
  [tier("slim", "סלים"), "slim"],
  [tier("digital", "דיגיטל|דיגיטלי|דיגיטלית"), "digital"],
];

/** Lower-case, strip emoji/punctuation, apply bilingual aliases, separate glued digits ("13pro" -> "13 pro"). */
export function normalizeText(s: string): string {
  let t = s
    .toLowerCase()
    .replace(/[‎‏‪-‮]/g, "")
    .replace(/[+_|/\\,;:!?()[\]{}"'`~*#@^=<>\-–—.]+/g, " ")
    .replace(/\p{Extended_Pictographic}/gu, " ");
  for (const [re, to] of ALIASES) t = t.replace(re, to);
  t = t.replace(/(\d)([a-z֐-׿])/g, "$1 $2").replace(/([a-z֐-׿])(\d)/g, "$1 $2");
  // Re-glue storage units split by the step above ("256 gb" stays readable for the regex).
  return t.replace(/\s+/g, " ").trim();
}

// Hebrew attaches one-letter prefixes (and/the/for/in/from/that/like) to words.
const HEBREW_CLITICS = "והלבמשכ";

/** `word` starts with `stem`, allowing one Hebrew prefix letter: "ומשחקים" matches "משחק". */
export function stemMatch(word: string, stem: string): boolean {
  return word.startsWith(stem) || (HEBREW_CLITICS.includes(word[0]) && word.slice(1).startsWith(stem));
}

export function tokens(s: string): string[] {
  return normalizeText(s).split(" ").filter(Boolean);
}

/**
 * A listing is relevant when its title contains every token of at least one
 * query variant. Tokens match whole words, so "13" does not match "130".
 */
export function isRelevant(title: string, queries: string[], mustInclude: string[] = []): boolean {
  const words = new Set(tokens(title));
  const hasAll = (q: string) => tokens(q).every((t) => words.has(t));
  if (mustInclude.length && !mustInclude.every(hasAll)) return false;
  return queries.some(hasAll);
}

// Hebrew letters are not \w, so `\b` cannot close a Hebrew unit: use a lookahead.
const STORAGE_RE = /\b(\d{2,4}|1|2)\s*(gb|g|go|giga|גיגה|ג׳יגה|ג יגה|גיגבייט|tb|טרה)(?=\s|$)/;
const BARE_STORAGE = new Set([32, 64, 128, 256, 512]);
const INCH_RE = /\b(\d{2}(?:\.\d)?)\s*(?:inch|in\b|אינץ'?|אינטש|"|״)/;

export function extractSpecs(title: string, description = ""): Specs {
  const t = normalizeText(title);
  let storageGb: number | null = null;
  const m = t.match(STORAGE_RE) ?? normalizeText(description).match(STORAGE_RE);
  if (m) {
    const n = Number(m[1]);
    storageGb = /tb|טרה/.test(m[2]) ? n * 1024 : n;
  } else {
    // "אייפון 13 (256)" – a bare canonical storage size in the title.
    const bare = t.split(" ").map(Number).find((n) => BARE_STORAGE.has(n));
    if (bare) storageGb = bare;
  }
  if (storageGb === 129) storageGb = 128; // common typo
  const tiers = TIER_WORDS.filter(([re]) => re.test(t)).map(([, w]) => w);
  // Run on the raw title: normalisation strips the `"` inch mark.
  const inch = title.toLowerCase().match(INCH_RE);
  return { storageGb, tiers: [...new Set(tiers)].sort(), sizeInch: inch ? Number(inch[1]) : null };
}

/** Human-readable grouping key, e.g. "pro · 256GB" or "base". */
export function specKey(s: Specs): string {
  const parts = [...s.tiers];
  if (s.sizeInch) parts.push(`${s.sizeInch}"`);
  if (s.storageGb) parts.push(s.storageGb >= 1024 ? `${s.storageGb / 1024}TB` : `${s.storageGb}GB`);
  return parts.length ? parts.join(" · ") : "base";
}

/** Same product line, ignoring storage: used to fall back when a storage group is too thin. */
export function tierKey(s: Specs): string {
  return s.tiers.length ? s.tiers.join(" · ") : "base";
}
