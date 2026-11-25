import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "../app/assistant/prompts";
import {
  NO_SHIPPING_RATES,
  countryCodeFor,
  deliveredCountries,
  moneyText,
  processingText,
  rateText,
  readMarketShipping,
  readProcessingDays,
  readShippingProfile,
  shippingForPage,
  transitText,
  zonesFor,
  type ShippingRates,
} from "../app/assistant/shipping";
import {
  loadShippingRates,
  MARKET_SHIPPING_QUERY,
  SHIPPING_MODEL_QUERY,
  SHIPPING_RATES_QUERY,
  SHIPPING_SETUP_QUERY,
} from "../app/assistant/shipping.server";
import { shopperTools } from "../app/assistant/tools";
import type { ToolContext } from "../app/assistant/tools/registry";
import { toolsFor } from "../app/assistant/tools/registry";
import { PAYMENT_SETTINGS_QUERY, SHIPS_TO_QUERY } from "../app/assistant/tools/storefront-queries";
import { syncedRows } from "../app/components/settings/SyncedFromShopify";
import { fakeGraphql, toolContext } from "./helpers/fakes";

// ---------------------------------------------------------------------------
// A store that keeps its shipping in profiles (zones and rates)
// ---------------------------------------------------------------------------

const money = (amount: string) => ({ amount, currencyCode: "CAD" });

/** A rate as the Admin API returns it. */
const method = (name: string, overrides: Record<string, unknown> = {}) => ({
  name,
  active: true,
  description: null,
  rateProvider: { price: money("10.0") },
  methodConditions: [],
  ...overrides,
});
const country = (code: string) => ({ code: { countryCode: code, restOfWorld: false } });
const REST = { code: { countryCode: null, restOfWorld: true } };
const zone = (name: string, countries: unknown[], methods: unknown[], moreMethods = false) => ({
  zone: { name, countries },
  methodDefinitions: { pageInfo: { hasNextPage: moreMethods }, nodes: methods },
});
/** What Shopify answers for one shipping profile. */
const profile = (groups: unknown[][], hasNextPage = false) => ({
  deliveryProfile: {
    profileLocationGroups: groups.map((nodes) => ({
      locationGroupZones: { pageInfo: { hasNextPage }, nodes },
    })),
  },
});

const NORTH_AMERICA = zone(
  "North America",
  [country("US"), country("CA")],
  [
    method("Standard", {
      methodConditions: [
        { field: "TOTAL_PRICE", operator: "LESS_THAN_OR_EQUAL_TO", conditionCriteria: money("99.99") },
      ],
    }),
    method("Free shipping", {
      rateProvider: { price: money("0.0") },
      methodConditions: [
        { field: "TOTAL_PRICE", operator: "GREATER_THAN_OR_EQUAL_TO", conditionCriteria: money("100.0") },
      ],
    }),
    method("Heavy items", {
      rateProvider: { price: money("25.0") },
      description: "5 to 8 business days",
      methodConditions: [
        { field: "TOTAL_WEIGHT", operator: "GREATER_THAN_OR_EQUAL_TO", conditionCriteria: { unit: "KILOGRAMS", value: 20 } },
      ],
    }),
    method("Switched off", { active: false }),
  ],
);
const EVERYWHERE_ELSE = zone("Rest of world", [REST], [
  method("Worldwide express", { rateProvider: { carrierService: { formattedName: "DHL Express", name: "dhl" } } }),
]);
const STORE = profile([[NORTH_AMERICA, EVERYWHERE_ELSE]]);

/** The profile above, as the reader hands it on. */
const profileRates = (overrides: Partial<ShippingRates> = {}): ShippingRates => ({
  state: "live",
  model: "profiles",
  ...readShippingProfile(STORE),
  otherProfiles: false,
  ...overrides,
});

// ---------------------------------------------------------------------------
// A store that keeps its shipping with its markets
// ---------------------------------------------------------------------------

const usd = (amount: string) => ({ amount, currencyCode: "USD" });
const DAY = 24 * 60 * 60;
const one = { pageInfo: { hasNextPage: false } };

/** A group of rates: for every product unless `collections` says how many it is limited to. */
const group = (content: Record<string, unknown>, collections: number | null = null) => ({
  conditions: { collectionsCount: collections === null ? null : { count: collections } },
  ...content,
});
const flatRate = (price: string, transit: [number | null, number | null] = [null, null]) => ({
  rate: { price: usd(price), transitTimeMinSeconds: transit[0], transitTimeMaxSeconds: transit[1] },
});
/** A fixed-price delivery option, as the Admin API returns it. */
const flat = (name: string, groups: unknown[], overrides: Record<string, unknown> = {}) => ({
  __typename: "DeliveryFlatRateOptionDefinition",
  description: null,
  isActive: true,
  freeDeliveryMinimumValue: null,
  name,
  flatGroups: { ...one, nodes: groups },
  ...overrides,
});
const shipping = (nodes: unknown[], overrides: Record<string, unknown> = {}) => ({
  isEnabled: true,
  optionDefinitions: { ...one, nodes },
  ...overrides,
});
const inCountry = (code: string) => ({ __typename: "MarketRegionCountry", name: code, code });
const inPart = (countryCode: string, code: string, name: string) => ({
  __typename: "MarketRegionSubdivision",
  name,
  subdivisionCode: code,
  country: { code: countryCode },
});
const market = (
  name: string,
  regions: unknown[],
  settings: unknown,
  overrides: Record<string, unknown> = {},
) => ({
  id: `gid://shopify/Market/${name}`,
  name,
  status: "ACTIVE",
  conditions: { regionsCondition: { applicationLevel: "SPECIFIED", regions: { ...one, nodes: regions } } },
  parentMarkets: { nodes: [] },
  delivery: { shipping: settings },
  ...overrides,
});
const under = (parent: string) => ({ parentMarkets: { nodes: [{ id: `gid://shopify/Market/${parent}` }] } });
const markets = (nodes: unknown[], hasNextPage = false) => ({
  markets: { pageInfo: { hasNextPage }, nodes },
});

/**
 * What a real store on market-driven shipping answered (a development store,
 * November 2026): two markets, one rate for Canada, two for the United States.
 */
const CANADA = market("Canada", [inCountry("CA")], shipping([flat("International Shipping", [group(flatRate("30.0"))])]));
const UNITED_STATES = market(
  "United States",
  [inCountry("US")],
  shipping([
    flat("Standard", [group(flatRate("8.0", [3 * DAY, 5 * DAY]))], { freeDeliveryMinimumValue: usd("70.0") }),
    flat("Express", [group(flatRate("15.0", [DAY, 2 * DAY]))]),
  ]),
);
const TWO_MARKETS = markets([CANADA, UNITED_STATES]);

const marketRates = (answer: unknown = TWO_MARKETS, overrides: Partial<ShippingRates> = {}): ShippingRates => ({
  state: "live",
  model: "markets",
  ...readMarketShipping(answer),
  ...overrides,
});
const texts = (answer: unknown) =>
  readMarketShipping(answer).zones.map((entry) => [entry.name, entry.rates.map(rateText)]);

/** An Admin API that answers the shipping queries, and records them. */
function shippingAdmin(
  options: {
    /** Shopify's word on which set-up the store uses. Null: it does not say. */
    marketDriven?: boolean | null;
    /** The general profile's zones, or the error asking for them gives. */
    rates?: unknown;
    /** The markets, or the error asking for them gives. */
    marketsAnswer?: unknown;
    profiles?: Array<{ id: string; default: boolean }>;
    moreProfiles?: boolean;
    /** Ids of the profiles that are the merchant's own. Default: all of them. */
    own?: string[];
    processingTime?: string | null;
    /** The error the profiles-and-processing-time question gives. */
    setup?: Error;
  } = {},
) {
  const profiles = options.profiles ?? [
    { id: "gid://shopify/DeliveryProfile/2", default: false },
    { id: "gid://shopify/DeliveryProfile/1", default: true },
  ];
  const asked: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  const admin = (async (query: string, variables?: Record<string, unknown>) => {
    asked.push({ query, variables });
    const answer = (value: unknown) => {
      if (value instanceof Error) throw value;
      return value;
    };
    if (query === SHIPPING_MODEL_QUERY) {
      const flag = options.marketDriven === undefined ? false : options.marketDriven;
      return { shop: { features: flag === null ? null : { marketDrivenShipping: flag } } };
    }
    if (query === SHIPPING_SETUP_QUERY) {
      if (options.setup) throw options.setup;
      return {
        deliveryPromiseSettings: {
          processingTime: options.processingTime === undefined ? "P2D" : options.processingTime,
        },
        all: { pageInfo: { hasNextPage: options.moreProfiles === true }, nodes: profiles },
        own: {
          pageInfo: { hasNextPage: false },
          nodes: (options.own ?? profiles.map((entry) => entry.id)).map((id) => ({ id })),
        },
      };
    }
    if (query === SHIPPING_RATES_QUERY) return answer(options.rates ?? STORE);
    if (query === MARKET_SHIPPING_QUERY) return answer(options.marketsAnswer ?? TWO_MARKETS);
    throw new Error("unexpected query");
  }) as NonNullable<ToolContext["admin"]>;
  const count = (query: string) => asked.filter((call) => call.query === query).length;
  return { admin, asked, count };
}

