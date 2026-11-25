import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "../app/assistant/prompts";
import {
  NO_SHIPPING_RATES,
  countryCodeFor,
  moneyText,
  processingText,
  rateText,
  readProcessingDays,
  readShippingProfile,
  shippingForPage,
  zonesFor,
  type ShippingRates,
} from "../app/assistant/shipping";
import {
  loadProcessingDays,
  loadShippingRates,
  PROCESSING_TIME_QUERY,
  SHIPPING_PROFILES_QUERY,
  SHIPPING_RATES_QUERY,
} from "../app/assistant/shipping.server";
import { shopperTools } from "../app/assistant/tools";
import type { ToolContext } from "../app/assistant/tools/registry";
import { toolsFor } from "../app/assistant/tools/registry";
import { PAYMENT_SETTINGS_QUERY, SHIPS_TO_QUERY } from "../app/assistant/tools/storefront-queries";
import { syncedRows } from "../app/components/settings/SyncedFromShopify";
import { fakeGraphql, toolContext } from "./helpers/fakes";

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
const zone = (name: string, countries: unknown[], methods: unknown[]) => ({
  zone: { name, countries },
  methodDefinitions: { nodes: methods },
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
  method("DHL Express", { rateProvider: { carrierService: { formattedName: "DHL Express", name: "dhl" } } }),
]);
const STORE = profile([[NORTH_AMERICA, EVERYWHERE_ELSE]]);

/** An Admin API that answers the shipping queries, and counts them. */
function shippingAdmin(
  rates: unknown = STORE,
  profiles: Array<{ id: string; default: boolean }> = [
    { id: "gid://shopify/DeliveryProfile/2", default: false },
    { id: "gid://shopify/DeliveryProfile/1", default: true },
  ],
  processingTime: string | null = "P2D",
) {
  const asked: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  const admin = (async (query: string, variables?: Record<string, unknown>) => {
    asked.push({ query, variables });
    if (query === PROCESSING_TIME_QUERY) return { deliveryPromiseSettings: { processingTime } };
    if (query === SHIPPING_PROFILES_QUERY) return { deliveryProfiles: { nodes: profiles } };
    if (query === SHIPPING_RATES_QUERY) {
      if (rates instanceof Error) throw rates;
      return rates;
    }
    throw new Error("unexpected query");
  }) as NonNullable<ToolContext["admin"]>;
  return { admin, asked };
}

