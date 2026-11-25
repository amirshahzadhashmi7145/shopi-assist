/**
 * What the app learned about a store from Shopify itself, so the merchant
 * does not have to type it: where it ships, how shoppers can pay, which
 * policies are published, how big the catalog is.
 *
 * The facts are read from Shopify with the merchant's own session (see
 * store-facts.server.ts), kept with the shop's settings, and shown in the
 * admin as "Synced from Shopify". The public ones are also told to the
 * assistant. A fact Shopify did not answer for is simply absent: absent means
 * "unknown", which is different from "none".
 *
 * Nothing here touches Shopify, the database or an LLM.
 */

export interface StoreFacts {
  /** When Shopify last answered, as an ISO time. Null: never asked. */
  syncedAt: string | null;
  shopName?: string;
  /** The store's own description of itself, as set in Shopify. */
  description?: string;
  currencyCode?: string;
  /** The store's public contact address. Told to shoppers only if the merchant chooses. */
  contactEmail?: string;
  /** ISO codes of the countries with a shipping zone. */
  shipsTo?: string[];
  /** Card brands and wallets the checkout takes, as Shopify names them. */
  cards?: string[];
  wallets?: string[];
  /** Which policies the store has published. */
  policies?: { refund: boolean; shipping: boolean; privacy: boolean; terms: boolean };
  /** Active products, and whether the real number is higher than Shopify counted. */
  products?: number;
  productsCapped?: boolean;
  giftCards?: boolean;
}

export const NO_FACTS: StoreFacts = { syncedAt: null };

const text = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\s+/g, " ").trim().slice(0, max);
  return clean || undefined;
};

const codes = (value: unknown, pattern: RegExp, max: number): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry === "string" && pattern.test(entry)) seen.add(entry);
    if (seen.size >= max) break;
  }
  return [...seen];
};

/**
 * Facts as they are safe to use, whatever was handed in: every field is
 * checked for its shape and capped, and anything else is dropped. Used on
 * what Shopify returns and again on what was stored.
 */
export function cleanStoreFacts(input: unknown): StoreFacts {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...NO_FACTS };
  const raw = input as Record<string, unknown>;
  const facts: StoreFacts = {
    syncedAt:
      typeof raw.syncedAt === "string" && !Number.isNaN(Date.parse(raw.syncedAt))
        ? new Date(raw.syncedAt).toISOString()
        : null,
  };

  const shopName = text(raw.shopName, 120);
  if (shopName) facts.shopName = shopName;
  const description = text(raw.description, 400);
  if (description) facts.description = description;
  if (typeof raw.currencyCode === "string" && /^[A-Z]{3}$/.test(raw.currencyCode)) {
    facts.currencyCode = raw.currencyCode;
  }
  if (
    typeof raw.contactEmail === "string" &&
    raw.contactEmail.length <= 254 &&
    /^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+$/.test(raw.contactEmail)
  ) {
    facts.contactEmail = raw.contactEmail;
  }

  const shipsTo = codes(raw.shipsTo, /^[A-Z]{2}$/, 300);
  if (shipsTo) facts.shipsTo = shipsTo;
  const cards = codes(raw.cards, /^[A-Z][A-Z_]{1,39}$/, 30);
  if (cards) facts.cards = cards;
  const wallets = codes(raw.wallets, /^[A-Z][A-Z_]{1,39}$/, 30);
  if (wallets) facts.wallets = wallets;

  if (raw.policies && typeof raw.policies === "object") {
    const policies = raw.policies as Record<string, unknown>;
    facts.policies = {
      refund: policies.refund === true,
      shipping: policies.shipping === true,
      privacy: policies.privacy === true,
      terms: policies.terms === true,
    };
  }
  if (typeof raw.products === "number" && Number.isInteger(raw.products) && raw.products >= 0) {
    facts.products = raw.products;
    if (raw.productsCapped === true) facts.productsCapped = true;
  }
  if (typeof raw.giftCards === "boolean") facts.giftCards = raw.giftCards;
  return facts;
}