describe("reading a store's shipping profiles", () => {
  it("turns Shopify's zones and rates into plain ones, leaving out rates that are switched off", () => {
    const { zones, truncated } = readShippingProfile(STORE);
    expect(truncated).toBe(false);
    expect(zones.map((entry) => [entry.name, entry.countries, entry.restOfWorld])).toEqual([
      ["North America", ["CA", "US"], false],
      ["Rest of world", [], true],
    ]);
    expect(zones[0].rates.map(rateText)).toEqual([
      "Standard: 10.00 CAD (orders up to 99.99 CAD)",
      "Free shipping: free (orders of 100.00 CAD or more)",
      "Heavy items: 25.00 CAD (orders weighing 20 kg or more)",
    ]);
    expect(zones[0].rates[2].description).toBe("5 to 8 business days");
    // A carrier's own rate has no fixed price: the checkout works it out.
    expect(zones[1].rates.map(rateText)).toEqual(["Worldwide express: calculated at checkout by DHL Express"]);
  });

  it("lists a zone once however many warehouses serve it, with every rate that reaches it", () => {
    const again = zone("NA from warehouse 2", [country("CA"), country("US")], [
      method("Standard", {
        methodConditions: [
          { field: "TOTAL_PRICE", operator: "LESS_THAN_OR_EQUAL_TO", conditionCriteria: money("99.99") },
        ],
      }),
      method("Overnight", { rateProvider: { price: money("40.0") } }),
    ]);
    const { zones } = readShippingProfile(profile([[NORTH_AMERICA], [again]]));
    expect(zones).toHaveLength(1);
    expect(zones[0].rates.map((rate) => rate.name)).toEqual([
      "Standard",
      "Free shipping",
      "Heavy items",
      "Overnight",
    ]);
  });

  it("guesses nothing from an answer that is not shaped as expected", () => {
    // An answer that is not one is "not all read". It is never "no zones".
    for (const odd of [
      null,
      {},
      { deliveryProfile: null },
      { deliveryProfile: { profileLocationGroups: "x" } },
      { deliveryProfile: { profileLocationGroups: [{ locationGroupZones: null }] } },
      { deliveryProfile: { profileLocationGroups: [{ locationGroupZones: { nodes: [null] } }] } },
    ]) {
      expect(readShippingProfile(odd)).toEqual({ zones: [], truncated: true });
    }
    // A profile that really has no zones is a different thing, and is said to be read in full.
    expect(readShippingProfile({ deliveryProfile: { profileLocationGroups: [] } })).toEqual({ zones: [], truncated: false });
    expect(readShippingProfile(profile([[]]))).toEqual({ zones: [], truncated: false });
    const messy = profile([
      [
        zone("No countries", [], [method("Lost")]),
        zone("Bad codes", [{ code: { countryCode: "Canada" } }], [method("Lost")]),
        zone("Kept", [country("PK")], [
          { name: "", active: true },
          method("No price", { rateProvider: {} }),
          method("Odd condition", {
            methodConditions: [{ field: "MOON_PHASE", operator: "GREATER_THAN_OR_EQUAL_TO", conditionCriteria: {} }],
          }),
        ]),
      ],
    ]);
    const { zones, truncated } = readShippingProfile(messy);
    // Zones and rates that make no sense are left out; the lists themselves were all there.
    expect(truncated).toBe(false);
    expect(zones.map((entry) => entry.name)).toEqual(["Kept"]);
    expect(zones[0].rates.map(rateText)).toEqual([
      "No price: calculated at checkout",
      "Odd condition: 10.00 CAD",
    ]);
  });

  it("says so when Shopify has more zones or more rates than it returned", () => {
    expect(readShippingProfile(profile([[NORTH_AMERICA]], true)).truncated).toBe(true);
    const complete = readShippingProfile(profile([[NORTH_AMERICA]]));
    expect(complete.truncated).toBe(false);
    expect(complete.zones[0]).not.toHaveProperty("more");
    // More rates in a zone than one page holds: the zone has more to offer.
    const cut = readShippingProfile(profile([[zone("Europe", [country("FR")], [method("Standard")], true)]]));
    expect(cut.zones[0].more).toBe(true);
  });

  it("writes money the way each currency is written", () => {
    expect(moneyText("10.0", "CAD")).toBe("10.00 CAD");
    expect(moneyText("1000.0", "JPY")).toBe("1000 JPY");
    expect(moneyText("4.5", "KWD")).toBe("4.500 KWD");
    expect(moneyText("not a number", "USD")).toBe("not a number USD");
  });

  it("finds the zone for a country, falling back to the rest-of-the-world zone", () => {
    const rates = profileRates();
    expect(zonesFor(rates, "CA").map((entry) => entry.name)).toEqual(["North America"]);
    expect(zonesFor(rates, "DE").map((entry) => entry.name)).toEqual(["Rest of world"]);
    const northOnly: ShippingRates = { ...rates, zones: rates.zones.slice(0, 1) };
    expect(zonesFor(northOnly, "DE")).toEqual([]);
  });

  it("recognises a country by code or by name", () => {
    expect(countryCodeFor("ca")).toBe("CA");
    expect(countryCodeFor(" Canada ")).toBe("CA");
    expect(countryCodeFor("united kingdom")).toBe("GB");
    expect(countryCodeFor("UK")).toBe("GB");
    expect(countryCodeFor("USA")).toBe("US");
    expect(countryCodeFor("Pakistan")).toBe("PK");
    // Words every object answers to are not countries.
    for (const unknown of ["", "ZZ", "Atlantis", "the moon", "constructor", "toString", "__proto__"]) {
      expect(countryCodeFor(unknown)).toBeNull();
    }
  });
});