describe("reading a store's shipping settings", () => {
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
    expect(zones[1].rates.map(rateText)).toEqual(["DHL Express: calculated at checkout by DHL Express"]);
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
    for (const odd of [null, {}, { deliveryProfile: null }, { deliveryProfile: { profileLocationGroups: "x" } }]) {
      expect(readShippingProfile(odd)).toEqual({ zones: [], truncated: false });
    }
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
    const { zones } = readShippingProfile(messy);
    expect(zones.map((entry) => entry.name)).toEqual(["Kept"]);
    expect(zones[0].rates.map(rateText)).toEqual([
      "No price: calculated at checkout",
      "Odd condition: 10.00 CAD",
    ]);
    expect(readShippingProfile(profile([[NORTH_AMERICA]], true)).truncated).toBe(true);
  });

  it("writes money the way each currency is written", () => {
    expect(moneyText("10.0", "CAD")).toBe("10.00 CAD");
    expect(moneyText("1000.0", "JPY")).toBe("1000 JPY");
    expect(moneyText("4.5", "KWD")).toBe("4.500 KWD");
    expect(moneyText("not a number", "USD")).toBe("not a number USD");
  });

  it("finds the zone for a country, falling back to the rest-of-the-world zone", () => {
    const rates: ShippingRates = { state: "live", ...readShippingProfile(STORE), otherProfiles: false };
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
    for (const unknown of ["", "ZZ", "Atlantis", "the moon"]) expect(countryCodeFor(unknown)).toBeNull();
  });

  it("asks Shopify for the store's general profile, every time", async () => {
    const { admin, asked } = shippingAdmin();
    const first = await loadShippingRates(admin);
    expect(first.state).toBe("live");
    expect(first.zones).toHaveLength(2);
    // Another profile exists: some products have rates of their own.
    expect(first.otherProfiles).toBe(true);
    // The default profile was the one read, not simply the first listed.
    const ratesCalls = () => asked.filter((call) => call.query === SHIPPING_RATES_QUERY);
    expect(ratesCalls()[0].variables).toEqual({ id: "gid://shopify/DeliveryProfile/1" });
    // How soon orders leave comes with it, from the store's own setting.
    expect(first.processingDays).toBe(2);

    // Nothing is kept between calls: the second one asks Shopify again.
    await loadShippingRates(admin);
    expect(ratesCalls()).toHaveLength(2);
    expect(asked.filter((call) => call.query === SHIPPING_PROFILES_QUERY)).toHaveLength(2);
    expect(asked.filter((call) => call.query === PROCESSING_TIME_QUERY)).toHaveLength(2);
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
    const unset = await loadShippingRates(shippingAdmin(STORE, undefined, null).admin);
    expect(unset.state).toBe("live");
    expect(unset).not.toHaveProperty("processingDays");
    expect(await loadProcessingDays(undefined)).toBeUndefined();
    expect(await loadProcessingDays(fakeGraphql(new Error("Access denied")))).toBeUndefined();

    // It is its own question: known even while the rates need a permission.
    const denied = (async (query: string) => {
      if (query === PROCESSING_TIME_QUERY) return { deliveryPromiseSettings: { processingTime: "P1D" } };
      throw new Error("Admin GraphQL error: Access denied for deliveryProfiles field.");
    }) as NonNullable<ToolContext["admin"]>;
    expect(await loadShippingRates(denied)).toMatchObject({ state: "no_access", processingDays: 1 });
  });

  it("says why when the rates cannot be read, instead of failing", async () => {
    expect(await loadShippingRates(undefined)).toEqual(NO_SHIPPING_RATES);

    // Shopify's own words when the store has not approved the permission.
    const denied = fakeGraphql(new Error("Admin GraphQL error: Access denied for deliveryProfiles field."));
    expect((await loadShippingRates(denied)).state).toBe("no_access");

    const down = fakeGraphql(new Error("Admin GraphQL error: Throttled"));
    expect(await loadShippingRates(down)).toEqual(NO_SHIPPING_RATES);

    // A store with no shipping profile at all has, truthfully, no zones.
    const empty = shippingAdmin(STORE, [], null);
    expect(await loadShippingRates(empty.admin)).toEqual({
      state: "live",
      zones: [],
      otherProfiles: false,
      truncated: false,
    });
  });

  it("puts the rates into words for the Settings page", () => {
    const rates: ShippingRates = { state: "live", ...readShippingProfile(STORE), otherProfiles: true };
    const view = shippingForPage(rates);
    expect(view).toMatchObject({
      state: "live",
      countries: ["Canada", "United States"],
      restOfWorld: true,
      otherProfiles: true,
      more: 0,
      processing: "",
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
      { where: "Rest of the world", rates: ["DHL Express: calculated at checkout by DHL Express"] },
    ]);

    const many = shippingForPage({
      ...rates,
      truncated: true,
      zones: Array.from({ length: 9 }, (_, index) => ({
        name: `Zone ${index}`,
        countries: ["CA", "US", "MX", "GB", "FR", "DE"],
        restOfWorld: index === 0,
        rates: [],
      })),
    });
    expect(many.zones).toHaveLength(6);
    // Three more read, and Shopify says there are more still.
    expect(many.more).toBe(4);
    expect(many.zones[0].where).toBe("Canada, France, Germany, Mexico and 2 more, and the rest of the world");
    expect(many.zones[1].rates).toEqual(["No rates set for this zone"]);
  });

  it("tells the merchant in one line where the rates stand", () => {
    const facts = { syncedAt: null, countries: [] };
    const row = (rates: ShippingRates) =>
      syncedRows(facts, shippingForPage(rates)).find((entry) => entry.label === "Shipping rates");
    const live: ShippingRates = { state: "live", ...readShippingProfile(STORE), otherProfiles: false };

    expect(row(live)).toEqual({
      label: "Shipping rates",
      value: "2 zones, read live each time a shopper asks",
      tone: "success",
    });
    expect(row({ ...NO_SHIPPING_RATES, state: "no_access" })?.tone).toBe("warning");
    expect(row({ ...NO_SHIPPING_RATES, state: "live" })?.value).toBe("None set up yet");
    expect(row(NO_SHIPPING_RATES)?.tone).toBe("neutral");
    // Without rates passed in, the row is simply not there.
    expect(syncedRows(facts).some((entry) => entry.label === "Shipping rates")).toBe(false);
  });
});

