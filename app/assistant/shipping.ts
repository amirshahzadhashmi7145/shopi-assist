/**
 * Where a store delivers and what delivery costs, as Shopify holds it, and how
 * that is put into words.
 *
 * Shopify keeps this in one of two places, and a store is on one or the other:
 *
 *   - "markets": each market (a group of countries) has its own delivery
 *     options. Shopify is moving every store to this.
 *   - "profiles": the older shipping profiles, with zones and rates.
 *
 * On a store that has moved to markets, the old profiles are still there to
 * read but the checkout ignores them, so reading the wrong one gives rates
 * that look real and are not. shipping.server.ts asks Shopify which the store
 * is on and reads only that.
 *
 * Either way the answer has the same shape: zones, each with the countries it
 * covers and its rates. They are read at the moment they are needed (when a
 * shopper asks, and when the merchant opens Settings), never stored and never
 * typed in.
 *
 * Nothing here touches Shopify, the database or an LLM.
 */
import { countryName } from "./store-facts";

export interface Money {
  amount: string;
  currencyCode: string;
}

export interface ShippingRate {
  name: string;
  /** What it costs. Null: worked out at the checkout (a carrier's own rate). */
  price: Money | null;
  /** Who works the rate out, when it is not a fixed one. */
  carrier?: string;
  /** When the rate applies, in words. Empty: always. */
  conditions: string[];
  /** The store's own note on the rate, shown to buyers at the checkout. */
  description?: string;
  /** Orders worth this much or more get this rate free. */
  freeFrom?: Money;
  /** How long the parcel is on its way once it has left, as the store set it: "3 to 5 business days". */
  delivery?: string;
}

export interface ShippingZone {
  name: string;
  /** ISO codes of the countries in the zone. */
  countries: string[];
  /** The zone also takes every country that no other zone names. */
  restOfWorld: boolean;
  /**
   * Countries the zone covers only in part: for each, the provinces or
   * states it delivers to, by name.
   */
  parts?: Record<string, string[]>;
  /**
   * The rates that apply to any order. Empty with `more` unset: nothing is
   * delivered here (no rate is set, or delivery is switched off for it).
   */
  rates: ShippingRate[];
  /**
   * There are delivery options here beyond `rates`: more than were read, ones
   * for certain products only, or ones that could not be read. The checkout
   * shows them.
   */
  more?: boolean;
}

export interface ShippingRates {
  /**
   * live: read from the store's shipping settings just now.
   * no_access: Shopify has not given the app permission to read them.
   * unreachable: Shopify could not be asked.
   */
  state: "live" | "no_access" | "unreachable";
  /** Where the store keeps its delivery settings, once Shopify has said. */
  model?: "markets" | "profiles";
  zones: ShippingZone[];
  /** Some products, or an app the store uses, have delivery rates of their own, apart from these. */
  otherProfiles: boolean;
  /** The store has more zones than were read. */
  truncated: boolean;
  /**
   * Business days the store takes to hand an order to the carrier, as set in
   * its Shopify shipping settings. Missing when the store has not set it.
   */
  processingDays?: number;
}

/**
 * What the merchant picked in Settings about delivery, each as a sentence.
 * Shopify's own answer always comes first; a pick fills in only what Shopify
 * does not say or cannot be asked.
 */
export interface ShippingPicks {
  /** Where the store delivers. */
  area?: string;
  /** What delivery costs. */
  cost?: string;
  /** How soon orders are sent out. */
  dispatch?: string;
  /** How long delivery takes after that. */
  deliveryTime?: string;
}

export const NO_SHIPPING_RATES: ShippingRates = {
  state: "unreachable",
  zones: [],
  otherProfiles: false,
  truncated: false,
};

// ---------------------------------------------------------------------------
// Small readers, shared by both set-ups
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;

const isObject = (value: unknown): value is Loose =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The items of a list Shopify returned, leaving out anything that is not an object. */
const objects = (value: unknown): Loose[] => (Array.isArray(value) ? value.filter(isObject) : []);

/** The nodes of a connection, and whether Shopify has more of them than it returned. */
function page(connection: unknown): { nodes: Loose[]; more: boolean } {
  if (!isObject(connection)) return { nodes: [], more: false };
  return {
    nodes: objects(connection.nodes),
    more: isObject(connection.pageInfo) && connection.pageInfo.hasNextPage === true,
  };
}

const clean = (value: unknown, max: number): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

