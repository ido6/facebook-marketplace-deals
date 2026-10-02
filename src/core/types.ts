export interface Listing {
  id: string;
  url: string;
  title: string;
  price: number | null;
  /** ISO code when Facebook gives one, otherwise inferred from the formatted price symbol. */
  currency: string | null;
  priceText: string;
  /** Price before the seller's last reduction, when shown. */
  previousPrice: number | null;
  city: string | null;
  imageUrl: string | null;
  /** Unix seconds. */
  createdAt: number | null;
  isSold: boolean;
  isPending: boolean;
  sellerName: string | null;
  sellerId: string | null;
  deliveryTypes: string[];
  categoryId: string | null;
}

export interface ListingDetail extends Listing {
  description: string;
  condition: string | null;
  conditionLabel: string | null;
  attributes: Array<{ name: string; value: string; label: string }>;
  latitude: number | null;
  longitude: number | null;
  locationText: string | null;
  photos: string[];
  shippingOffered: boolean;
  status: string | null;
}

export interface Specs {
  /** Storage in GB (1TB = 1024). */
  storageGb: number | null;
  /** Model tier words, normalised to English: pro, max, mini, plus, ultra, ... */
  tiers: string[];
  /** Screen / product size in inches. */
  sizeInch: number | null;
}

export type Severity = "high" | "medium" | "low";

export interface RedFlag {
  code: string;
  severity: Severity;
  message: string;
}