describe("the shipping tool", () => {
  const tool = shopperTools.find((entry) => entry.name === "get_shipping_info")!;
  const live = async (): Promise<ShippingRates> => ({
    state: "live",
    ...readShippingProfile(STORE),
    otherProfiles: false,
  });
  const run = async (args: Record<string, unknown>, overrides: Partial<ToolContext> = {}) =>
    (await tool.run(tool.schema.parse(args), toolContext({ shippingRates: live, ...overrides })))
      .output as Record<string, unknown>;

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

  it("uses the rest-of-the-world zone for a country no zone names, and says a carrier prices it", async () => {
    expect(await run({ country: "DE" })).toMatchObject({
      country: "Germany",
      delivers: true,
      rates: [{ name: "DHL Express", cost: "calculated at checkout by DHL Express" }],
    });
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
  });

  it("leaves the owner's typed note out whenever the store's settings could be read", async () => {
    // The note names other countries and other prices than the settings do.
    const stale = "We ship to Canada, the US and Mexico. Shipping is 35 CAD, free over 500 CAD.";
    for (const args of [{ country: "CA" }, { country: "PK" }, {}]) {
      const answer = JSON.stringify(await run(args, { shippingNote: stale, shippingPicks: "Shipping cost: free on every order." }));
      expect(answer).not.toContain("Mexico");
      expect(answer).not.toContain("35 CAD");
      expect(answer).not.toContain("free on every order");
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
        rates: [{ name: "DHL Express", cost: "calculated at checkout by DHL Express" }],
      },
    ]);
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

  it("without the rates, still says where the store delivers and what the owner picked, and guesses no price", async () => {
    const storefront = fakeGraphql({ shop: { shipsToCountries: ["CA", "US"] } });
    const noAccess = async (): Promise<ShippingRates> => ({ ...NO_SHIPPING_RATES, state: "no_access" });

    const asked = await run(
      { country: "CA" },
      {
        shippingRates: noAccess,
        storefront,
        shippingPicks: "Shipping cost: a flat 4.99 CAD per order.",
        shippingNote: "Orders placed before 2pm ship the same day.",
      },
    );
    expect(asked).toMatchObject({
      ratesAvailable: false,
      country: "Canada",
      delivers: true,
      // With nothing from Shopify, the owner's pick and own words are what there is.
      fromTheStoreOwner:
        "Shipping cost: a flat 4.99 CAD per order.\nOrders placed before 2pm ship the same day.",
    });
    expect(storefront.calls.map((call) => call.query)).toEqual([SHIPS_TO_QUERY]);
    expect(asked.note).toContain("Never guess a price or a delivery country.");

    expect(await run({ country: "PK" }, { shippingRates: noAccess, storefront })).toMatchObject({
      ratesAvailable: false,
      country: "Pakistan",
      delivers: false,
    });
    expect(await run({}, { shippingRates: noAccess, storefront })).toMatchObject({
      ratesAvailable: false,
      deliversTo: ["Canada", "United States"],
    });

    // Nothing readable at all: no claim either way, and the checkout is named.
    const dark = await run({ country: "CA" }, { shippingRates: undefined, storefront: fakeGraphql(new Error("offline")) });
    expect(dark).toMatchObject({ ratesAvailable: false, country: "Canada" });
    expect(dark).not.toHaveProperty("delivers");
    expect(dark.note).toContain("the checkout shows the exact delivery cost before payment");
  });

  it("says how soon orders leave where the store has set that in Shopify", async () => {
    const withTime = async (): Promise<ShippingRates> => ({ ...(await live()), processingDays: 1 });
    expect(await run({ country: "CA" }, { shippingRates: withTime })).toMatchObject({
      dispatch: "Orders are handed to the carrier within 1 business day.",
    });
    expect(await run({}, { shippingRates: withTime })).toHaveProperty("dispatch");
    // Not set: nothing is said about it.
    expect(await run({ country: "CA" })).not.toHaveProperty("dispatch");
  });

  it("mentions products with rates of their own and zones it could not list", async () => {
    const more = async (): Promise<ShippingRates> => ({ ...(await live()), otherProfiles: true, truncated: true });
    const { note } = await run({ country: "CA" }, { shippingRates: more });
    expect(note).toContain("Some products have shipping rates of their own");
    expect(note).toContain("more delivery zones than are listed here");
  });
});

describe("the payment tool", () => {
  const tool = shopperTools.find((entry) => entry.name === "get_payment_methods")!;
  const settings = toolContext().settings;
  const run = async (storefront: ToolContext["storefront"], cashOnDelivery?: "chat" | "yes" | "no" | "") =>
    (await tool.run({}, toolContext({ storefront, settings: { ...settings, cashOnDelivery } })))
      .output as Record<string, unknown>;
  const checkout = (cards: string[], wallets: string[]) =>
    fakeGraphql({ shop: { paymentSettings: { acceptedCardBrands: cards, supportedDigitalWallets: wallets } } });

  it("reads the checkout's cards and wallets from Shopify when asked", async () => {
    const storefront = checkout(["VISA", "AMERICAN_EXPRESS"], ["SHOPIFY_PAY", "APPLE_PAY"]);
    expect(await run(storefront, "yes")).toMatchObject({
      cards: ["Visa", "American Express"],
      wallets: ["Shop Pay", "Apple Pay"],
      cashOnDelivery: "offered at checkout",
    });
    expect(storefront.calls.map((call) => call.query)).toEqual([PAYMENT_SETTINGS_QUERY]);
    expect(toolsFor(shopperTools, toolContext()).map((entry) => entry.name)).not.toContain(
      "get_payment_methods",
    );
  });

  it("says what is known about cash on delivery, and no more", async () => {
    const storefront = checkout(["VISA"], []);
    expect((await run(storefront, "chat")).cashOnDelivery).toMatch(/place the order in this chat/);
    expect((await run(storefront, "no")).cashOnDelivery).toBe("not offered");
    expect((await run(storefront, "")).cashOnDelivery).toBe("not known: the store has not said");
    expect((await run(storefront)).cashOnDelivery).toBe("not known: the store has not said");
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
    expect(both).toContain("name no country or price that it does not give");
    expect(prompt({ shipping: true })).toContain("use your shipping tool every time");
    expect(prompt({ payment: true })).toContain("for how shoppers can pay, use your payment tool every time");
    expect(prompt({})).not.toContain("Delivery and payment");
  });
});