/** The facts kept with a shop's settings. Anything unreadable counts as none. */
export function readStoreFacts(stored: string | null | undefined): StoreFacts {
  if (!stored) return { ...NO_FACTS };
  try {
    return cleanStoreFacts(JSON.parse(stored));
  } catch {
    return { ...NO_FACTS };
  }
}

// ---------------------------------------------------------------------------
// In words
// ---------------------------------------------------------------------------

const CARD_NAMES: Record<string, string> = {
  VISA: "Visa",
  MASTERCARD: "Mastercard",
  AMERICAN_EXPRESS: "American Express",
  DISCOVER: "Discover",
  DINERS_CLUB: "Diners Club",
  JCB: "JCB",
  UNIONPAY: "UnionPay",
  ELO: "Elo",
  MAESTRO: "Maestro",
};
const WALLET_NAMES: Record<string, string> = {
  SHOPIFY_PAY: "Shop Pay",
  APPLE_PAY: "Apple Pay",
  GOOGLE_PAY: "Google Pay",
  ANDROID_PAY: "Google Pay",
};

/** "AMERICAN_EXPRESS" -> "American Express", for a brand not listed above. */
const titled = (code: string) =>
  code
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

export function paymentNames(facts: StoreFacts): { cards: string[]; wallets: string[] } {
  const named = (list: string[] | undefined, names: Record<string, string>) => [
    ...new Set((list ?? []).map((code) => names[code] ?? titled(code))),
  ];
  return { cards: named(facts.cards, CARD_NAMES), wallets: named(facts.wallets, WALLET_NAMES) };
}

let regionNames: Intl.DisplayNames | null | undefined;

/** "CA" -> "Canada". Falls back to the code where the runtime has no names. */
export function countryName(code: string): string {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** The countries by name, in alphabetical order. */
export function shipsToNames(facts: StoreFacts): string[] {
  return (facts.shipsTo ?? []).map(countryName).sort((a, b) => a.localeCompare(b));
}

/**
 * The facts as an admin page shows them: with the countries already named.
 * A server and a browser do not always agree on a country's name, so the
 * names are worked out once, where the page's data is prepared, and the page
 * shows them as given.
 */
export interface StoreFactsView extends StoreFacts {
  /** Names for `shipsTo`, alphabetical. Empty when unknown or none. */
  countries: string[];
}

export function factsForPage(facts: StoreFacts): StoreFactsView {
  return { ...facts, countries: shipsToNames(facts) };
}

/** Above this many countries the names are not spelled out. */
const NAMED_COUNTRIES = 40;

/**
 * What the assistant is told from the store's own Shopify settings. Only
 * things a visitor could find out at the checkout anyway: where the store
 * delivers and how they can pay. The contact address is not here; it is
 * shared only when the merchant picks it as their contact answer.
 */
export function describeStoreFacts(facts: StoreFacts): string {
  const lines: string[] = [];
  const countries = shipsToNames(facts);
  if (countries.length === 1) {
    lines.push(
      `Delivery area: this store delivers to ${countries[0]}. It has no shipping set up for any other country.`,
    );
  } else if (countries.length > 1 && countries.length <= NAMED_COUNTRIES) {
    lines.push(
      `Delivery area: this store delivers to these ${countries.length} countries: ${countries.join(", ")}. It has no shipping set up for any other country.`,
    );
  } else if (countries.length > NAMED_COUNTRIES) {
    lines.push(
      `Delivery area: this store delivers to ${countries.length} countries and regions worldwide. For one particular country, say that the checkout confirms whether delivery is available.`,
    );
  }

  const { cards, wallets } = paymentNames(facts);
  if (cards.length) lines.push(`Cards accepted at checkout: ${cards.join(", ")}.`);
  if (wallets.length) lines.push(`Wallets accepted at checkout: ${wallets.join(", ")}.`);
  return lines.join("\n");
}
