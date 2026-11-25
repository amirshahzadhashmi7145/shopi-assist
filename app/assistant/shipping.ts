/**
 * A store's shipping zones and rates as Shopify holds them, and how they are
 * put into words.
 *
 * They are read from Shopify at the moment they are needed (see
 * shipping.server.ts): when a shopper asks what delivery costs, and when the
 * merchant opens Settings. They are never stored and never typed in, so what
 * the assistant says is what the checkout will charge by the same rules.
 *
 * Nothing here touches Shopify, the database or an LLM.
 */
import { countryName } from "./store-facts";

export interface ShippingRate {
  name: string;
  /** What it costs. Null: worked out at the checkout (a carrier's own rate). */
  price: { amount: string; currencyCode: string } | null;
  /** Who works the rate out, when it is not a fixed one. */
  carrier?: string;
  /** When the rate applies, in words. Empty: always. */
  conditions: string[];
  /** The store's own note on the rate, such as a delivery time. */
  description?: string;
}

export interface ShippingZone {
  name: string;
  /** ISO codes of the countries in the zone. */
  countries: string[];
  /** The zone also takes every country that no other zone names. */
  restOfWorld: boolean;
  rates: ShippingRate[];
}

export interface ShippingRates {
  /**
   * live: read from the store's shipping settings just now.
   * no_access: Shopify has not given the app permission to read them.
   * unreachable: Shopify could not be asked.
   */
  state: "live" | "no_access" | "unreachable";
  zones: ShippingZone[];
  /** Some products have shipping rates of their own, apart from these. */
  otherProfiles: boolean;
  /** The store has more zones than were read. */
  truncated: boolean;
  /**
   * Business days the store takes to hand an order to the carrier, as set in
   * its Shopify shipping settings. Missing when the store has not set it.
   */
  processingDays?: number;
}

export const NO_SHIPPING_RATES: ShippingRates = {
  state: "unreachable",
  zones: [],
  otherProfiles: false,
  truncated: false,
};

// ---------------------------------------------------------------------------
// Reading Shopify's answer
// ---------------------------------------------------------------------------

/**
 * Shopify gives the processing time as an ISO 8601 duration in whole days:
 * "P1D". Anything else is not understood and counts as not set.
 */
export function readProcessingDays(duration: unknown): number | undefined {
  const match = typeof duration === "string" ? /^P(\d{1,3})D$/.exec(duration) : null;
  return match ? Number(match[1]) : undefined;
}

/** "the same business day", "within 1 business day", "within 3 business days". */
export function processingText(days: number): string {
  if (days === 0) return "the same business day";
  return `within ${days} business ${days === 1 ? "day" : "days"}`;
}

const WEIGHT_UNITS: Record<string, string> = {
  KILOGRAMS: "kg",
  GRAMS: "g",
  POUNDS: "lb",
  OUNCES: "oz",
};

/** "10.0" CAD -> "10.00 CAD"; "1000.0" JPY -> "1000 JPY". */
export function moneyText(amount: string, currencyCode: string): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return `${amount} ${currencyCode}`;
  let digits = 2;
  try {
    digits =
      new Intl.NumberFormat("en", { style: "currency", currency: currencyCode }).resolvedOptions()
        .maximumFractionDigits ?? 2;
  } catch {
    // A currency this runtime does not know: two decimals is the common case.
  }
  return `${value.toFixed(digits)} ${currencyCode}`;
}

interface RawCondition {
  field?: unknown;
  operator?: unknown;
  conditionCriteria?: { amount?: unknown; currencyCode?: unknown; unit?: unknown; value?: unknown } | null;
}

/** One of Shopify's rate conditions in words, or nothing when it is not understood. */
function conditionText(condition: RawCondition): string {
  const criteria = condition.conditionCriteria ?? {};
  const atLeast = condition.operator === "GREATER_THAN_OR_EQUAL_TO";
  if (condition.operator !== "LESS_THAN_OR_EQUAL_TO" && !atLeast) return "";

  if (
    condition.field === "TOTAL_PRICE" &&
    typeof criteria.amount === "string" &&
    typeof criteria.currencyCode === "string"
  ) {
    const amount = moneyText(criteria.amount, criteria.currencyCode);
    return atLeast ? `orders of ${amount} or more` : `orders up to ${amount}`;
  }
  if (
    condition.field === "TOTAL_WEIGHT" &&
    typeof criteria.value === "number" &&
    typeof criteria.unit === "string"
  ) {
    const weight = `${criteria.value} ${WEIGHT_UNITS[criteria.unit] ?? criteria.unit.toLowerCase()}`;
    return atLeast ? `orders weighing ${weight} or more` : `orders weighing up to ${weight}`;
  }
  return "";
}