describe("reading a store's markets", () => {
  it("turns each market into a zone with the rates every order gets", () => {
    const read = readMarketShipping(TWO_MARKETS);
    expect(read.truncated).toBe(false);
    expect(read.otherProfiles).toBe(false);
    expect(read.zones.map((entry) => [entry.name, entry.countries, entry.restOfWorld])).toEqual([
      ["Canada", ["CA"], false],
      ["United States", ["US"], false],
    ]);
    expect(texts(TWO_MARKETS)).toEqual([
      ["Canada", ["International Shipping: 30.00 USD"]],
      [
        "United States",
        [
          // Free above an order value, and how long the parcel is on its way.
          "Standard: 8.00 USD, free on orders of 70.00 USD or more (3 to 5 business days)",
          "Express: 15.00 USD (1 to 2 business days)",
        ],
      ],
    ]);
    expect(read.zones[1].rates[0]).toEqual({
      name: "Standard",
      price: usd("8.0"),
      conditions: [],
      freeFrom: usd("70.0"),
      delivery: "3 to 5 business days",
    });
    expect(deliveredCountries(marketRates())).toEqual(["CA", "US"]);
  });

  it("reads rates that depend on the order's value or weight, and a carrier's own", () => {
    const tier = (price: string, extra: Record<string, unknown>) => ({
      price: usd(price),
      transitTimeMinSeconds: null,
      transitTimeMaxSeconds: null,
      ...extra,
    });
    const kg = (value: number) => ({ unit: "KILOGRAMS", value });
    const byValue = {
      __typename: "DeliveryValueBasedOptionDefinition",
      description: "Tracked",
      isActive: true,
      freeDeliveryMinimumValue: null,
      name: "Standard",
      valueGroups: {
        ...one,
        nodes: [
          group({
            rates: {
              ...one,
              nodes: [
                tier("5.0", { minValue: usd("0.0"), maxValue: usd("49.99") }),
                tier("2.0", { minValue: usd("50.0"), maxValue: usd("99.99") }),
                tier("0.0", { minValue: usd("100.0"), maxValue: null }),
              ],
            },
          }),
        ],
      },
    };
    const byWeight = {
      __typename: "DeliveryWeightBasedOptionDefinition",
      description: null,
      isActive: true,
      freeDeliveryMinimumValue: null,
      name: "Freight",
      weightGroups: {
        ...one,
        nodes: [
          group({
            rates: {
              ...one,
              nodes: [
                tier("9.0", { minWeight: kg(0), maxWeight: kg(5) }),
                tier("19.0", { minWeight: kg(5), maxWeight: kg(20), transitTimeMinSeconds: 7 * DAY, transitTimeMaxSeconds: 7 * DAY }),
                tier("49.0", { minWeight: kg(20), maxWeight: null }),
              ],
            },
          }),
        ],
      },
    };
    const byCarrier = {
      __typename: "DeliveryCarrierCalculatedOptionDefinition",
      description: null,
      isActive: true,
      freeDeliveryMinimumValue: usd("150.0"),
      carrierGroups: {
        ...one,
        nodes: [group({ carrierService: { formattedName: "UPS Shipping", name: "ups_shipping" } })],
      },
    };
    const read = readMarketShipping(markets([market("Europe", [inCountry("DE")], shipping([byValue, byWeight, byCarrier]))]));
    expect(read.zones[0].rates.map(rateText)).toEqual([
      "Standard: 5.00 USD (orders up to 49.99 USD)",
      "Standard: 2.00 USD (orders from 50.00 USD to 99.99 USD)",
      "Standard: free (orders of 100.00 USD or more)",
      "Freight: 9.00 USD (orders weighing up to 5 kg)",
      "Freight: 19.00 USD (orders weighing 5 kg to 20 kg; 7 business days)",
      "Freight: 49.00 USD (orders weighing 20 kg or more)",
      // The carrier prices each parcel; the store waives it on large orders.
      "UPS Shipping: calculated at checkout, free on orders of 150.00 USD or more",
    ]);
    expect(read.zones[0].rates[0].description).toBe("Tracked");
    expect(read.zones[0]).not.toHaveProperty("more");
  });

  it("writes a transit time as the days a buyer is told, never sooner than the store set", () => {
    expect(transitText(3 * DAY, 5 * DAY)).toBe("3 to 5 business days");
    expect(transitText(DAY, DAY)).toBe("1 business day");
    expect(transitText(null, 2 * DAY)).toBe("up to 2 business days");
    expect(transitText(2 * DAY, null)).toBe("2 business days");
    // Part of a day counts as a whole one.
    expect(transitText(DAY / 2, 1.5 * DAY)).toBe("1 to 2 business days");
    for (const [low, high] of [[null, null], [0, 0], ["2 days", undefined], [-DAY, null], [400 * DAY, 500 * DAY]]) {
      expect(transitText(low, high)).toBe("");
    }
  });

  it("delivers nothing where delivery is switched off or was never set up", () => {
    const off = market("Canada", [inCountry("CA")], shipping([flat("Standard", [group(flatRate("9.0"))])], { isEnabled: false }));
    // No settings of its own and no market above it: Shopify's default is no delivery.
    const unset = market("Mexico", [inCountry("MX")], null);
    const empty = market("Brazil", [inCountry("BR")], shipping([]));
    const inactive = market("Chile", [inCountry("CL")], shipping([flat("Paused", [group(flatRate("9.0"))], { isActive: false })]));
    const rates = marketRates(markets([off, unset, empty, inactive, UNITED_STATES]));

    expect(rates.zones.map((entry) => [entry.name, entry.rates.length, entry.more ?? false])).toEqual([
      ["Canada", 0, false],
      ["Mexico", 0, false],
      ["Brazil", 0, false],
      ["Chile", 0, false],
      ["United States", 2, false],
    ]);
    // Only the one that delivers counts as delivered to.
    expect(deliveredCountries(rates)).toEqual(["US"]);
    // The country is still found, so the answer is "no", not a rate from elsewhere.
    expect(zonesFor(rates, "CA").map((entry) => entry.name)).toEqual(["Canada"]);
  });

  it("uses the settings of the market above where a market has none of its own", () => {
    const europe = market("Europe", [inCountry("DE"), inCountry("IT")], shipping([flat("EU post", [group(flatRate("12.0"))])]));
    const italy = market("Italy", [inCountry("IT")], null, under("Europe"));
    const read = readMarketShipping(markets([europe, italy]));
    // Italy is in both; a buyer there is in the inner market, which names it alone.
    expect(read.zones.map((entry) => [entry.name, entry.countries, entry.rates.map(rateText)])).toEqual([
      ["Europe", ["DE"], ["EU post: 12.00 USD"]],
      ["Italy", ["IT"], ["EU post: 12.00 USD"]],
    ]);

    // With settings of its own, the inner market's are the ones that count.
    const france = market("France", [inCountry("FR")], shipping([flat("Colissimo", [group(flatRate("6.0"))])]), under("Europe"));
    const wide = market("Europe", [inCountry("DE"), inCountry("FR")], shipping([flat("EU post", [group(flatRate("12.0"))])]));
    const nested = marketRates(markets([wide, france]));
    expect(zonesFor(nested, "FR").flatMap((entry) => entry.rates.map(rateText))).toEqual(["Colissimo: 6.00 USD"]);
    expect(zonesFor(nested, "DE").flatMap((entry) => entry.rates.map(rateText))).toEqual(["EU post: 12.00 USD"]);

    // A market above that was not read: its rates are not known, and nothing is made up.
    const orphan = readMarketShipping(markets([market("Spain", [inCountry("ES")], null, under("Not read"))]));
    expect(orphan.zones[0]).toMatchObject({ rates: [], more: true });
  });

  it("leaves out draft markets, and keeps a market that sells everywhere as the rest of the world", () => {
    const draft = market("Japan", [inCountry("JP")], shipping([flat("Post", [group(flatRate("20.0"))])]), { status: "DRAFT" });
    const world = market("International", [], shipping([flat("Worldwide", [group(flatRate("40.0"))])]), {
      conditions: { regionsCondition: { applicationLevel: "ALL", regions: { ...one, nodes: [] } } },
    });
    const rates = marketRates(markets([draft, world, UNITED_STATES]));
    expect(rates.zones.map((entry) => [entry.name, entry.restOfWorld])).toEqual([
      ["International", true],
      ["United States", false],
    ]);
    expect(zonesFor(rates, "JP").map((entry) => entry.name)).toEqual(["International"]);
    expect(zonesFor(rates, "US").map((entry) => entry.name)).toEqual(["United States"]);
  });

  it("keeps a market for part of a country apart from the whole country", () => {
    const provinces = market(
      "Central Canada",
      [inPart("CA", "QC", "Quebec"), inPart("CA", "ON", "Ontario")],
      shipping([flat("Local", [group(flatRate("5.0"))])]),
    );
    const read = marketRates(markets([provinces, UNITED_STATES]));
    expect(read.zones[0]).toMatchObject({
      countries: ["CA"],
      parts: { CA: ["Ontario", "Quebec"] },
    });
    expect(shippingForPage(read).zones[0].where).toBe("Canada (Ontario, Quebec only)");

    // What a market nested inside takes is no longer the outer one's: one
    // province of several, or every province where it takes the whole country.
    const local = [flat("Local", [group(flatRate("5.0"))])];
    const outer = market(
      "North America",
      [inCountry("US"), inPart("CA", "ON", "Ontario"), inPart("CA", "QC", "Quebec"), inPart("MX", "CMX", "Mexico City")],
      shipping(local),
    );
    const ontario = market("Ontario", [inPart("CA", "ON", "Ontario")], shipping(local), under("North America"));
    const mexico = market("Mexico", [inCountry("MX")], shipping(local), under("North America"));
    const nested = readMarketShipping(markets([outer, ontario, mexico]));
    expect(nested.zones.map((entry) => [entry.name, entry.countries, entry.parts ?? null])).toEqual([
      ["North America", ["CA", "US"], { CA: ["Quebec"] }],
      ["Ontario", ["CA"], { CA: ["Ontario"] }],
      ["Mexico", ["MX"], null],
    ]);
  });

  it("covers the rest of a country from the market that sells everywhere else", () => {
    const world = market("International", [], shipping([flat("Worldwide", [group(flatRate("40.0"))])]), {
      conditions: { regionsCondition: { applicationLevel: "ALL", regions: { ...one, nodes: [] } } },
    });
    const california = market(
      "California",
      [inPart("US", "CA", "California")],
      shipping([flat("Local", [group(flatRate("5.0"))])]),
      under("International"),
    );
    const rates = marketRates(markets([world, california, CANADA]));
    // Named only in part: the rest of the country is "everywhere else" too.
    expect(zonesFor(rates, "US").map((entry) => entry.name)).toEqual(["California", "International"]);
    // Named whole, or not at all: as before.
    expect(zonesFor(rates, "CA").map((entry) => entry.name)).toEqual(["Canada"]);
    expect(zonesFor(rates, "DE").map((entry) => entry.name)).toEqual(["International"]);
  });

  it("gives only the rates every order gets, and says when some products have their own", () => {
    const mixed = flat("Standard", [group(flatRate("8.0")), group(flatRate("60.0"), 2)]);
    const bulkyOnly = flat("Furniture delivery", [group(flatRate("120.0"), 1)]);
    const read = readMarketShipping(markets([market("United States", [inCountry("US")], shipping([mixed, bulkyOnly]))]));
    expect(read.zones[0].rates.map(rateText)).toEqual(["Standard: 8.00 USD"]);
    expect(read.zones[0].more).toBe(true);
    expect(read.otherProfiles).toBe(true);

    // Rates that are all for certain products: none to quote, but the country is delivered to.
    const special = marketRates(markets([market("Canada", [inCountry("CA")], shipping([bulkyOnly]))]));
    expect(special.zones[0]).toMatchObject({ rates: [], more: true });
    expect(deliveredCountries(special)).toEqual(["CA"]);

    // One option at two prices: they differ by the warehouse the order leaves from.
    const twoWarehouses = flat("Standard", [group(flatRate("8.0")), group(flatRate("11.0"))]);
    expect(texts(markets([market("United States", [inCountry("US")], shipping([twoWarehouses]))]))[0][1]).toEqual([
      "Standard: 8.00 USD (depending on where the order is sent from)",
      "Standard: 11.00 USD (depending on where the order is sent from)",
    ]);
  });

  it("says so when Shopify has more than it returned", () => {
    const more = { pageInfo: { hasNextPage: true } };
    expect(readMarketShipping(markets([CANADA], true)).truncated).toBe(true);
    // More countries in a market than one page holds.
    const wide = market("World", [inCountry("DE")], shipping([flat("Post", [group(flatRate("9.0"))])]), {
      conditions: { regionsCondition: { applicationLevel: "SPECIFIED", regions: { ...more, nodes: [inCountry("DE")] } } },
    });
    expect(readMarketShipping(markets([wide])).truncated).toBe(true);

    // More options, more groups of rates, more tiers: the zone has more to offer.
    const moreOptions = market("A", [inCountry("AT")], { isEnabled: true, optionDefinitions: { ...more, nodes: [flat("Post", [group(flatRate("9.0"))])] } });
    const moreGroups = market("B", [inCountry("BE")], shipping([flat("Post", [group(flatRate("9.0"))], { flatGroups: { ...more, nodes: [group(flatRate("9.0"))] } })]));
    const read = readMarketShipping(markets([moreOptions, moreGroups, CANADA]));
    expect(read.truncated).toBe(false);
    expect(read.zones.map((entry) => entry.more ?? false)).toEqual([true, true, false]);
  });

  it("guesses nothing from an answer that is not shaped as expected", () => {
    // An answer that is not one is "not all read". It is never "no markets".
    for (const odd of [null, "markets", {}, { markets: null }, { markets: { nodes: "x" } }, { markets: { nodes: [null, 5, "m"] } }]) {
      expect(readMarketShipping(odd)).toEqual({ zones: [], truncated: true, otherProfiles: false });
    }
    // A store that really has no markets selling by region is a different thing.
    expect(readMarketShipping(markets([]))).toEqual({ zones: [], truncated: false, otherProfiles: false });
    // A market that does not say whether it is active, or where it sells, may sell somewhere.
    expect(readMarketShipping(markets([market("Odd", [inCountry("NO")], shipping([]), { status: undefined })])).truncated).toBe(true);
    expect(readMarketShipping(markets([market("Nowhere said", [], shipping([]), { conditions: null })]))).toEqual({
      zones: [],
      truncated: true,
      otherProfiles: false,
    });
    const read = readMarketShipping(
      markets([
        // No word on delivery at all: unknown, which is not the same as none.
        market("Unknown", [inCountry("NO")], null, { delivery: undefined }),
        market("No countries", [], shipping([flat("Lost", [group(flatRate("1.0"))])])),
        market("Bad codes", [{ __typename: "MarketRegionCountry", name: "Canada", code: "Canada" }], shipping([])),
        market(
          "Kept",
          [inCountry("PK"), { __typename: "SomethingNew", name: "Elsewhere" }],
          shipping([
            flat("No price", [group({ rate: { price: null } })]),
            flat("", [group(flatRate("3.0"))]),
            { __typename: "DeliveryDroneOptionDefinition", isActive: true, name: "Drone" },
          ]),
        ),
      ]),
    );
    expect(read.zones.map((entry) => entry.name)).toEqual(["Unknown", "Kept"]);
    // Every list was a list: what is odd inside them is left out, and the read is whole.
    expect(read.truncated).toBe(false);
    expect(read.zones[0]).toMatchObject({ rates: [], more: true });
    // A rate without a price is left out; one without a name still has its price.
    expect(read.zones[1].rates.map(rateText)).toEqual(["Delivery: 3.00 USD"]);
    // A kind of option not known here: it exists, so the zone says there is more.
    expect(read.zones[1].more).toBe(true);
  });
});