function readMoney(value: unknown): Money | null {
  if (!isObject(value)) return null;
  return typeof value.amount === "string" &&
    Number.isFinite(Number(value.amount)) &&
    typeof value.currencyCode === "string"
    ? { amount: value.amount, currencyCode: value.currencyCode }
    : null;
}

const isCountryCode = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Z]{2}$/.test(value);

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

const SECONDS_IN_A_DAY = 24 * 60 * 60;

/**
 * A rate's transit time, which Shopify gives in seconds, as the days a buyer
 * is told at the checkout: "3 to 5 business days". Part of a day counts as a
 * whole one, so the answer is never sooner than the store set. Empty when the
 * store set none or the figures make no sense.
 */
export function transitText(minSeconds: unknown, maxSeconds: unknown): string {
  const days = (seconds: unknown): number | null =>
    typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
      ? Math.ceil(seconds / SECONDS_IN_A_DAY)
      : null;
  const low = days(minSeconds);
  const high = days(maxSeconds);
  const from = low ?? high;
  const to = high ?? low;
  if (from === null || to === null || from > 365 || to > 365) return "";
  const word = (count: number) => `business ${count === 1 ? "day" : "days"}`;
  if (low === null) return `up to ${to} ${word(to)}`;
  if (from >= to) return `${from} ${word(from)}`;
  return `${from} to ${to} ${word(to)}`;
}

const rateKey = (rate: ShippingRate) =>
  JSON.stringify([
    rate.name,
    rate.price,
    rate.carrier ?? "",
    rate.conditions,
    rate.freeFrom ?? null,
    rate.delivery ?? "",
  ]);

/** Adds the rates not already there, keeping the order they came in. */
function addRates(into: ShippingRate[], rates: ShippingRate[]): void {
  const seen = new Set(into.map(rateKey));
  for (const rate of rates) {
    if (seen.has(rateKey(rate))) continue;
    into.push(rate);
    seen.add(rateKey(rate));
  }
}

// ---------------------------------------------------------------------------
// Reading Shopify's answer: shipping profiles (the older set-up)
// ---------------------------------------------------------------------------