const clean = (value: unknown, max: number): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

function readRate(raw: unknown): ShippingRate | null {
  if (!raw || typeof raw !== "object") return null;
  const method = raw as {
    name?: unknown;
    active?: unknown;
    description?: unknown;
    rateProvider?: {
      price?: { amount?: unknown; currencyCode?: unknown } | null;
      carrierService?: { formattedName?: unknown; name?: unknown } | null;
    } | null;
    methodConditions?: unknown;
  };
  const name = clean(method.name, 80);
  if (!name || method.active === false) return null;

  const price = method.rateProvider?.price;
  const fixed =
    price && typeof price.amount === "string" && typeof price.currencyCode === "string"
      ? { amount: price.amount, currencyCode: price.currencyCode }
      : null;
  const carrier =
    clean(method.rateProvider?.carrierService?.formattedName, 60) ||
    clean(method.rateProvider?.carrierService?.name, 60);
  const description = clean(method.description, 160);

  return {
    name,
    price: fixed,
    ...(carrier && !fixed ? { carrier } : {}),
    conditions: (Array.isArray(method.methodConditions) ? method.methodConditions : [])
      .map((condition) => conditionText(condition as RawCondition))
      .filter(Boolean),
    ...(description ? { description } : {}),
  };
}

const rateKey = (rate: ShippingRate) =>
  JSON.stringify([rate.name, rate.price, rate.carrier ?? "", rate.conditions]);

/**
 * The zones of one shipping profile, from what the Admin API returns for it.
 * A store with several warehouses lists a zone once per group of locations;
 * here each set of countries appears once, with every rate that reaches it.
 * Anything not shaped as expected is left out instead of guessed at.
 */
export function readShippingProfile(data: unknown): Pick<ShippingRates, "zones" | "truncated"> {
  const groups = (data as { deliveryProfile?: { profileLocationGroups?: unknown } } | null)
    ?.deliveryProfile?.profileLocationGroups;
  const zones = new Map<string, ShippingZone>();
  let truncated = false;

  for (const group of Array.isArray(groups) ? groups : []) {
    const found = (
      group as {
        locationGroupZones?: { nodes?: unknown; pageInfo?: { hasNextPage?: unknown } };
      } | null
    )?.locationGroupZones;
    if (found?.pageInfo?.hasNextPage === true) truncated = true;

    for (const entry of Array.isArray(found?.nodes) ? found.nodes : []) {
      const node = entry as {
        zone?: { name?: unknown; countries?: unknown };
        methodDefinitions?: { nodes?: unknown };
      } | null;
      const countries = new Set<string>();
      let restOfWorld = false;
      for (const country of Array.isArray(node?.zone?.countries) ? node.zone.countries : []) {
        const code = (country as { code?: { countryCode?: unknown; restOfWorld?: unknown } } | null)?.code;
        if (code?.restOfWorld === true) restOfWorld = true;
        if (typeof code?.countryCode === "string" && /^[A-Z]{2}$/.test(code.countryCode)) {
          countries.add(code.countryCode);
        }
      }
      if (!countries.size && !restOfWorld) continue;

      const rates = (Array.isArray(node?.methodDefinitions?.nodes) ? node.methodDefinitions.nodes : [])
        .map(readRate)
        .filter((rate): rate is ShippingRate => rate !== null);

      const key = `${restOfWorld ? "*" : ""}${[...countries].sort().join(",")}`;
      const zone = zones.get(key) ?? {
        name: clean(node?.zone?.name, 80) || "Shipping zone",
        countries: [...countries].sort(),
        restOfWorld,
        rates: [],
      };
      const seen = new Set(zone.rates.map(rateKey));
      for (const rate of rates) {
        if (!seen.has(rateKey(rate))) {
          zone.rates.push(rate);
          seen.add(rateKey(rate));
        }
      }
      zones.set(key, zone);
    }
  }
  return { zones: [...zones.values()], truncated };
}

// ---------------------------------------------------------------------------
// In words
// ---------------------------------------------------------------------------

/** What a rate costs: "free", "10.00 CAD", or that the checkout works it out. */
export function rateCost(rate: ShippingRate): string {
  if (!rate.price) return `calculated at checkout${rate.carrier ? ` by ${rate.carrier}` : ""}`;
  return Number(rate.price.amount) === 0 ? "free" : moneyText(rate.price.amount, rate.price.currencyCode);
}

/** "Standard: 10.00 CAD (orders up to 99.99 CAD)". */
export function rateText(rate: ShippingRate): string {
  const when = rate.conditions.length ? ` (${rate.conditions.join(" and ")})` : "";
  return `${rate.name}: ${rateCost(rate)}${when}`;
}

