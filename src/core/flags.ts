// Scam and quality red flags.
//
// Vocabulary is bilingual (Hebrew + English) because Israeli sellers mix both.
// Flags are advisory: the comparison keeps flagged listings visible but moves
// high-severity ones out of the "best deals" ranking.

import type { Listing, ListingDetail, RedFlag } from "./types.js";
import { normalizeText } from "./specs.js";

/** Sellers type these to game "lowest price" sorting or to mean "call me". */
const PLACEHOLDER_PRICES = new Set([1, 2, 3, 111, 123, 1111, 1234, 12345, 99999, 999999]);

const WANTED = /\b(wanted|looking for|buying|wtb|iso)\b|^(מחפש|מחפשת|קונה|קונים|דרוש)|\sמחפש(ת)?\s/;
const PARTS_BROKEN =
  /\b(for parts|parts only|broken|cracked|not working|faulty|dead|locked|icloud|blacklisted|as is)\b|לחלקים|מקולקל|שבור|סדוק|תקול|לא עובד|לא נדלק|נעול|חסום|אייקלאוד|במצב כמות שהוא/;
const ACCESSORY =
  /\b(case|cover|screen protector|box only|empty box|charger|cable|strap|skin|stand|mount)\b|כיסוי|כיסויים|מגן מסך|קופסה בלבד|קופסא בלבד|מטען|כבל|רצועה|מעמד/;
const DEPOSIT_OR_REMOTE_PAY =
  /\b(deposit|western union|moneygram|gift card|crypto|bitcoin|usdt|paypal friends)\b|מקדמה|דמי רצינות|העברה בנקאית מראש|תשלום מראש|ביט מראש|פייבוקס מראש|לפני משלוח/;
const OFF_PLATFORM = /whatsapp|ווטסאפ|וואטסאפ|וואצאפ|telegram|טלגרם|\[hidden information\]/i;
const REPLICA = /\b(replica|copy|clone|1:1|aaa|high copy|first copy)\b|רפליקה|העתק|חיקוי|מזויף/;
const TRADE = /\b(trade|swap|exchange)\b|החלפה|טרייד/;
const MODDED = /\b(jailbreak|jailbroken|modded|hacked|banned|cfw)\b|פרוץ|פרוצה|פריצה|צרוב|חסום ברשת/;
// Hebrew glues "and" (ו) onto the next word: "ול-PS5" = "and for PS5".
const FOR_PREFIX = /(^|\s)(for|fits|compatible|ו?ל|ו?עבור|תואם|תואמת|מתאים ל)\s*$/;

export interface FlagContext {
  /** Median of the like-for-like group, when the group is big enough to trust. */
  groupMedian: number | null;
  /**
   * False when the group's prices spread widely (the query mixes different
   * products, e.g. armchair vs corner sofa): "far below median" then means
   * "smaller item", not "scam". Defaults to true.
   */
  groupHomogeneous?: boolean;
  /** First normalised token of the query (e.g. "playstation"), for "accessory for X" detection. */
  productToken?: string | null;
  detail?: ListingDetail | null;
  /** Real-world fair price for this item (used, good condition), supplied by the caller. */
  referencePrice?: number | null;
  /** Distance from the buyer, km. */
  distanceKm?: number | null;
  nowSec?: number;
}

/**
 * "SSD for PS5", "כונן ל-PS5", "מגן לאייפון": the product word appears only
 * after "for" (Hebrew prefix ל / עבור / תואם), and is not the title's subject.
 */
export function isAccessoryFor(normalizedTitle: string, productToken: string): boolean {
  const at = normalizedTitle.indexOf(productToken);
  if (at <= 0) return false;
  const before = normalizedTitle.slice(0, at);
  return FOR_PREFIX.test(before) || before.endsWith("ל");
}

export function isPlaceholderPrice(price: number | null): boolean {
  return price === null || price === 0 || PLACEHOLDER_PRICES.has(price);
}