describe("asking Shopify for the rates", () => {
  it("reads the store's general profile on a store that keeps its shipping in profiles, every time", async () => {
    const { admin, asked, count } = shippingAdmin();
    const first = await loadShippingRates(admin);
    expect(first.state).toBe("live");
    expect(first.model).toBe("profiles");
    expect(first.zones).toHaveLength(2);
    // Another profile exists: some products have rates of their own.
    expect(first.otherProfiles).toBe(true);
    // The default profile was the one read, not simply the first listed.
    const ratesCalls = () => asked.filter((call) => call.query === SHIPPING_RATES_QUERY);
    expect(ratesCalls()[0].variables).toEqual({ id: "gid://shopify/DeliveryProfile/1" });
    // How soon orders leave comes with it, from the store's own setting.
    expect(first.processingDays).toBe(2);
    // The markets are not asked about: they do not hold this store's rates.
    expect(count(MARKET_SHIPPING_QUERY)).toBe(0);

    // Nothing is kept between calls: the second one asks Shopify again.
    await loadShippingRates(admin);
    expect(ratesCalls()).toHaveLength(2);
    expect([count(SHIPPING_MODEL_QUERY), count(SHIPPING_SETUP_QUERY)]).toEqual([2, 2]);
  });

  it("reads the markets on a store that has moved its shipping there, and never its old profiles", async () => {
    const { admin, count } = shippingAdmin({ marketDriven: true, processingTime: "P1D" });
    const rates = await loadShippingRates(admin);
    expect(rates).toMatchObject({ state: "live", model: "markets", processingDays: 1, otherProfiles: false });
    expect(rates.zones.map((entry) => [entry.name, entry.rates.map(rateText)])).toEqual([
      ["Canada", ["International Shipping: 30.00 USD"]],
      [
        "United States",
        [
          "Standard: 8.00 USD, free on orders of 70.00 USD or more (3 to 5 business days)",
          "Express: 15.00 USD (1 to 2 business days)",
        ],
      ],
    ]);
    // The old profile is still there to read, and its rates are not what the
    // checkout charges. It is never asked for.
    expect(count(SHIPPING_RATES_QUERY)).toBe(0);
    expect(count(MARKET_SHIPPING_QUERY)).toBe(1);

    await loadShippingRates(admin);
    expect(count(MARKET_SHIPPING_QUERY)).toBe(2);
  });

  it("notes an app's own shipping rates, which the checkout adds to the markets' own", async () => {
    const profiles = [
      { id: "gid://shopify/DeliveryProfile/1", default: true },
      { id: "gid://shopify/DeliveryProfile/7", default: false },
    ];
    const withApp = shippingAdmin({ marketDriven: true, profiles, own: ["gid://shopify/DeliveryProfile/1"] });
    expect((await loadShippingRates(withApp.admin)).otherProfiles).toBe(true);
    // The merchant's own old profiles count for nothing on a store on markets.
    const ownOnly = shippingAdmin({ marketDriven: true, profiles });
    expect((await loadShippingRates(ownOnly.admin)).otherProfiles).toBe(false);
  });

  it("reads neither when Shopify does not say which the store is on", async () => {
    const { admin, count } = shippingAdmin({ marketDriven: null });
    const rates = await loadShippingRates(admin);
    // The wrong one would give rates that look real and are not.
    expect(rates.state).toBe("unreachable");
    expect(rates).not.toHaveProperty("model");
    expect(rates.zones).toEqual([]);
    expect([count(SHIPPING_RATES_QUERY), count(MARKET_SHIPPING_QUERY)]).toEqual([0, 0]);
  });

  it("reads the processing time only as whole days, and does without it otherwise", async () => {
    expect(readProcessingDays("P1D")).toBe(1);
    expect(readProcessingDays("P0D")).toBe(0);
    expect(readProcessingDays("P14D")).toBe(14);
    for (const odd of [null, undefined, "", "PT24H", "P1W", "1 day", 1, "P1D ", "P-1D"]) {
      expect(readProcessingDays(odd)).toBeUndefined();
    }
    expect([0, 1, 3].map(processingText)).toEqual([
      "the same business day",
      "within 1 business day",
      "within 3 business days",
    ]);

    // Not set in Shopify: the rates are read all the same, without it.
    const unset = await loadShippingRates(shippingAdmin({ processingTime: null }).admin);
    expect(unset.state).toBe("live");
    expect(unset).not.toHaveProperty("processingDays");

    // It is its own question: known even while the rates need a permission.
    const denied = new Error("Admin GraphQL error: Access denied for markets field.");
    const waiting = await loadShippingRates(
      shippingAdmin({ marketDriven: true, marketsAnswer: denied, processingTime: "P1D" }).admin,
    );
    expect(waiting).toMatchObject({ state: "no_access", model: "markets", processingDays: 1, zones: [] });
  });

  it("says why when the rates cannot be read, instead of failing", async () => {
    expect(await loadShippingRates(undefined)).toEqual(NO_SHIPPING_RATES);

    // Shopify's own words when the store has not approved the permission.
    const denied = new Error("Admin GraphQL error: Access denied for deliveryProfiles field.");
    const waiting = await loadShippingRates(shippingAdmin({ setup: denied }).admin);
    // Which set-up the store is on needs no permission, so that is still known.
    expect(waiting).toEqual({ ...NO_SHIPPING_RATES, state: "no_access", model: "profiles" });

    const down = fakeGraphql(new Error("Admin GraphQL error: Throttled"));
    expect(await loadShippingRates(down)).toEqual(NO_SHIPPING_RATES);
    const halfway = await loadShippingRates(shippingAdmin({ rates: new Error("Admin GraphQL error: Throttled") }).admin);
    expect(halfway).toMatchObject({ state: "unreachable", model: "profiles", zones: [] });

    // A store with no shipping profile at all has, truthfully, no zones.
    const empty = shippingAdmin({ profiles: [], processingTime: null });
    expect(await loadShippingRates(empty.admin)).toEqual({
      state: "live",
      model: "profiles",
      zones: [],
      otherProfiles: false,
      truncated: false,
    });
    // More profiles than were listed, and the general one not among them: not known.
    const beyond = shippingAdmin({
      profiles: [{ id: "gid://shopify/DeliveryProfile/9", default: false }],
      moreProfiles: true,
      processingTime: null,
    });
    expect(await loadShippingRates(beyond.admin)).toMatchObject({ state: "live", zones: [], truncated: true });
    expect(beyond.count(SHIPPING_RATES_QUERY)).toBe(0);
  });
});