/** The zones that deliver to a country: those naming it, or else those taking "the rest of the world". */
export function zonesFor(rates: ShippingRates, countryCode: string): ShippingZone[] {
  const named = rates.zones.filter((zone) => zone.countries.includes(countryCode));
  return named.length ? named : rates.zones.filter((zone) => zone.restOfWorld);
}

const ALIASES: Record<string, string> = {
  uk: "GB",
  "great britain": "GB",
  britain: "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  usa: "US",
  "u.s.": "US",
  "u.s.a.": "US",
  america: "US",
  "united states of america": "US",
  uae: "AE",
  emirates: "AE",
  "south korea": "KR",
  korea: "KR",
  russia: "RU",
  holland: "NL",
  "the netherlands": "NL",
  turkey: "TR",
  "czech republic": "CZ",
  "hong kong": "HK",
  macau: "MO",
  vietnam: "VN",
  "ivory coast": "CI",
};

/** Two-letter codes that name something other than a country to deliver to. */
const NOT_COUNTRIES = new Set(["EU", "EZ", "UN", "ZZ", "QO", "XA", "XB", "UK"]);

let namesToCodes: Map<string, string> | undefined;

/**
 * The ISO code for a country given as a code ("ca") or by name ("Canada").
 * Null when it is not recognised.
 */
export function countryCodeFor(input: string): string | null {
  const wanted = input.replace(/\s+/g, " ").trim().toLowerCase();
  if (!wanted) return null;
  if (ALIASES[wanted]) return ALIASES[wanted];

  if (!namesToCodes) {
    namesToCodes = new Map();
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (const first of letters) {
      for (const second of letters) {
        const code = first + second;
        const name = countryName(code).toLowerCase();
        // A code the runtime has no country for comes back as itself. Where
        // two codes share a name, the first is the country's own.
        if (NOT_COUNTRIES.has(code) || name === code.toLowerCase()) continue;
        if (!namesToCodes.has(name)) namesToCodes.set(name, code);
      }
    }
  }
  if (/^[a-z]{2}$/.test(wanted)) {
    const code = wanted.toUpperCase();
    return !NOT_COUNTRIES.has(code) && countryName(code) !== code ? code : null;
  }
  return namesToCodes.get(wanted) ?? null;
}

// ---------------------------------------------------------------------------
// For the admin
// ---------------------------------------------------------------------------

/** The rates as a settings page shows them: already in words, already named. */
export interface ShippingView {
  state: ShippingRates["state"];
  /** The first few zones: where each delivers and what it charges. */
  zones: Array<{ where: string; rates: string[] }>;
  /** Zones the store has beyond those shown. */
  more: number;
  /** Countries delivered to, by name, alphabetical. */
  countries: string[];
  /** A zone takes every country not named. */
  restOfWorld: boolean;
  otherProfiles: boolean;
  /** How soon orders are handed to the carrier, in words. Empty when Shopify does not say. */
  processing: string;
}

const SHOWN_ZONES = 6;
const NAMED_IN_ZONE = 4;

function whereText(zone: ShippingZone): string {
  const names = zone.countries.map(countryName).sort((a, b) => a.localeCompare(b));
  const listed =
    names.length <= NAMED_IN_ZONE
      ? names.join(", ")
      : `${names.slice(0, NAMED_IN_ZONE).join(", ")} and ${names.length - NAMED_IN_ZONE} more`;
  if (!zone.restOfWorld) return listed;
  return listed ? `${listed}, and the rest of the world` : "Rest of the world";
}

/**
 * Worked out where the page's data is prepared (the server), because a
 * server and a browser do not always agree on a country's name.
 */
export function shippingForPage(rates: ShippingRates): ShippingView {
  const codes = new Set(rates.zones.flatMap((zone) => zone.countries));
  return {
    state: rates.state,
    zones: rates.zones.slice(0, SHOWN_ZONES).map((zone) => ({
      where: whereText(zone),
      rates: zone.rates.length ? zone.rates.map(rateText) : ["No rates set for this zone"],
    })),
    more: Math.max(0, rates.zones.length - SHOWN_ZONES) + (rates.truncated ? 1 : 0),
    countries: [...codes].map(countryName).sort((a, b) => a.localeCompare(b)),
    restOfWorld: rates.zones.some((zone) => zone.restOfWorld),
    otherProfiles: rates.otherProfiles,
    processing:
      rates.processingDays === undefined
        ? ""
        : `Orders are handed to the carrier ${processingText(rates.processingDays)}.`,
  };
}
