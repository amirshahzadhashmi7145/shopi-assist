/**
 * What the app learned about a store from Shopify itself, so the merchant
 * does not have to type it: its description, its contact address, its
 * currency, where it ships and whether its refund and shipping policies are
 * published.
 *
 * Only what something uses is kept. Each fact either stands in Settings
 * where a question would otherwise be asked, or is told to the assistant.
 * Of these the assistant is told two, and each only if the merchant chooses:
 * the store's own description, when they picked it as their business
 * description, and its contact address, when they picked it as their contact
 * answer. Where the store delivers, what delivery costs, how soon orders
 * leave and how shoppers can pay are not taken from here: the assistant
 * reads those from Shopify at the moment it is asked (see shipping.server.ts
 * and the shopper tools). A fact Shopify did not answer for is simply
 * absent: absent means "unknown", which is different from "none".
 *
 * The facts are read from Shopify with the merchant's own session (see
 * store-facts.server.ts) and kept with the shop's settings.
 *
 * Nothing here touches Shopify, the database or an LLM.
 */

export interface StoreFacts {
  /**
   * When Shopify last answered in full, as an ISO time. Null: never. An
   * answer from only one of its two APIs brings its facts but leaves this as
   * it was, so the rest is asked for again soon.
   */
  syncedAt: string | null;
  /** The store's own description of itself, as set in Shopify. */
  description?: string;
  currencyCode?: string;
  /** The store's public contact address. Told to shoppers only if the merchant chooses. */
  contactEmail?: string;
  /**
   * ISO codes of the countries with a zone in the store's shipping profiles.
   * Right for a store that keeps its shipping there. On a store that has
   * moved its shipping to markets Shopify leaves this list behind, so it is
   * shown only where the store is known to be on profiles.
   */
  shipsTo?: string[];
  /** Whether the store has published each of the two policies Settings has picks for. */
  policies?: { refund: boolean; shipping: boolean };
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

  if (raw.policies && typeof raw.policies === "object") {
    const policies = raw.policies as Record<string, unknown>;
    facts.policies = {
      refund: policies.refund === true,
      shipping: policies.shipping === true,
    };
  }
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

/**
 * Card brands and wallets as shoppers know them, from Shopify's codes for
 * them. Not a stored fact: the assistant reads a checkout's cards and
 * wallets from Shopify when a shopper asks, and names them with this.
 */
export function paymentNames(checkout: { cards?: string[]; wallets?: string[] }): {
  cards: string[];
  wallets: string[];
} {
  const named = (list: string[] | undefined, names: Record<string, string>) => [
    ...new Set((list ?? []).map((code) => names[code] ?? titled(code))),
  ];
  return {
    cards: named(checkout.cards, CARD_NAMES),
    wallets: named(checkout.wallets, WALLET_NAMES),
  };
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