describe("the rates on the Settings page", () => {
  it("puts the rates into words", () => {
    const rates = profileRates({ otherProfiles: true });
    const view = shippingForPage(rates);
    expect(view).toMatchObject({
      state: "live",
      model: "profiles",
      countries: ["Canada", "United States"],
      restOfWorld: true,
      otherProfiles: true,
      more: 0,
      truncated: false,
      processing: "",
      deliveryTimes: false,
    });
    expect(shippingForPage({ ...rates, processingDays: 0 }).processing).toBe(
      "Orders are handed to the carrier the same business day.",
    );
    expect(view.zones).toEqual([
      {
        where: "Canada, United States",
        rates: [
          "Standard: 10.00 CAD (orders up to 99.99 CAD)",
          "Free shipping: free (orders of 100.00 CAD or more)",
          "Heavy items: 25.00 CAD (orders weighing 20 kg or more)",
        ],
      },
      { where: "Rest of the world", rates: ["Worldwide express: calculated at checkout by DHL Express"] },
    ]);

    const many = shippingForPage({
      ...rates,
      truncated: true,
      zones: Array.from({ length: 9 }, (_, index) => ({
        name: `Zone ${index}`,
        countries: ["CA", "US", "MX", "GB", "FR", "DE"],
        restOfWorld: index === 0,
        rates: [],
        ...(index === 2 ? { more: true } : {}),
      })),
    });
    expect(many.zones).toHaveLength(6);
    // Three more were read. That Shopify has more still is said apart, not added to the count.
    expect(many.more).toBe(3);
    expect(many.truncated).toBe(true);
    expect(many.zones[0].where).toBe("Canada, France, Germany, Mexico and 2 more, and the rest of the world");
    expect(many.zones[1].rates).toEqual(["No delivery options set"]);
    expect(many.zones[2].rates).toEqual(["Delivery options are shown at checkout"]);
  });

  it("shows a store's markets, and counts only the countries that are delivered to", () => {
    const off = market("Mexico", [inCountry("MX")], shipping([], { isEnabled: false }));
    const view = shippingForPage(marketRates(markets([CANADA, UNITED_STATES, off]), { processingDays: 1 }));
    expect(view).toMatchObject({
      model: "markets",
      countries: ["Canada", "United States"],
      restOfWorld: false,
      processing: "Orders are handed to the carrier within 1 business day.",
      // Canada's rate has no delivery time of its own, so the store's own answer is still needed.
      deliveryTimes: false,
    });
    expect(view.zones).toEqual([
      { where: "Canada", rates: ["International Shipping: 30.00 USD"] },
      {
        where: "United States",
        rates: [
          "Standard: 8.00 USD, free on orders of 70.00 USD or more (3 to 5 business days)",
          "Express: 15.00 USD (1 to 2 business days)",
        ],
      },
      { where: "Mexico", rates: ["No delivery options set"] },
    ]);
    // Every rate says how long it takes: nothing left to ask the merchant...
    expect(shippingForPage(marketRates(markets([UNITED_STATES]))).deliveryTimes).toBe(true);
    // ...unless there are markets that were not read, whose rates may not.
    expect(shippingForPage(marketRates(markets([UNITED_STATES], true))).deliveryTimes).toBe(false);
  });

  it("tells the merchant in one line where the rates stand", () => {
    const facts = { syncedAt: null, countries: [] };
    const rows = (rates: ShippingRates) => {
      const found = syncedRows(facts, shippingForPage(rates));
      const value = (label: string) => found.find((entry) => entry.label === label);
      return { rates: value("Shipping rates"), regions: value("Shipping regions") };
    };

    expect(rows(profileRates()).rates).toEqual({
      label: "Shipping rates",
      value: "2 zones, read live each time a shopper asks",
      tone: "success",
    });
    expect(rows(marketRates())).toEqual({
      rates: { label: "Shipping rates", value: "2 markets, read live each time a shopper asks", tone: "success" },
      regions: { label: "Shipping regions", value: "Canada, United States", tone: "success" },
    });
    // More than were read: the figures are floors, and are shown as floors.
    const cut = rows(marketRates(TWO_MARKETS, { truncated: true }));
    expect(cut.rates?.value).toBe("2+ markets, read live each time a shopper asks");
    expect(cut.regions?.value).toBe("at least 2 countries");

    expect(rows({ ...NO_SHIPPING_RATES, state: "no_access" }).rates?.tone).toBe("warning");
    expect(rows({ ...NO_SHIPPING_RATES, state: "live" }).rates?.value).toBe("None set up yet");
    // "None" only when everything was read.
    for (const partly of [{ truncated: true }, { otherProfiles: true }]) {
      expect(rows({ ...NO_SHIPPING_RATES, state: "live", model: "markets", ...partly })).toMatchObject({
        rates: { value: "Couldn't be read in full", tone: "neutral" },
        regions: { value: "Couldn't be read in full", tone: "neutral" },
      });
    }
    expect(rows(NO_SHIPPING_RATES).rates?.tone).toBe("neutral");
    // Without rates passed in, the row is simply not there.
    expect(syncedRows(facts).some((entry) => entry.label === "Shipping rates")).toBe(false);
  });

  it("shows Shopify's list of countries with a shipping zone only for a store that uses zones", () => {
    // What the Storefront API lists: right on profiles, left behind on markets.
    const facts = { syncedAt: null, shipsTo: ["US"], countries: ["United States"] };
    const regions = (rates: ShippingRates) =>
      syncedRows(facts, shippingForPage(rates)).find((entry) => entry.label === "Shipping regions");

    expect(regions({ ...NO_SHIPPING_RATES, state: "no_access", model: "profiles" })).toMatchObject({
      value: "United States",
      tone: "success",
    });
    expect(regions({ ...NO_SHIPPING_RATES, state: "no_access", model: "markets" })).toMatchObject({
      value: "Shown once the permission is approved",
      tone: "neutral",
    });
    // Not known which the store is on: the list is not trusted either.
    expect(regions(NO_SHIPPING_RATES)?.value).toBe("Couldn't check just now");
  });
});