export function redFlags(l: Listing, ctx: FlagContext): RedFlag[] {
  const flags: RedFlag[] = [];
  const title = normalizeText(l.title);
  const description = normalizeText(ctx.detail?.description ?? "");
  const text = `${title} ${description}`;
  const add = (code: string, severity: RedFlag["severity"], message: string) =>
    flags.push({ code, severity, message });

  if (isPlaceholderPrice(l.price)) {
    add("placeholder_price", "medium", `Price ${l.priceText || "missing"} looks like a placeholder, not a real asking price.`);
  }
  // Title only: descriptions say things like "the buyer gets..." which would misfire.
  if (WANTED.test(title)) add("wanted_post", "high", "Looks like a buy request ('looking for'), not an item for sale.");
  if (PARTS_BROKEN.test(title)) add("parts_or_broken", "high", "Title mentions broken / for-parts / locked.");
  else if (PARTS_BROKEN.test(description)) add("parts_or_broken", "medium", "Description mentions broken / for-parts / locked: read it.");
  if (REPLICA.test(text)) add("replica", "high", "Mentions replica / copy / fake.");
  if (TRADE.test(title)) add("trade_offer", "medium", "Title talks about a trade/swap: the price may not be a cash sale price.");
  if (MODDED.test(text)) add("modded", "medium", "Mentions jailbroken / modded / hacked: may be banned from online services or void warranty.");
  if (ctx.productToken && isAccessoryFor(title, ctx.productToken)) {
    add("accessory_for_product", "medium", "Title reads like an accessory or part made FOR the product, not the product itself.");
  }
  if (DEPOSIT_OR_REMOTE_PAY.test(text)) {
    add("prepayment", "high", "Asks for a deposit or remote payment before seeing the item: classic scam pattern.");
  }
  if (ACCESSORY.test(normalizeText(l.title)) && ctx.groupMedian && l.price !== null && l.price < ctx.groupMedian * 0.5) {
    add("accessory_only", "medium", "Title mentions an accessory and the price is far below the group: may not be the device itself.");
  }
  if (ctx.groupMedian && l.price !== null && !isPlaceholderPrice(l.price)) {
    const ratio = l.price / ctx.groupMedian;
    const pct = Math.round(ratio * 100);
    if (ratio < 0.45 && ctx.groupHomogeneous !== false) {
      add("too_good_to_be_true", "high", `Price is ${pct}% of the group median: likely scam, bait, or a different product.`);
    } else if (ratio < 0.65) {
      add("very_cheap", "low", `Price is ${pct}% of the group median: verify it is the same kind of item and in working order.`);
    }
  }
  if (ctx.referencePrice && l.price !== null && !isPlaceholderPrice(l.price)) {
    const r = l.price / ctx.referencePrice;
    if (r < 0.5) {
      add(
        "far_below_reference",
        "high",
        `Price is ${Math.round(r * 100)}% of the reference market price: almost certainly a scam, a different model, or damaged.`,
      );
    }
  }
  if (ctx.detail) {
    if (OFF_PLATFORM.test(ctx.detail.description)) {
      add("off_platform_contact", "low", "Seller pushes contact off Facebook (WhatsApp etc.). Normal in Israel, but never prepay.");
    }
    if (ctx.detail.photos.length <= 1) add("few_photos", "medium", "One photo or none: ask for real photos of the actual unit.");
    if (ctx.detail.status && ctx.detail.status !== "AVAILABLE") {
      add("not_available", "high", `Listing status is ${ctx.detail.status}.`);
    }
  }
  if (l.isSold || l.isPending) add("not_available", "high", l.isSold ? "Marked sold." : "Marked pending.");
  if (ctx.distanceKm != null && ctx.distanceKm > 80 && !l.deliveryTypes.some((d) => d.includes("SHIPPING"))) {
    add("far_pickup_only", "low", `Pickup only, ${Math.round(ctx.distanceKm)} km away.`);
  }
  return flags;
}

export function worstSeverity(flags: RedFlag[]): RedFlag["severity"] | null {
  if (flags.some((f) => f.severity === "high")) return "high";
  if (flags.some((f) => f.severity === "medium")) return "medium";
  return flags.length ? "low" : null;
}