/** One of Shopify's rate conditions in words, or nothing when it is not understood. */
function conditionText(condition: Loose): string {
  const criteria = isObject(condition.conditionCriteria) ? condition.conditionCriteria : {};
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

function readProfileRate(method: Loose): ShippingRate | null {
  const name = clean(method.name, 80);
  if (!name || method.active === false) return null;

  const provider = isObject(method.rateProvider) ? method.rateProvider : {};
  const fixed = readMoney(provider.price);
  const service = isObject(provider.carrierService) ? provider.carrierService : {};
  const carrier = clean(service.formattedName, 60) || clean(service.name, 60);
  const description = clean(method.description, 160);

  return {
    name,
    price: fixed,
    ...(carrier && !fixed ? { carrier } : {}),
    conditions: objects(method.methodConditions).map(conditionText).filter(Boolean),
    ...(description ? { description } : {}),
  };
}

/**
 * The zones of one shipping profile, from what the Admin API returns for it.
 * A store with several warehouses lists a zone once per group of locations;
 * here each set of countries appears once, with every rate that reaches it.
 * Anything not shaped as expected is left out instead of guessed at.
 */
export function readShippingProfile(data: unknown): Pick<ShippingRates, "zones" | "truncated"> {
  const profile = isObject(data) && isObject(data.deliveryProfile) ? data.deliveryProfile : {};
  const zones = new Map<string, ShippingZone>();
  let truncated = false;

  for (const group of objects(profile.profileLocationGroups)) {
    const found = page(group.locationGroupZones);
    if (found.more) truncated = true;

    for (const node of found.nodes) {
      const raw = isObject(node.zone) ? node.zone : {};
      const countries = new Set<string>();
      let restOfWorld = false;
      for (const country of objects(raw.countries)) {
        const code = isObject(country.code) ? country.code : {};
        if (code.restOfWorld === true) restOfWorld = true;
        if (isCountryCode(code.countryCode)) countries.add(code.countryCode);
      }
      if (!countries.size && !restOfWorld) continue;

      const methods = page(node.methodDefinitions);
      const rates = methods.nodes
        .map(readProfileRate)
        .filter((rate): rate is ShippingRate => rate !== null);

      const key = `${restOfWorld ? "*" : ""}${[...countries].sort().join(",")}`;
      const zone = zones.get(key) ?? {
        name: clean(raw.name, 80) || "Shipping zone",
        countries: [...countries].sort(),
        restOfWorld,
        rates: [],
      };
      addRates(zone.rates, rates);
      // More rates than were read: the checkout has the rest.
      if (methods.more) zone.more = true;
      zones.set(key, zone);
    }
  }
  return { zones: [...zones.values()], truncated };
}

// ---------------------------------------------------------------------------
// Reading Shopify's answer: markets (the set-up every store is moving to)
// ---------------------------------------------------------------------------

/** A range of order values in words. Empty: every order. */
function valueRangeText(min: Money | null, max: Money | null): string {
  const from = min && Number(min.amount) > 0 ? moneyText(min.amount, min.currencyCode) : "";
  const to = max ? moneyText(max.amount, max.currencyCode) : "";
  if (from && to) return `orders from ${from} to ${to}`;
  if (from) return `orders of ${from} or more`;
  return to ? `orders up to ${to}` : "";
}

function readWeight(value: unknown): string {
  if (!isObject(value) || typeof value.value !== "number" || typeof value.unit !== "string") return "";
  if (!Number.isFinite(value.value) || value.value < 0) return "";
  return `${value.value} ${WEIGHT_UNITS[value.unit] ?? value.unit.toLowerCase()}`;
}

/** A range of parcel weights in words. Empty: every order. */
function weightRangeText(min: unknown, max: unknown): string {
  const from = isObject(min) && min.value === 0 ? "" : readWeight(min);
  const to = readWeight(max);
  if (from && to) return `orders weighing ${from} to ${to}`;
  if (from) return `orders weighing ${from} or more`;
  return to ? `orders weighing up to ${to}` : "";
}

/** Whether a group of rates is only for the products of certain collections. */
function forSomeProductsOnly(group: Loose): boolean {
  const conditions = isObject(group.conditions) ? group.conditions : {};
  const count = isObject(conditions.collectionsCount) ? conditions.collectionsCount.count : 0;
  return typeof count === "number" && count > 0;
}

interface ReadOption {
  rates: ShippingRate[];
  /** The option has rates beyond these: more pages, or a kind this code does not know. */
  more: boolean;
  /** Some of its rates are for certain products only. */
  someProducts: boolean;
}

/** One delivery option of a market, as the rates it gives every order. */
function readMarketOption(option: Loose): ReadOption {
  const result: ReadOption = { rates: [], more: false, someProducts: false };
  if (option.isActive === false) return result;

  const description = clean(option.description, 160);
  const threshold = readMoney(option.freeDeliveryMinimumValue);
  const freeFrom = threshold && Number(threshold.amount) > 0 ? threshold : null;
  const name = clean(option.name, 80) || "Delivery";

  const rate = (
    price: Money | null,
    extra: { conditions?: string[]; delivery?: string; carrier?: string; name?: string } = {},
  ): ShippingRate => ({
    name: extra.name ?? name,
    price,
    ...(extra.carrier ? { carrier: extra.carrier } : {}),
    conditions: extra.conditions ?? [],
    ...(description ? { description } : {}),
    // A rate that is free anyway has nothing to waive.
    ...(freeFrom && !(price && Number(price.amount) === 0) ? { freeFrom } : {}),
    ...(extra.delivery ? { delivery: extra.delivery } : {}),
  });

  /** The groups of rates that apply to every product, noting the rest. */
  const general = (connection: unknown): Loose[] => {
    const groups = page(connection);
    if (groups.more) result.more = true;
    return groups.nodes.filter((group) => {
      if (!forSomeProductsOnly(group)) return true;
      result.someProducts = true;
      return false;
    });
  };

  switch (option.__typename) {
    case "DeliveryFlatRateOptionDefinition": {
      for (const group of general(option.flatGroups)) {
        const found = isObject(group.rate) ? group.rate : {};
        const price = readMoney(found.price);
        if (!price) continue;
        addRates(result.rates, [
          rate(price, {
            delivery: transitText(found.transitTimeMinSeconds, found.transitTimeMaxSeconds),
          }),
        ]);
      }
      break;
    }
    case "DeliveryValueBasedOptionDefinition": {
      for (const group of general(option.valueGroups)) {
        const tiers = page(group.rates);
        if (tiers.more) result.more = true;
        for (const tier of tiers.nodes) {
          const price = readMoney(tier.price);
          if (!price) continue;
          const when = valueRangeText(readMoney(tier.minValue), readMoney(tier.maxValue));
          addRates(result.rates, [
            rate(price, {
              conditions: when ? [when] : [],
              delivery: transitText(tier.transitTimeMinSeconds, tier.transitTimeMaxSeconds),
            }),
          ]);
        }
      }
      break;
    }
    case "DeliveryWeightBasedOptionDefinition": {
      for (const group of general(option.weightGroups)) {
        const tiers = page(group.rates);
        if (tiers.more) result.more = true;
        for (const tier of tiers.nodes) {
          const price = readMoney(tier.price);
          if (!price) continue;
          const when = weightRangeText(tier.minWeight, tier.maxWeight);
          addRates(result.rates, [
            rate(price, {
              conditions: when ? [when] : [],
              delivery: transitText(tier.transitTimeMinSeconds, tier.transitTimeMaxSeconds),
            }),
          ]);
        }
      }
      break;
    }
    case "DeliveryCarrierCalculatedOptionDefinition": {
      for (const group of general(option.carrierGroups)) {
        const service = isObject(group.carrierService) ? group.carrierService : {};
        const carrier = clean(service.formattedName, 60) || clean(service.name, 60);
        // The carrier prices each parcel itself; the option has no name of its own.
        addRates(result.rates, [rate(null, carrier ? { name: carrier, carrier } : { name: "Carrier rates" })]);
      }
      break;
    }
    default:
      // A kind of option this code does not know. It is there, so say so.
      result.more = true;
  }

  // Several prices under one name: they differ by the warehouse an order leaves from.
  if (result.rates.length > 1 && option.__typename === "DeliveryFlatRateOptionDefinition") {
    for (const entry of result.rates) entry.conditions.push("depending on where the order is sent from");
  }
  return result;
}

/** A market's own delivery settings, or its parent's where it has none of its own. */
type Resolved = { known: true; shipping: Loose | null } | { known: false };

/**
 * The delivery zones of a store that keeps its shipping with its markets,
 * from what the Admin API returns for them: one zone per active market, with
 * the countries it sells to and the delivery options every order gets there.
 *
 * - A market with no settings of its own uses its parent's; with no parent,
 *   Shopify's default is no delivery.
 * - A market with delivery switched off, or with no option set, delivers
 *   nothing: its zone has no rates, so its countries are not counted as
 *   delivered to.
 * - Where a country is in a market and in one nested inside it, the buyer is
 *   in the inner one, so only that one lists the country.
 * - A draft market sells to nobody and is left out.
 *
 * Anything not shaped as expected is left out instead of guessed at.
 */
export function readMarketShipping(
  data: unknown,
): Pick<ShippingRates, "zones" | "truncated" | "otherProfiles"> {
  const found = page(isObject(data) ? data.markets : null);
  let truncated = found.more;
  let otherProfiles = false;

  const byId = new Map<string, Loose>();
  for (const market of found.nodes) {
    if (typeof market.id === "string") byId.set(market.id, market);
  }

  /** The id of a market's parent; null when it has none; undefined when that cannot be told. */
  const parentOf = (market: Loose): string | null | undefined => {
    if (!isObject(market.parentMarkets) || !Array.isArray(market.parentMarkets.nodes)) return undefined;
    const [parent] = objects(market.parentMarkets.nodes);
    if (!parent) return null;
    return typeof parent.id === "string" ? parent.id : undefined;
  };

  /** Every market above this one, nearest first. */
  const ancestorsOf = (market: Loose): string[] => {
    const chain: string[] = [];
    let current: Loose | undefined = market;
    while (current && chain.length < 8) {
      const parent = parentOf(current);
      if (typeof parent !== "string" || chain.includes(parent)) break;
      chain.push(parent);
      current = byId.get(parent);
    }
    return chain;
  };

  const resolve = (market: Loose): Resolved => {
    let current = market;
    for (let depth = 0; depth < 8; depth += 1) {
      if (!isObject(current.delivery)) return { known: false };
      const own = current.delivery.shipping;
      if (isObject(own)) return { known: true, shipping: own };
      if (own !== null) return { known: false };
      // None of its own: its parent's apply.
      const parent = parentOf(current);
      if (parent === null) return { known: true, shipping: null };
      const above = typeof parent === "string" ? byId.get(parent) : undefined;
      if (!above) return { known: false };
      current = above;
    }
    return { known: false };
  };

  // Where each active market sells.
  const active = found.nodes
    .filter((market) => market.status === "ACTIVE")
    .map((market) => {
      const conditions = isObject(market.conditions) ? market.conditions : {};
      const regions = isObject(conditions.regionsCondition) ? conditions.regionsCondition : {};
      const listed = page(regions.regions);
      if (listed.more) truncated = true;

      const whole = new Set<string>();
      const parts = new Map<string, string[]>();
      for (const region of listed.nodes) {
        if (region.__typename === "MarketRegionCountry") {
          if (isCountryCode(region.code)) whole.add(region.code);
        } else if (region.__typename === "MarketRegionSubdivision") {
          const country = isObject(region.country) ? region.country.code : null;
          const name = clean(region.name, 60) || clean(region.subdivisionCode, 10);
          if (isCountryCode(country) && name) parts.set(country, [...(parts.get(country) ?? []), name]);
        }
      }
      return { market, whole, parts, everywhere: regions.applicationLevel === "ALL" };
    });

  const zones: ShippingZone[] = [];
  for (const entry of active) {
    const id = typeof entry.market.id === "string" ? entry.market.id : "";
    // A country also named by a market nested inside this one belongs to that one.
    const nested = active.filter(
      (other) => other !== entry && id !== "" && ancestorsOf(other.market).includes(id),
    );
    const countries = [...entry.whole].filter(
      (code) => !nested.some((other) => other.whole.has(code)),
    );
    // A country named whole has no need of its parts listed as well.
    const parts = [...entry.parts].filter(([code]) => !countries.includes(code));
    if (!countries.length && !parts.length && !entry.everywhere) continue;

    const zone: ShippingZone = {
      name: clean(entry.market.name, 80) || "Market",
      countries: [...new Set([...countries, ...parts.map(([code]) => code)])].sort(),
      restOfWorld: entry.everywhere,
      ...(parts.length
        ? { parts: Object.fromEntries(parts.map(([code, names]) => [code, [...names].sort()])) }
        : {}),
      rates: [],
    };

    const resolved = resolve(entry.market);
    if (!resolved.known) {
      zone.more = true;
    } else if (resolved.shipping && resolved.shipping.isEnabled !== false) {
      const options = page(resolved.shipping.optionDefinitions);
      if (options.more) zone.more = true;
      for (const option of options.nodes) {
        const read = readMarketOption(option);
        addRates(zone.rates, read.rates);
        if (read.more) zone.more = true;
        if (read.someProducts) {
          otherProfiles = true;
          zone.more = true;
        }
      }
    }
    zones.push(zone);
  }
  return { zones, truncated, otherProfiles };
}

// ---------------------------------------------------------------------------
// In words
// ---------------------------------------------------------------------------

/** What a rate costs: "free", "10.00 CAD", or that the checkout works it out. */
export function rateCost(rate: ShippingRate): string {
  if (!rate.price) {
    return `calculated at checkout${rate.carrier && rate.carrier !== rate.name ? ` by ${rate.carrier}` : ""}`;
  }
  return Number(rate.price.amount) === 0 ? "free" : moneyText(rate.price.amount, rate.price.currencyCode);
}

/** "70.00 USD or more", for a rate that is waived on large orders. Empty otherwise. */
export function freeFromText(rate: ShippingRate): string {
  return rate.freeFrom
    ? `${moneyText(rate.freeFrom.amount, rate.freeFrom.currencyCode)} or more`
    : "";
}

/** "Standard: 8.00 USD, free on orders of 70.00 USD or more (3 to 5 business days)". */
export function rateText(rate: ShippingRate): string {
  const free = freeFromText(rate);
  const notes = [rate.conditions.join(" and "), rate.delivery ?? ""].filter(Boolean);
  return `${rate.name}: ${rateCost(rate)}${free ? `, free on orders of ${free}` : ""}${
    notes.length ? ` (${notes.join("; ")})` : ""
  }`;
}

/** The zones that deliver to a country: those naming it, or else those taking "the rest of the world". */
export function zonesFor(rates: ShippingRates, countryCode: string): ShippingZone[] {
  const named = rates.zones.filter((zone) => zone.countries.includes(countryCode));
  return named.length ? named : rates.zones.filter((zone) => zone.restOfWorld);
}

/** Whether a zone has anything to deliver with: a rate, or options the checkout shows. */
export const zoneDelivers = (zone: ShippingZone): boolean => zone.rates.length > 0 || zone.more === true;

/** ISO codes of the countries the zones name and deliver to, each once. */
export function deliveredCountries(rates: ShippingRates): string[] {
  return [...new Set(rates.zones.filter(zoneDelivers).flatMap((zone) => zone.countries))].sort();
}

const ALIASES = new Map<string, string>([
  ["uk", "GB"],
  ["great britain", "GB"],
  ["britain", "GB"],
  ["england", "GB"],
  ["scotland", "GB"],
  ["wales", "GB"],
  ["usa", "US"],
  ["u.s.", "US"],
  ["u.s.a.", "US"],
  ["america", "US"],
  ["united states of america", "US"],
  ["uae", "AE"],
  ["emirates", "AE"],
  ["south korea", "KR"],
  ["korea", "KR"],
  ["russia", "RU"],
  ["holland", "NL"],
  ["the netherlands", "NL"],
  ["turkey", "TR"],
  ["czech republic", "CZ"],
  ["hong kong", "HK"],
  ["macau", "MO"],
  ["vietnam", "VN"],
  ["ivory coast", "CI"],
]);

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
  const alias = ALIASES.get(wanted);
  if (alias) return alias;

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

/** A zone's country by name, with the parts it is limited to: "Canada (Ontario, Quebec only)". */
export function zoneCountryName(zone: ShippingZone, code: string): string {
  const parts = zone.parts?.[code];
  return parts?.length ? `${countryName(code)} (${parts.join(", ")} only)` : countryName(code);
}

// ---------------------------------------------------------------------------
// For the admin
// ---------------------------------------------------------------------------

/** The rates as a settings page shows them: already in words, already named. */
export interface ShippingView {
  state: ShippingRates["state"];
  model?: ShippingRates["model"];
  /** The first few zones: where each delivers and what it charges. */
  zones: Array<{ where: string; rates: string[] }>;
  /** Zones that were read beyond those shown. */
  more: number;
  /** Shopify has more zones still than were read, so every count here is a floor. */
  truncated: boolean;
  /** Countries delivered to, by name, alphabetical. */
  countries: string[];
  /** A zone takes every country not named. */
  restOfWorld: boolean;
  otherProfiles: boolean;
  /** How soon orders are handed to the carrier, in words. Empty when Shopify does not say. */
  processing: string;
  /** Every rate shown carries its own delivery time, so no other answer is needed for it. */
  deliveryTimes: boolean;
}

const SHOWN_ZONES = 6;
const NAMED_IN_ZONE = 4;

function whereText(zone: ShippingZone): string {
  const names = zone.countries
    .map((code) => zoneCountryName(zone, code))
    .sort((a, b) => a.localeCompare(b));
  const listed =
    names.length <= NAMED_IN_ZONE
      ? names.join(", ")
      : `${names.slice(0, NAMED_IN_ZONE).join(", ")} and ${names.length - NAMED_IN_ZONE} more`;
  if (!zone.restOfWorld) return listed;
  return listed ? `${listed}, and the rest of the world` : "Rest of the world";
}

function zoneRatesText(zone: ShippingZone): string[] {
  if (!zone.rates.length) {
    return [zone.more ? "Delivery options are shown at checkout" : "No delivery options set"];
  }
  return [...zone.rates.map(rateText), ...(zone.more ? ["More options are shown at checkout"] : [])];
}

/**
 * Worked out where the page's data is prepared (the server), because a
 * server and a browser do not always agree on a country's name.
 */
export function shippingForPage(rates: ShippingRates): ShippingView {
  const delivering = rates.zones.filter(zoneDelivers);
  const quoted = delivering.flatMap((zone) => zone.rates);
  return {
    state: rates.state,
    ...(rates.model ? { model: rates.model } : {}),
    zones: rates.zones.slice(0, SHOWN_ZONES).map((zone) => ({
      where: whereText(zone),
      rates: zoneRatesText(zone),
    })),
    more: Math.max(0, rates.zones.length - SHOWN_ZONES),
    truncated: rates.truncated,
    countries: deliveredCountries(rates)
      .map(countryName)
      .sort((a, b) => a.localeCompare(b)),
    restOfWorld: delivering.some((zone) => zone.restOfWorld),
    otherProfiles: rates.otherProfiles,
    processing:
      rates.processingDays === undefined
        ? ""
        : `Orders are handed to the carrier ${processingText(rates.processingDays)}.`,
    deliveryTimes:
      quoted.length > 0 &&
      quoted.every((rate) => Boolean(rate.delivery)) &&
      !delivering.some((zone) => zone.more),
  };
}