describe("the shipping tool", () => {
  const tool = shopperTools.find((entry) => entry.name === "get_shipping_info")!;
  const live = async (): Promise<ShippingRates> => profileRates();
  const onMarkets = (answer: unknown = TWO_MARKETS, overrides: Partial<ShippingRates> = {}) =>
    async (): Promise<ShippingRates> => marketRates(answer, overrides);
  const run = async (args: Record<string, unknown>, overrides: Partial<ToolContext> = {}) =>
    (await tool.run(tool.schema.parse(args), toolContext({ shippingRates: live, ...overrides })))
      .output as Record<string, unknown>;
  /** What the Storefront API lists: countries with a shipping zone, and countries in an active market. */
  const storefrontLists = (zones: string[], inMarkets: string[]) =>
    fakeGraphql({
      shop: { shipsToCountries: zones },
      localization: { availableCountries: inMarkets.map((isoCode) => ({ isoCode })) },
    });

  it("is offered to shoppers only, and reads the rates each time it is used", async () => {
    expect(tool.audiences).toEqual(["shopper"]);
    const names = (context: ToolContext) => toolsFor(shopperTools, context).map((entry) => entry.name);
    expect(names(toolContext({ shippingRates: live }))).toContain("get_shipping_info");
    expect(names(toolContext({ storefront: fakeGraphql({}) }))).toContain("get_shipping_info");
    expect(names(toolContext())).not.toContain("get_shipping_info");
    expect(names(toolContext({ audience: "merchant", shippingRates: live }))).not.toContain(
      "get_shipping_info",
    );

    let reads = 0;
    const counted = async () => {
      reads += 1;
      return live();
    };
    await run({ country: "CA" }, { shippingRates: counted });
    await run({ country: "CA" }, { shippingRates: counted });
    expect(reads).toBe(2);
  });

  it("gives a country's rates as the store set them", async () => {
    const answer = await run({ country: "CA" });
    expect(answer).toMatchObject({
      country: "Canada",
      delivers: true,
      rates: [
        { name: "Standard", cost: "10.00 CAD", appliesTo: "orders up to 99.99 CAD" },
        { name: "Free shipping", cost: "free", appliesTo: "orders of 100.00 CAD or more" },
        {
          name: "Heavy items",
          cost: "25.00 CAD",
          appliesTo: "orders weighing 20 kg or more",
          details: "5 to 8 business days",
        },
      ],
    });
    expect(answer.note).toContain("read from its shipping settings just now");
    // The country may be given by name as well.
    expect(await run({ country: "united states" })).toMatchObject({ country: "United States", delivers: true });
  });

  it("gives a market's rates with what makes them free and how long they take", async () => {
    const us = await run({ country: "US" }, { shippingRates: onMarkets() });
    expect(us).toMatchObject({ country: "United States", delivers: true });
    expect(us.rates).toEqual([
      {
        name: "Standard",
        cost: "8.00 USD",
        freeOnOrdersOf: "70.00 USD or more",
        deliveryTime: "3 to 5 business days after the order is sent out",
      },
      { name: "Express", cost: "15.00 USD", deliveryTime: "1 to 2 business days after the order is sent out" },
    ]);
    const ca = await run({ country: "CA" }, { shippingRates: onMarkets() });
    expect(ca.rates).toEqual([{ name: "International Shipping", cost: "30.00 USD" }]);
    // No delivery time is set for it, and none is invented.
    expect(JSON.stringify(ca)).not.toMatch(/business days/);
  });

  it("uses the rest-of-the-world zone for a country no zone names, and says a carrier prices it", async () => {
    expect(await run({ country: "DE" })).toMatchObject({
      country: "Germany",
      delivers: true,
      rates: [{ name: "Worldwide express", cost: "calculated at checkout by DHL Express" }],
    });
    // The store sells there too, as its storefront confirms.
    const sells = storefrontLists(["CA", "US"], ["CA", "US", "DE"]);
    expect(await run({ country: "DE" }, { storefront: sells })).toMatchObject({ country: "Germany", delivers: true });
    expect(sells.calls).toHaveLength(1);
  });

  it("does not promise delivery on a rest-of-the-world rate to a country the store does not sell to", async () => {
    const storefront = storefrontLists(["CA", "US"], ["CA", "US"]);
    const answer = await run({ country: "DE" }, { storefront });
    // The rate exists, so it is given, but as what would apply, not as a promise.
    expect(answer).toMatchObject({
      country: "Germany",
      deliveryNotConfirmed: true,
      rates: [{ name: "Worldwide express", cost: "calculated at checkout by DHL Express" }],
    });
    expect(answer).not.toHaveProperty("delivers");
    expect(answer.note).toContain("Do not promise delivery there");
    // A country a zone names needs no such check.
    const named = storefrontLists(["CA", "US"], ["CA", "US"]);
    expect(await run({ country: "CA" }, { storefront: named })).toMatchObject({ delivers: true });
    expect(named.calls).toHaveLength(0);
    // Asked about everywhere from such a country: not said to be delivered to.
    const all = await run({}, { storefront, buyer: { country: "DE" } });
    expect(all).toMatchObject({ shopperIsBrowsingFrom: "Germany" });
    expect(all).not.toHaveProperty("deliversThere");
  });

  it("says so plainly when the store does not deliver to a country", async () => {
    const northOnly = async (): Promise<ShippingRates> => {
      const rates = await live();
      return { ...rates, zones: rates.zones.slice(0, 1) };
    };
    const answer = await run({ country: "PK" }, { shippingRates: northOnly });
    expect(answer).toMatchObject({
      country: "Pakistan",
      delivers: false,
      deliversOnlyTo: ["Canada", "United States"],
    });
    expect(answer.note).toContain("The store has no shipping set up for Pakistan.");
    expect(answer.note).toContain("to no others: name only these");
    expect(answer).not.toHaveProperty("rates");

    // The same on a store on markets, for a country in none of them.
    expect(await run({ country: "PK" }, { shippingRates: onMarkets() })).toMatchObject({
      delivers: false,
      deliversOnlyTo: ["Canada", "United States"],
    });
    // Markets alone decide where such a store sells: rates that some products
    // or an app add change what delivery costs, not where it goes.
    expect(
      await run({ country: "PK" }, { shippingRates: onMarkets(TWO_MARKETS, { otherProfiles: true }) }),
    ).toMatchObject({ delivers: false, deliversOnlyTo: ["Canada", "United States"] });
  });

  it("does not call a country delivered to because it is in a market: the market must deliver", async () => {
    const off = market("Canada", [inCountry("CA")], shipping([flat("Standard", [group(flatRate("9.0"))])], { isEnabled: false }));
    const rates = onMarkets(markets([off, UNITED_STATES]));

    const ca = await run({ country: "CA" }, { shippingRates: rates });
    expect(ca).toMatchObject({ country: "Canada", delivers: false, deliversOnlyTo: ["United States"] });
    expect(ca).not.toHaveProperty("rates");

    const all = await run({}, { shippingRates: rates, buyer: { country: "CA" } });
    expect(all).toMatchObject({ shopperIsBrowsingFrom: "Canada", deliversThere: false });
    expect(JSON.stringify(all.zones)).not.toContain("Canada");
    expect(all.note).toContain("delivers to the countries in these zones and to no others");

    // No market delivers anywhere: said as it is.
    const none = await run({}, { shippingRates: onMarkets(markets([off])) });
    expect(none.zones).toEqual([]);
    expect(none.note).toContain("list no delivery option for any country right now");
  });

  it("does not say 'no delivery' when it could not read everything", async () => {
    const lists = () => storefrontLists(["CA", "US"], ["CA", "US", "MX"]);

    // More zones than were read, and the country is in none of those read.
    const cut = async (): Promise<ShippingRates> => profileRates({ zones: profileRates().zones.slice(0, 1), truncated: true });
    const unsure = await run({ country: "MX" }, { shippingRates: cut });
    expect(unsure).toMatchObject({ country: "Mexico", ratesAvailable: false });
    expect(unsure).not.toHaveProperty("delivers");
    expect(unsure.note).toContain("Do not say that the store does not deliver there.");
    expect(unsure.note).toContain("the checkout shows the delivery options");

    // Shopify's own list of countries with a shipping zone settles it either way.
    const listed = await run(
      { country: "MX" },
      { shippingRates: cut, storefront: storefrontLists(["CA", "US", "MX"], ["CA", "US", "MX"]) },
    );
    expect(listed).toMatchObject({ country: "Mexico", delivers: true, ratesAvailable: false });
    const storefront = lists();
    const settled = await run({ country: "MX" }, { shippingRates: cut, storefront });
    expect(settled).toMatchObject({ country: "Mexico", delivers: false, deliversTo: ["Canada", "United States"] });
    expect(settled).not.toHaveProperty("deliversOnlyTo");
    expect(settled.note).toContain("There may be others");

    // Products with rates of their own can reach a country the general zones do not.
    const others = async (): Promise<ShippingRates> => profileRates({ zones: profileRates().zones.slice(0, 1), otherProfiles: true });
    const some = await run({ country: "MX" }, { shippingRates: others, storefront: storefrontLists(["CA", "US", "MX"], ["CA", "US", "MX"]) });
    expect(some).toMatchObject({ country: "Mexico", delivers: true, ratesAvailable: false });

    // A market whose only rates are for certain products: delivered to, with nothing to quote.
    const bulkyOnly = market("Canada", [inCountry("CA")], shipping([flat("Furniture delivery", [group(flatRate("120.0"), 1)])]));
    const special = await run({ country: "CA" }, { shippingRates: onMarkets(markets([bulkyOnly, UNITED_STATES])), storefront: lists() });
    expect(special).toMatchObject({ country: "Canada", ratesAvailable: false });
    expect(special).not.toHaveProperty("delivers");
    expect(JSON.stringify(special)).not.toContain("120");
  });

  it("leaves the owner's typed note and picks out whenever the store's settings could be read", async () => {
    // The note names other countries and other prices than the settings do.
    const stale = "We ship to Canada, the US and Mexico. Shipping is 35 CAD, free over 500 CAD.";
    const picks = { area: "Shipping area: ships internationally.", cost: "Shipping cost: free on every order." };
    for (const args of [{ country: "CA" }, { country: "PK" }, {}]) {
      const answer = JSON.stringify(await run(args, { shippingNote: stale, shippingPicks: picks }));
      expect(answer).not.toContain("Mexico");
      expect(answer).not.toContain("35 CAD");
      expect(answer).not.toContain("free on every order");
      expect(answer).not.toContain("ships internationally");
    }
  });

  it("with no country named, lists every zone, and says whether it delivers where the shopper is", async () => {
    // "Which countries do you ship to?" must get all of them, not just the shopper's own.
    const here = await run({}, { buyer: { country: "ca" } });
    expect(here).toMatchObject({ shopperIsBrowsingFrom: "Canada", deliversThere: true });
    expect(here.zones).toHaveLength(2);
    expect(await run({}, { buyer: { country: "ZZ" } })).not.toHaveProperty("shopperIsBrowsingFrom");

    // Named zones only: the list is complete, and the assistant is told so.
    const northOnly = async (): Promise<ShippingRates> => {
      const rates = await live();
      return { ...rates, zones: rates.zones.slice(0, 1) };
    };
    const closed = await run({}, { shippingRates: northOnly, buyer: { country: "PK" } });
    expect(closed).toMatchObject({ shopperIsBrowsingFrom: "Pakistan", deliversThere: false });
    expect(closed.note).toContain("delivers to the countries in these zones and to no others");
    // Not known to be complete: no "no" for the shopper's own country.
    const partial = await run({}, { shippingRates: async () => ({ ...(await northOnly()), truncated: true }), buyer: { country: "PK" } });
    expect(partial).toMatchObject({ shopperIsBrowsingFrom: "Pakistan" });
    expect(partial).not.toHaveProperty("deliversThere");
    expect(partial.note).toContain("A country not named may still be covered");

    const all = await run({});
    // A rest-of-the-world zone: a country not named may still be covered.
    expect(all.note).toContain("A country not named may still be covered");
    expect(all.zones).toEqual([
      {
        countries: ["Canada", "United States"],
        rates: [
          { name: "Standard", cost: "10.00 CAD", appliesTo: "orders up to 99.99 CAD" },
          { name: "Free shipping", cost: "free", appliesTo: "orders of 100.00 CAD or more" },
          {
            name: "Heavy items",
            cost: "25.00 CAD",
            appliesTo: "orders weighing 20 kg or more",
            details: "5 to 8 business days",
          },
        ],
      },
      {
        countries: [],
        alsoEveryCountryNotNamedInAnotherZone: true,
        rates: [{ name: "Worldwide express", cost: "calculated at checkout by DHL Express" }],
      },
    ]);
  });

  it("says which part of a country a set of rates is for", async () => {
    const provinces = market(
      "Central Canada",
      [inPart("CA", "ON", "Ontario"), inPart("CA", "QC", "Quebec")],
      shipping([flat("Local", [group(flatRate("5.0"))])]),
    );
    const rates = onMarkets(markets([provinces, CANADA, UNITED_STATES]));
    const answer = await run({ country: "CA" }, { shippingRates: rates });
    expect(answer).toMatchObject({ country: "Canada", delivers: true });
    expect(answer.areas).toEqual([
      { onlyIn: ["Ontario", "Quebec"], rates: [{ name: "Local", cost: "5.00 USD" }] },
      { restOfTheCountry: true, rates: [{ name: "International Shipping", cost: "30.00 USD" }] },
    ]);
    expect(answer).not.toHaveProperty("rates");
    expect(answer.note).toContain("depends on the province or state");
    const all = await run({}, { shippingRates: rates });
    expect((all.zones as Array<{ countries: string[] }>)[0].countries).toEqual(["Canada (Ontario, Quebec only)"]);
  });

  it("gives the rest of a country its own rates when a market covers only part of it", async () => {
    const world = market("International", [], shipping([flat("Worldwide", [group(flatRate("40.0"))])]), {
      conditions: { regionsCondition: { applicationLevel: "ALL", regions: { ...one, nodes: [] } } },
    });
    const california = market(
      "California",
      [inPart("US", "CA", "California")],
      shipping([flat("Local", [group(flatRate("5.0"))])]),
      under("International"),
    );
    const answer = await run({ country: "US" }, { shippingRates: onMarkets(markets([world, california])) });
    expect(answer).toMatchObject({ country: "United States", delivers: true });
    // Not the Californian rate alone, as if the rest of the country had none.
    expect(answer.areas).toEqual([
      { onlyIn: ["California"], rates: [{ name: "Local", cost: "5.00 USD" }] },
      { restOfTheCountry: true, rates: [{ name: "Worldwide", cost: "40.00 USD" }] },
    ]);

    // Delivery switched off for the part: it is named as having none, and the
    // rest of the country's rate is not passed off as reaching it.
    const closed = market("California", [inPart("US", "CA", "California")], shipping([], { isEnabled: false }), under("International"));
    const partOff = await run({ country: "US" }, { shippingRates: onMarkets(markets([world, closed])) });
    expect(partOff).toMatchObject({ country: "United States", delivers: true });
    expect(partOff).not.toHaveProperty("rates");
    expect(partOff.areas).toEqual([
      { onlyIn: ["California"], delivers: false },
      { restOfTheCountry: true, rates: [{ name: "Worldwide", cost: "40.00 USD" }] },
    ]);
    expect(partOff.note).toContain("say so plainly where an area has no delivery");

    // The other way round: only the part is delivered to.
    const countryOff = market("United States", [inCountry("US")], shipping([], { isEnabled: false }));
    const partOnly = await run({ country: "US" }, { shippingRates: onMarkets(markets([countryOff, california])) });
    expect(partOnly.areas).toEqual([
      { restOfTheCountry: true, delivers: false },
      { onlyIn: ["California"], rates: [{ name: "Local", cost: "5.00 USD" }] },
    ]);
  });

  it("says nothing is set up, and passes on no pick, when Shopify was read and holds no rates", async () => {
    const picks = {
      area: "Shipping area: ships internationally.",
      cost: "Shipping cost: free on every order.",
      dispatch: "Dispatch: orders usually ship the same business day.",
    };
    const context = { shippingPicks: picks, shippingNote: "We ship worldwide for 9.99.", storefront: storefrontLists(["US"], ["US"]) };
    const empty = async (): Promise<ShippingRates> => ({ state: "live", model: "markets", zones: [], otherProfiles: false, truncated: false });

    for (const args of [{}, { country: "US" }]) {
      const answer = await run(args, { ...context, shippingRates: empty });
      expect(answer).toMatchObject({ ratesAvailable: false, dispatch: picks.dispatch });
      expect(answer.note).toContain("list no delivery zone or rate right now");
      // The picks for area and cost are for when Shopify cannot be asked. It was asked.
      expect(answer).not.toHaveProperty("fromTheStoreOwner");
      expect(answer).not.toHaveProperty("delivers");
      expect(JSON.stringify(answer)).not.toMatch(/free on every order|ships internationally|9\.99/);
    }
    expect(context.storefront.calls).toHaveLength(0);

    // Zones that could not all be read are not "none": that is still "could not be read".
    const unread = async (): Promise<ShippingRates> => ({ ...(await empty()), model: "profiles", truncated: true });
    const answer = await run({ country: "US" }, { ...context, shippingRates: unread });
    expect(answer).toMatchObject({ ratesAvailable: false, delivers: true });
    expect(answer.fromTheStoreOwner).toContain("Shipping cost: free on every order.");

    // Nor is an answer from Shopify that could not be made sense of: nothing
    // in it says the store has no rates.
    const garbled = await run({ country: "US" }, { ...context, shippingRates: onMarkets({ markets: { nodes: "?" } }) });
    expect(garbled.note).toContain("could not be read from its settings just now");
    expect(garbled.note).not.toContain("list no delivery zone or rate");
  });

  it("asks which country is meant instead of guessing at one it does not recognise", async () => {
    let reads = 0;
    const answer = await run(
      { country: "Atlantis" },
      {
        shippingRates: async () => {
          reads += 1;
          return live();
        },
      },
    );
    expect(answer).toMatchObject({ country: "Atlantis", recognised: false });
    expect(reads).toBe(0);
  });

  it("without the rates, a store on profiles still says where it delivers and what the owner picked", async () => {
    const storefront = storefrontLists(["CA", "US"], ["CA", "US", "MX"]);
    const noAccess = async (): Promise<ShippingRates> => ({ ...NO_SHIPPING_RATES, state: "no_access", model: "profiles" });
    const picks = {
      area: "Shipping area: ships internationally.",
      cost: "Shipping cost: a flat 4.99 CAD per order.",
      deliveryTime: "Delivery: usually 3 to 5 business days after the order ships.",
    };

    const asked = await run(
      { country: "CA" },
      { shippingRates: noAccess, storefront, shippingPicks: picks, shippingNote: "Orders placed before 2pm ship the same day." },
    );
    expect(asked).toMatchObject({
      ratesAvailable: false,
      country: "Canada",
      delivers: true,
      // With nothing from Shopify on cost or time, the owner's picks and own words are
      // what there is. Where it delivers, Shopify said: the owner's pick for that is left out.
      fromTheStoreOwner:
        "Shipping cost: a flat 4.99 CAD per order.\nDelivery: usually 3 to 5 business days after the order ships.\nOrders placed before 2pm ship the same day.",
    });
    expect(storefront.calls.map((call) => call.query)).toEqual([SHIPS_TO_QUERY]);
    expect(asked.note).toContain("Never guess a price or a delivery country.");
    expect(asked.note).toContain("Give what the store owner says above as the answer.");

    expect(await run({ country: "PK" }, { shippingRates: noAccess, storefront })).toMatchObject({
      ratesAvailable: false,
      country: "Pakistan",
      delivers: false,
    });
    // In a market, but with no shipping zone: on profiles that is not delivered to.
    expect(await run({ country: "MX" }, { shippingRates: noAccess, storefront })).toMatchObject({ delivers: false });
    // Every country, whichever one the shopper is in.
    for (const buyer of [{}, { country: "CA" }]) {
      const all = await run({}, { shippingRates: noAccess, storefront, buyer });
      expect(all).toMatchObject({ ratesAvailable: false, deliversTo: ["Canada", "United States"] });
      expect(all).not.toHaveProperty("sellsTo");
    }

    // Nothing readable at all: no claim either way, and the checkout is named.
    const dark = await run({ country: "CA" }, { shippingRates: undefined, storefront: fakeGraphql(new Error("offline")) });
    expect(dark).toMatchObject({ ratesAvailable: false, country: "Canada" });
    expect(dark).not.toHaveProperty("delivers");
    expect(dark.note).toContain("the checkout shows the exact delivery cost before payment");
    // An empty list is not read as "delivers nowhere".
    const blank = await run({ country: "CA" }, { shippingRates: noAccess, storefront: storefrontLists([], []), shippingPicks: picks });
    expect(blank).not.toHaveProperty("delivers");
    expect(blank.fromTheStoreOwner).toContain("Shipping area: ships internationally.");
  });

  it("without the rates, a store on markets is not judged by its left-behind list of zones", async () => {
    // As a real store on markets answered: one country with a zone, two it sells and delivers to.
    const storefront = storefrontLists(["US"], ["CA", "US"]);
    const noAccess = async (): Promise<ShippingRates> => ({ ...NO_SHIPPING_RATES, state: "no_access", model: "markets" });

    const ca = await run({ country: "CA" }, { shippingRates: noAccess, storefront, shippingPicks: { area: "Shipping area: ships internationally." } });
    // Not "does not deliver", which the list of zones alone would say.
    expect(ca).toMatchObject({ ratesAvailable: false, country: "Canada", storeSellsThere: true });
    expect(ca).not.toHaveProperty("delivers");
    expect(ca.note).toContain("without promising delivery");
    // Selling there is not yet delivering there, so the owner's pick still has its say.
    expect(ca.fromTheStoreOwner).toBe("Shipping area: ships internationally.");

    // No market sells there: nothing can be ordered to it.
    expect(await run({ country: "PK" }, { shippingRates: noAccess, storefront })).toMatchObject({ delivers: false });
    const all = await run({}, { shippingRates: noAccess, storefront });
    expect(all).toMatchObject({ sellsTo: ["Canada", "United States"] });
    expect(all).not.toHaveProperty("deliversTo");
  });

  it("without knowing which set-up the store is on, says only what both lists agree on", async () => {
    const storefront = storefrontLists(["US", "GB"], ["CA", "US"]);
    const down = async (): Promise<ShippingRates> => ({ ...NO_SHIPPING_RATES });
    const answer = (code: string) => run({ country: code }, { shippingRates: down, storefront });

    expect(await answer("US")).toMatchObject({ delivers: true });
    expect(await answer("PK")).toMatchObject({ delivers: false });
    // In a market but with no zone: yes on markets, no on profiles. Not said either way.
    const ca = await answer("CA");
    expect(ca).not.toHaveProperty("delivers");
    expect(ca).toMatchObject({ storeSellsThere: true });
    // A zone but no market: nothing can be ordered there.
    expect(await answer("GB")).toMatchObject({ delivers: false });
  });

  it("says how soon orders leave: Shopify's own setting, else the owner's pick", async () => {
    const withTime = async (): Promise<ShippingRates> => ({ ...(await live()), processingDays: 1 });
    const picks = { dispatch: "Dispatch: orders usually ship within 3 to 5 business days." };
    expect(await run({ country: "CA" }, { shippingRates: withTime, shippingPicks: picks })).toMatchObject({
      dispatch: "Orders are handed to the carrier within 1 business day.",
    });
    expect(await run({}, { shippingRates: withTime })).toHaveProperty("dispatch");
    // Not set in Shopify: the owner's pick is the answer, live rates or not.
    expect(await run({ country: "CA" }, { shippingPicks: picks })).toMatchObject({ dispatch: picks.dispatch });
    const noAccess = async (): Promise<ShippingRates> => ({ ...NO_SHIPPING_RATES, state: "no_access" });
    expect(await run({ country: "CA" }, { shippingRates: noAccess, shippingPicks: picks })).toMatchObject({
      dispatch: picks.dispatch,
    });
    // Neither: nothing is said about it.
    expect(await run({ country: "CA" })).not.toHaveProperty("dispatch");
  });

  it("gives the owner's usual delivery time only for rates that have none of their own", async () => {
    const picks = { deliveryTime: "Delivery: usually 5 to 8 business days after the order ships." };
    // Canada's rate has no time set in Shopify: the owner's pick fills in.
    const ca = await run({ country: "CA" }, { shippingRates: onMarkets(), shippingPicks: picks });
    expect(ca).toMatchObject({ usualDeliveryTime: picks.deliveryTime });
    expect(ca.note).toContain("takes the store's usual one");
    // Both rates for the United States have their own: the pick stays out.
    const us = await run({ country: "US" }, { shippingRates: onMarkets(), shippingPicks: picks });
    expect(us).not.toHaveProperty("usualDeliveryTime");
    expect(JSON.stringify(us)).not.toContain("5 to 8");
    // Asked about everywhere, some rate lacks a time.
    expect(await run({}, { shippingRates: onMarkets(), shippingPicks: picks })).toHaveProperty("usualDeliveryTime");
    expect(await run({ country: "CA" }, { shippingRates: onMarkets() })).not.toHaveProperty("usualDeliveryTime");
  });

  it("mentions products with rates of their own and zones it could not list", async () => {
    const more = async (): Promise<ShippingRates> => ({ ...(await live()), otherProfiles: true, truncated: true });
    const { note } = await run({ country: "CA" }, { shippingRates: more });
    expect(note).toContain("Some products have shipping rates of their own");
    expect(note).toContain("more delivery zones than are listed here");

    const mixed = flat("Standard", [group(flatRate("8.0")), group(flatRate("60.0"), 2)]);
    const us = await run({ country: "US" }, { shippingRates: onMarkets(markets([market("United States", [inCountry("US")], shipping([mixed]))])) });
    expect(us).toMatchObject({ delivers: true, moreOptionsAtCheckout: true, rates: [{ name: "Standard", cost: "8.00 USD" }] });
    expect(us.note).toContain("Some products have shipping rates of their own");
  });
});

describe("the payment tool", () => {
  const tool = shopperTools.find((entry) => entry.name === "get_payment_methods")!;
  const settings = toolContext().settings;
  const run = async (storefront: ToolContext["storefront"], cashOnDelivery?: "yes" | "no" | "") =>
    (await tool.run({}, toolContext({ storefront, settings: { ...settings, cashOnDelivery } })))
      .output as Record<string, unknown>;
  const checkout = (cards: string[], wallets: string[]) =>
    fakeGraphql({ shop: { paymentSettings: { acceptedCardBrands: cards, supportedDigitalWallets: wallets } } });

  it("reads the checkout's cards and wallets from Shopify when asked", async () => {
    const storefront = checkout(["VISA", "AMERICAN_EXPRESS"], ["SHOPIFY_PAY", "APPLE_PAY"]);
    expect(await run(storefront, "yes")).toMatchObject({
      cards: ["Visa", "American Express"],
      wallets: ["Shop Pay", "Apple Pay"],
      // Chosen on the checkout page, like the cards and wallets: never in the chat.
      cashOnDelivery: "offered: the shopper picks it as the way to pay on the store's checkout page",
    });
    expect(storefront.calls.map((call) => call.query)).toEqual([PAYMENT_SETTINGS_QUERY]);
    expect(toolsFor(shopperTools, toolContext()).map((entry) => entry.name)).not.toContain(
      "get_payment_methods",
    );
  });

  it("says what is known about cash on delivery, and no more", async () => {
    const storefront = checkout(["VISA"], []);
    expect((await run(storefront, "yes")).cashOnDelivery).toMatch(/on the store's checkout page/);
    expect((await run(storefront, "no")).cashOnDelivery).toBe("not offered");
    const unknown = "not known: the store has not said. The checkout page shows whether it can be chosen";
    expect((await run(storefront, "")).cashOnDelivery).toBe(unknown);
    expect((await run(storefront)).cashOnDelivery).toBe(unknown);
    // Whatever the answer, nothing suggests the order can be placed in the chat.
    for (const pick of ["yes", "no", ""] as const) {
      expect(JSON.stringify(await run(storefront, pick))).not.toMatch(/in this chat|order here/i);
    }
  });

  it("guesses no payment method when Shopify lists none", async () => {
    const answer = await run(fakeGraphql({ shop: { paymentSettings: null } }), "");
    expect(answer).toMatchObject({ cards: [], wallets: [] });
    expect(answer.note).toContain("do not guess any");
  });
});

describe("the assistant's rule for delivery and payment", () => {
  const prompt = (abilities: { shipping?: boolean; payment?: boolean }) =>
    buildSystemPrompt({
      audience: "shopper",
      shopName: "Alpine Outfitters",
      orderLookupEnabled: false,
      today: new Date("2026-11-26T12:00:00Z"),
      abilities: { addToCart: true, checkout: true, returns: false, ...abilities },
    });

  it("sends it to its tools every time, and never to memory", () => {
    const both = prompt({ shipping: true, payment: true });
    expect(both).toContain(
      "- Delivery and payment: for anything about delivery (which countries the store delivers to, what delivery costs, how soon orders are sent out, how long delivery takes), and how shoppers can pay, use your shipping and payment tools every time one of these is asked, before you answer.",
    );
    expect(both).toContain("never work out a cost yourself");
    expect(both).toContain("name no country or price that it does not give, and no delivery time either");
    expect(prompt({ shipping: true })).toContain("use your shipping tool every time");
    expect(prompt({ payment: true })).toContain("for how shoppers can pay, use your payment tool every time");
    expect(prompt({})).not.toContain("Delivery and payment");
  });

  it("has one place to answer each question from", () => {
    // When the tool can only pass on what the owner said, that is the answer,
    // not "the checkout shows it".
    expect(prompt({ shipping: true })).toContain(
      "When the tool passes on what the store owner says, that is the answer: give it.",
    );
    // With the shipping tool, how long delivery takes is the tool's to answer...
    expect(prompt({ shipping: true })).toContain(
      "- For questions about the business, returns or other store policies, answer from the store owner's notes",
    );
    // ...and without it, the owner's notes still are.
    expect(prompt({})).toContain(
      "- For questions about the business, returns, delivery times or other store policies, answer from the store owner's notes",
    );
  });
});
