import type { PrismaClient } from "@prisma/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { handleChatTurn, type ChatTurnInput } from "../app/assistant/chat.server";
import { DailyBudget, RateLimiter } from "../app/assistant/rate-limit";
import {
  CUSTOM_PREFIX,
  GREETING_PRESETS,
  MAX_CUSTOM_ANSWER,
  PAYMENT_NAME_PRESETS,
  POLICY_CHOICES,
  POLICY_LABELS,
  SECTIONS,
  SECTION_FIELDS,
  TOPICS,
  cleanTopicAnswers,
  describeReturnConditions,
  describeTopics,
  fieldsOf,
  isSectionKey,
  sectionsWithErrors,
} from "../app/assistant/setting-options";
import {
  DEFAULT_SETTINGS,
  aboutBusiness,
  describeQuickPolicies,
  getSettings,
  saveSettings,
  settingsFromForm,
  setupProgress,
  type AssistantSettings,
} from "../app/assistant/settings.server";
import {
  NO_FACTS,
  cleanStoreFacts,
  describeStoreFacts,
  factsForPage,
  paymentNames,
  readStoreFacts,
  type StoreFacts,
} from "../app/assistant/store-facts";
import {
  getStoredFacts,
  refreshStoreFactsIfStale,
  syncStoreFacts,
  syncStoreFactsForPage,
} from "../app/assistant/store-facts.server";
import {
  applyInput,
  initialDraft,
  openBox,
  resolveDraft,
  sameDraft,
  type ControlInput,
} from "../app/components/settings/draft";
import { SettingsFields } from "../app/components/settings/SettingsFields";
import { PreviewWindow, previewSuggestions } from "../app/components/settings/StorefrontPreview";
import { syncedRows } from "../app/components/settings/SyncedFromShopify";
import { createTestDb } from "./helpers/db";
import { fakeGraphql, scriptedProvider, text } from "./helpers/fakes";

const SHOP_A = "shop-a.myshopify.com";
const SHOP_B = "shop-b.myshopify.com";

let db: PrismaClient;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});
afterAll(async () => {
  await cleanup();
});
beforeEach(async () => {
  await db.conversation.deleteMany();
  await db.shopSettings.deleteMany();
});

/** What Shopify's two APIs answer for a small, complete store. */
const adminAnswer = (overrides: Record<string, unknown> = {}) => ({
  shop: { name: "Alpine Outfitters", contactEmail: "hello@alpine.example", currencyCode: "CAD" },
  productsCount: { count: 42, precision: "EXACT" },
  giftCardProducts: { nodes: [{ id: "gid://shopify/Product/9" }] },
  ...overrides,
});
const storefrontAnswer = (overrides: Record<string, unknown> = {}) => ({
  shop: {
    name: "Alpine Outfitters",
    description: "Small-batch snowboards, built in Canada.",
    shipsToCountries: ["US", "CA"],
    paymentSettings: {
      acceptedCardBrands: ["VISA", "MASTERCARD"],
      supportedDigitalWallets: ["SHOPIFY_PAY"],
    },
    refundPolicy: { id: "gid://shopify/ShopPolicy/1" },
    shippingPolicy: null,
    privacyPolicy: { id: "gid://shopify/ShopPolicy/3" },
    termsOfService: null,
    ...overrides,
  },
});
const FACTS: StoreFacts = {
  syncedAt: "2026-11-26T10:00:00.000Z",
  shopName: "Alpine Outfitters",
  description: "Small-batch snowboards, built in Canada.",
  currencyCode: "CAD",
  contactEmail: "hello@alpine.example",
  shipsTo: ["US", "CA"],
  cards: ["VISA", "MASTERCARD"],
  wallets: ["SHOPIFY_PAY"],
  policies: { refund: true, shipping: false, privacy: true, terms: false },
  products: 42,
  giftCards: true,
};
const storeFacts = (shop: string, facts: StoreFacts) =>
  db.shopSettings.upsert({
    where: { shop },
    create: { shop, storeFacts: JSON.stringify(facts) },
    update: { storeFacts: JSON.stringify(facts) },
  });

describe("the five parts of Settings", () => {
  it("put every setting in exactly one part", () => {
    const placed = SECTIONS.flatMap((section) => [...SECTION_FIELDS[section.key]]);
    expect(new Set(placed).size).toBe(placed.length);
    expect([...placed].sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    expect(SECTIONS.map((section) => section.key)).toEqual([
      "assistant",
      "shopping",
      "orders",
      "policies",
      "knowledge",
    ]);
    expect(fieldsOf(["shopping", "orders"])).toEqual([
      ...SECTION_FIELDS.shopping,
      ...SECTION_FIELDS.orders,
    ]);
  });

  it("know which part holds a field the server refused", () => {
    expect(sectionsWithErrors({})).toEqual([]);
    expect(sectionsWithErrors({ topics: "too long", shippingAmount: "not an amount" })).toEqual([
      "policies",
      "knowledge",
    ]);
    expect(isSectionKey("policies")).toBe(true);
    expect(isSectionKey("billing")).toBe(false);
    expect(isSectionKey(null)).toBe(false);
  });

  it("offer only choices the server accepts, each with words for the merchant", () => {
    for (const [field, choices] of Object.entries(POLICY_CHOICES)) {
      const labels = POLICY_LABELS[field as keyof typeof POLICY_CHOICES] as Record<string, string>;
      expect(Object.keys(labels).sort()).toEqual([...choices].sort());
      // The first choice is always "not set", and no two read the same.
      expect(choices[0]).toBe("");
      expect(new Set(Object.values(labels)).size).toBe(choices.length);
    }
    for (const topic of TOPICS) {
      const values: string[] = topic.options.map((option) => option.value);
      expect(new Set(values).size).toBe(values.length);
      // "" is "not set" and "custom" is the merchant's own words: neither is a listed answer.
      expect(values).not.toContain("");
      expect(values).not.toContain("custom");
      for (const option of topic.options) expect(option.says.length).toBeGreaterThan(20);
    }
    expect(new Set(TOPICS.map((topic) => topic.key)).size).toBe(TOPICS.length);
  });
});

describe("store policies as picks", () => {
  it("saves the new picks and reads them back", async () => {
    const result = await saveSettings(
      SHOP_A,
      {
        returnWindow: "30",
        // Out of order, twice: stored once each, in the list's own order.
        returnConditions: ["tags", "unused", "tags"],
        exchanges: "yes",
        refundMethod: "credit",
        shippingFee: "free_over",
        shippingAmount: " 75 ",
        codAvailable: "no",
      },
      db,
    );
    expect(result.ok).toBe(true);
    expect(await getSettings(SHOP_A, db)).toMatchObject({
      returnWindow: "30",
      returnConditions: ["unused", "tags"],
      exchanges: "yes",
      refundMethod: "credit",
      shippingFee: "free_over",
      shippingAmount: "75",
      codAvailable: "no",
    });
    // Stored as plain text, and only for this shop.
    expect((await db.shopSettings.findUnique({ where: { shop: SHOP_A } }))!.returnConditions).toBe(
      "unused,tags",
    );
    expect(await getSettings(SHOP_B, db)).toEqual(DEFAULT_SETTINGS);
  });

  it("refuses a pick that is not offered, and an amount that is not one", async () => {
    const result = await saveSettings(
      SHOP_A,
      {
        exchanges: "maybe",
        refundMethod: "cash",
        shippingFee: "pigeon",
        codAvailable: "sometimes",
        returnConditions: ["unused", "sniffed"],
        shippingAmount: "about fifty",
      },
      db,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual([
        "codAvailable",
        "exchanges",
        "refundMethod",
        "returnConditions",
        "shippingAmount",
        "shippingFee",
      ]);
      expect(result.errors.shippingAmount).toBe("Enter an amount like 50 or 4.99.");
    }
    for (const amount of ["4.999", "-5", "1e3", "12,50"]) {
      expect((await saveSettings(SHOP_A, { shippingAmount: amount }, db)).ok).toBe(false);
    }
    for (const amount of ["", "0", "50", "4.99", "1234567.5"]) {
      expect((await saveSettings(SHOP_A, { shippingAmount: amount }, db)).ok).toBe(true);
    }
  });

  it("drops what is stored but no longer offered, instead of failing", async () => {
    await db.shopSettings.create({
      data: {
        shop: SHOP_A,
        returnConditions: "unused,sniffed,tags",
        exchanges: "maybe",
        shippingAmount: "lots",
        aboutStore: "telepathy",
        topics: "{not json",
      },
    });
    expect(await getSettings(SHOP_A, db)).toMatchObject({
      returnConditions: ["unused", "tags"],
      exchanges: "",
      shippingAmount: "",
      aboutStore: "shopify",
      topics: {},
    });
  });

  it("says each pick to the assistant in a plain sentence", () => {
    const settings: AssistantSettings = {
      ...DEFAULT_SETTINGS,
      returnWindow: "30",
      returnConditions: ["unused", "tags", "no_sale"],
      returnShipping: "customer",
      exchanges: "yes",
      refundMethod: "either",
      shippingFee: "free_over",
      shippingAmount: "75",
      codAvailable: "yes",
    };
    expect(describeQuickPolicies(settings, FACTS).split("\n")).toEqual([
      "Returns: accepted within 30 days of delivery.",
      "Return conditions: Items must be unused and unworn. Tags must still be attached. Sale items cannot be returned.",
      "Return shipping: paid by the customer.",
      "Refunds: the customer chooses between the original payment method and store credit, once the store approves the return.",
      "Exchanges: the store exchanges items. The shopper contacts the store to arrange one.",
      "Shipping cost: free on orders over 75 CAD. Below that, the checkout shows the cost.",
      "Cash on delivery: available. The shopper chooses it at checkout.",
    ]);
    expect(describeReturnConditions([])).toBe("");
  });

  it("states a shipping amount only with the pick it belongs to, in the store's currency", () => {
    const cost = (overrides: Partial<AssistantSettings>, facts: StoreFacts = FACTS) =>
      describeQuickPolicies({ ...DEFAULT_SETTINGS, ...overrides }, facts);

    expect(cost({ shippingFee: "free", shippingAmount: "75" })).toBe("Shipping cost: free on every order.");
    expect(cost({ shippingFee: "flat", shippingAmount: "4.99" })).toBe(
      "Shipping cost: a flat 4.99 CAD per order.",
    );
    expect(cost({ shippingFee: "flat" })).toBe("Shipping cost: one flat rate per order, shown at checkout.");
    expect(cost({ shippingFee: "free_over" })).toMatch(/free above a minimum order value/);
    expect(cost({ shippingFee: "calculated", shippingAmount: "9" })).toBe(
      "Shipping cost: calculated at checkout from the delivery address.",
    );
    // Shopify has not said which currency: no currency is made up.
    expect(cost({ shippingFee: "flat", shippingAmount: "5" }, NO_FACTS)).toBe(
      "Shipping cost: a flat 5 in the store's currency per order.",
    );
  });

  it("leaves out what would contradict something else the assistant is told", () => {
    // No returns: nothing about how returns work.
    const noReturns = describeQuickPolicies({
      ...DEFAULT_SETTINGS,
      returnWindow: "none",
      returnConditions: ["unused"],
      returnShipping: "free",
      refundMethod: "original",
      exchanges: "no",
    });
    expect(noReturns.split("\n")).toEqual([
      "Returns: this store does not accept returns.",
      "Exchanges: not offered.",
    ]);

    // Pay-on-delivery orders in the chat already say cash on delivery exists.
    const chatOrders = { ...DEFAULT_SETTINGS, allowChatOrders: true, codAvailable: "no" as const };
    expect(describeQuickPolicies(chatOrders)).toBe("");
    expect(describeQuickPolicies({ ...chatOrders, allowCheckout: false })).toBe(
      "Cash on delivery: not available.",
    );

    // Shopify's own list of countries replaces the merchant's pick for the same thing.
    const picked = { ...DEFAULT_SETTINGS, shipsTo: "international" as const };
    expect(describeQuickPolicies(picked, NO_FACTS)).toBe("Shipping area: ships internationally.");
    expect(describeQuickPolicies(picked, FACTS)).toBe("");
    expect(describeQuickPolicies(picked, { syncedAt: FACTS.syncedAt, shipsTo: [] })).toBe("");
  });

  it("reads tick boxes, structured answers and switches out of a submitted form", () => {
    const form = new FormData();
    // One tick box per value under one name, or one field with commas: both arrive.
    form.append("returnConditions", "unused");
    form.append("returnConditions", "tags,receipt");
    form.set("topics", JSON.stringify({ sizing: "small" }));
    form.set("allowReturns", "on");
    form.set("shippingAmount", "75");

    expect(
      settingsFromForm(form, ["returnConditions", "topics", "allowReturns", "allowOrderEdit", "shippingAmount"]),
    ).toEqual({
      returnConditions: ["unused", "tags", "receipt"],
      topics: { sizing: "small" },
      allowReturns: true,
      allowOrderEdit: false,
      shippingAmount: "75",
    });
    // Nothing ticked, nothing answered.
    expect(settingsFromForm(new FormData(), ["returnConditions", "topics"])).toEqual({
      returnConditions: [],
      topics: {},
    });
  });

  it("refuses answers that are not readable instead of saving something else", async () => {
    const form = new FormData();
    form.set("topics", "{oops");
    const result = await saveSettings(SHOP_A, settingsFromForm(form, ["topics"]), db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors)).toEqual(["topics"]);
    expect(await db.shopSettings.count()).toBe(0);
  });

  it("counts the new picks as progress in setup", () => {
    expect(setupProgress(DEFAULT_SETTINGS)).toEqual({ policies: false, details: false });
    expect(setupProgress({ ...DEFAULT_SETTINGS, returnConditions: ["unused"] }).policies).toBe(true);
    expect(setupProgress({ ...DEFAULT_SETTINGS, codAvailable: "yes" }).policies).toBe(true);
    expect(setupProgress({ ...DEFAULT_SETTINGS, topics: { sizing: "small" } }).details).toBe(true);
    // Words left behind after switching back to Shopify's description are not in use.
    expect(setupProgress({ ...DEFAULT_SETTINGS, businessDescription: "old words" }).details).toBe(false);
  });
});

describe("answers picked for common questions", () => {
  it("keeps listed answers and the merchant's own words, and drops everything else", () => {
    expect(
      cleanTopicAnswers({
        sizing: "small",
        warranty: "forever", // not an answer on the list
        horoscope: "true", // not a topic
        hours: `${CUSTOM_PREFIX}  Weekdays\n10 to 4  `,
        care: CUSTOM_PREFIX, // "custom" with nothing written
        contact: 42,
      }),
    ).toEqual({ sizing: "small", hours: `${CUSTOM_PREFIX}Weekdays 10 to 4` });
    for (const notAnswers of [null, "sizing", ["small"], 7]) {
      expect(cleanTopicAnswers(notAnswers)).toEqual({});
    }
  });

  it("saves them, and refuses own words that run too long", async () => {
    const answers = { sizing: "chart", discounts: `${CUSTOM_PREFIX}Join the club for 10% off.` };
    expect((await saveSettings(SHOP_A, { topics: { ...answers, horoscope: "x" } }, db)).ok).toBe(true);
    expect((await getSettings(SHOP_A, db)).topics).toEqual(answers);

    const tooLong = await saveSettings(
      SHOP_A,
      { topics: { care: CUSTOM_PREFIX + "x".repeat(MAX_CUSTOM_ANSWER + 1) } },
      db,
    );
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.errors.topics).toBe("Keep your own answers under 300 characters.");
    // Refused, so what was saved before is still there.
    expect((await getSettings(SHOP_A, db)).topics).toEqual(answers);
  });

  it("tells the assistant only what was answered", () => {
    expect(describeTopics({})).toBe("");
    expect(
      describeTopics({ sizing: "small", warranty: "1y", hours: `${CUSTOM_PREFIX}Weekdays 10 to 4.` }).split("\n"),
    ).toEqual([
      "Sizing: items run small. Suggest ordering one size up.",
      "Warranty: products have a 1-year warranty.",
      "Support hours: Weekdays 10 to 4.",
    ]);
  });

  it("gives out the store's contact address only when the merchant picked it", () => {
    const email = "hello@alpine.example";
    expect(describeTopics({ contact: "email" }, email)).toBe(
      "Contact: shoppers can email the store at hello@alpine.example.",
    );
    // Picked, but Shopify had no address: nothing is invented.
    expect(describeTopics({ contact: "email" })).not.toContain("@");
    // Not picked: the address is known but stays out.
    for (const answers of [{}, { contact: "page" }, { sizing: "small" }]) {
      expect(describeTopics(answers, email)).not.toContain(email);
    }
  });
});

describe("what Shopify says about the store", () => {
  it("keeps only facts of the right shape", () => {
    expect(
      cleanStoreFacts({
        syncedAt: "2026-11-26T10:00:00Z",
        shopName: "  Alpine\n Outfitters ",
        description: "x".repeat(900),
        currencyCode: "cad",
        contactEmail: "not an address",
        shipsTo: ["CA", "us", "CA", 7, "USA"],
        cards: ["VISA", "visa", "<script>"],
        wallets: "SHOPIFY_PAY",
        policies: { refund: true, shipping: "yes" },
        products: -3,
        giftCards: "true",
        admin: true,
      }),
    ).toEqual({
      syncedAt: "2026-11-26T10:00:00.000Z",
      shopName: "Alpine Outfitters",
      description: "x".repeat(400),
      shipsTo: ["CA"],
      cards: ["VISA"],
      policies: { refund: true, shipping: false, privacy: false, terms: false },
    });
    for (const nothing of [null, "facts", [], 5]) expect(cleanStoreFacts(nothing)).toEqual(NO_FACTS);
    expect(readStoreFacts("{not json")).toEqual(NO_FACTS);
    expect(readStoreFacts(undefined)).toEqual(NO_FACTS);
    expect(readStoreFacts(JSON.stringify(FACTS))).toEqual(FACTS);
  });

  it("tells the assistant where the store delivers and how shoppers can pay", () => {
    expect(describeStoreFacts(NO_FACTS)).toBe("");
    expect(describeStoreFacts(FACTS).split("\n")).toEqual([
      "Delivery area: this store delivers to these 2 countries: Canada, United States. It has no shipping set up for any other country.",
      "Cards accepted at checkout: Visa, Mastercard.",
      "Wallets accepted at checkout: Shop Pay.",
    ]);
    expect(describeStoreFacts({ syncedAt: null, shipsTo: ["PK"] })).toBe(
      "Delivery area: this store delivers to Pakistan. It has no shipping set up for any other country.",
    );
    // No zones, no cards: nothing is claimed either way.
    expect(describeStoreFacts({ syncedAt: null, shipsTo: [], cards: [], wallets: [] })).toBe("");

    // Too many countries to name: no list, and no promise about any one of them.
    const worldwide = describeStoreFacts({
      syncedAt: null,
      shipsTo: Array.from({ length: 60 }, (_, index) =>
        String.fromCharCode(65 + (index % 26)) + String.fromCharCode(65 + Math.floor(index / 26)),
      ),
    });
    expect(worldwide).toMatch(/^Delivery area: this store delivers to 60 countries and regions worldwide\./);
    expect(worldwide).toContain("the checkout confirms");

    // Never the contact address, the product count or anything else here.
    expect(describeStoreFacts(FACTS)).not.toContain("hello@");
    expect(describeStoreFacts(FACTS)).not.toContain("42");
    expect(paymentNames({ syncedAt: null, cards: ["AMERICAN_EXPRESS", "SOME_NEW_CARD"], wallets: ["ANDROID_PAY", "GOOGLE_PAY"] })).toEqual({
      cards: ["American Express", "Some New Card"],
      wallets: ["Google Pay"],
    });
  });

  it("asks Shopify and stores the answer for the signed-in shop only", async () => {
    await saveSettings(SHOP_B, { assistantName: "Other" }, db);
    const admin = fakeGraphql(adminAnswer());
    const storefront = fakeGraphql(storefrontAnswer());
    const now = new Date("2026-11-26T10:00:00Z");

    const { facts, reached } = await syncStoreFacts(SHOP_A, { admin, storefront }, { db, now });
    expect(reached).toEqual({ admin: true, storefront: true });
    expect(facts).toEqual(FACTS);
    expect([admin.calls.length, storefront.calls.length]).toEqual([1, 1]);
    // Kept with the shop's settings, without touching the settings themselves.
    expect(await getStoredFacts(SHOP_A, db)).toEqual(FACTS);
    expect(await getSettings(SHOP_A, db)).toEqual(DEFAULT_SETTINGS);
    expect(await getStoredFacts(SHOP_B, db)).toEqual(NO_FACTS);
    expect((await getSettings(SHOP_B, db)).assistantName).toBe("Other");
  });

  it("does not ask again while what it has is fresh", async () => {
    const clients = () => ({ admin: fakeGraphql(adminAnswer()), storefront: fakeGraphql(storefrontAnswer()) });
    const first = clients();
    await syncStoreFacts(SHOP_A, first, { db, now: new Date("2026-11-26T10:00:00Z") });

    const soon = clients();
    const cached = await syncStoreFacts(SHOP_A, soon, {
      db,
      now: new Date("2026-11-26T10:00:30Z"),
      maxAgeMs: 60_000,
    });
    expect(cached).toEqual({ facts: FACTS, reached: null });
    expect([soon.admin.calls.length, soon.storefront.calls.length]).toEqual([0, 0]);

    const later = clients();
    const refreshed = await syncStoreFacts(SHOP_A, later, {
      db,
      now: new Date("2026-11-26T10:05:00Z"),
      maxAgeMs: 60_000,
    });
    expect(refreshed.reached).toEqual({ admin: true, storefront: true });
    expect(refreshed.facts.syncedAt).toBe("2026-11-26T10:05:00.000Z");
  });

  it("keeps what it knew from an API it could not reach, and forgets what Shopify no longer has", async () => {
    await syncStoreFacts(
      SHOP_A,
      { admin: fakeGraphql(adminAnswer()), storefront: fakeGraphql(storefrontAnswer()) },
      { db, now: new Date("2026-11-26T10:00:00Z") },
    );

    // The Admin API is down; the store dropped its description and a country.
    const partial = await syncStoreFacts(
      SHOP_A,
      {
        admin: fakeGraphql(new Error("Admin GraphQL error: throttled")),
        storefront: fakeGraphql(storefrontAnswer({ description: null, shipsToCountries: ["CA"] })),
      },
      { db, now: new Date("2026-11-27T10:00:00Z") },
    );
    expect(partial.reached).toEqual({ admin: false, storefront: true });
    expect(partial.facts).toMatchObject({
      contactEmail: "hello@alpine.example", // from the Admin API, as last known
      products: 42,
      shipsTo: ["CA"],
      syncedAt: "2026-11-27T10:00:00.000Z",
    });
    expect(partial.facts).not.toHaveProperty("description");

    // Nothing reachable: nothing changes, and the time of the last answer stays.
    const down = await syncStoreFacts(
      SHOP_A,
      { admin: fakeGraphql(new Error("offline")), storefront: fakeGraphql(new Error("offline")) },
      { db, now: new Date("2026-11-28T10:00:00Z") },
    );
    expect(down.reached).toEqual({ admin: false, storefront: false });
    expect(down.facts).toEqual(partial.facts);
    expect(await getStoredFacts(SHOP_A, db)).toEqual(partial.facts);
  });

  it("never takes a page or a chat down when the facts cannot be read or stored", async () => {
    const broken = {
      shopSettings: {
        findUnique: async () => {
          throw new Error("database is locked");
        },
        upsert: async () => {
          throw new Error("database is locked");
        },
      },
    } as unknown as PrismaClient;

    expect(await getStoredFacts(SHOP_A, broken)).toEqual(NO_FACTS);
    const page = await syncStoreFactsForPage(
      SHOP_A,
      { admin: fakeGraphql(adminAnswer()), storefront: fakeGraphql(storefrontAnswer()) },
      { db: broken },
    );
    expect(page).toEqual({ facts: NO_FACTS, reached: { admin: false, storefront: false } });
  });

  it("refreshes in the background once a day, and leaves a never-synced store alone", async () => {
    const clients = () => ({ admin: fakeGraphql(adminAnswer()), storefront: fakeGraphql(storefrontAnswer()) });
    const shop = "refresh-test.myshopify.com";
    const now = new Date("2026-11-28T12:00:00Z");

    // Never synced: the merchant opening the app does the first sync, not a chat.
    const untouched = clients();
    expect(refreshStoreFactsIfStale(shop, NO_FACTS, untouched, { db, now })).toBeNull();
    // Synced within the day: still good.
    expect(
      refreshStoreFactsIfStale(shop, { syncedAt: "2026-11-28T01:00:00.000Z" }, untouched, { db, now }),
    ).toBeNull();
    expect(untouched.admin.calls).toHaveLength(0);

    const stale: StoreFacts = { syncedAt: "2026-11-26T10:00:00.000Z", shipsTo: ["GB"] };
    const used = clients();
    const running = refreshStoreFactsIfStale(shop, stale, used, { db, now });
    expect(running).not.toBeNull();
    await running;
    expect((await getStoredFacts(shop, db)).shipsTo).toEqual(["US", "CA"]);

    // A second chat a minute later does not ask Shopify again.
    const again = clients();
    expect(
      refreshStoreFactsIfStale(shop, stale, again, { db, now: new Date(now.getTime() + 60_000) }),
    ).toBeNull();
    expect(again.storefront.calls).toHaveLength(0);
    // With no way to ask, nothing is started.
    expect(refreshStoreFactsIfStale("no-clients.myshopify.com", stale, {}, { db, now })).toBeNull();
  });

  it("describes the business in the merchant's words, Shopify's, or not at all, as chosen", () => {
    const written = { ...DEFAULT_SETTINGS, businessDescription: "We make snowboards." };
    expect(aboutBusiness({ ...written, aboutStore: "custom" }, FACTS)).toBe("We make snowboards.");
    expect(aboutBusiness({ ...written, aboutStore: "shopify" }, FACTS)).toBe(
      "Small-batch snowboards, built in Canada.",
    );
    expect(aboutBusiness({ ...written, aboutStore: "shopify" }, NO_FACTS)).toBe("");
    expect(aboutBusiness({ ...written, aboutStore: "none" }, FACTS)).toBe("");
  });

  it("sums the facts up for the merchant, and says when something could not be checked", () => {
    const rows = (facts: StoreFacts) => syncedRows(factsForPage(facts));
    const tones = (facts: StoreFacts) => Object.fromEntries(rows(facts).map((row) => [row.label, row.tone]));
    expect(rows(FACTS).map((row) => `${row.label}: ${row.value}`)).toEqual([
      "Catalog: 42 active products, with prices, stock and images",
      "Policies: Published: Refund, Privacy",
      "Shipping regions: Canada, United States",
      "Payment methods: Visa, Mastercard, Shop Pay",
      "Store details: Your store's name, currency (CAD), contact email",
    ]);
    // A shipping policy is missing: worth the merchant's attention.
    expect(tones(FACTS)).toMatchObject({ Catalog: "success", Policies: "warning", "Shipping regions": "success" });
    expect(new Set(Object.values(tones(NO_FACTS)))).toEqual(new Set(["neutral"]));
    expect(rows(NO_FACTS).every((row) => row.value === "Couldn't check just now")).toBe(true);
    expect(tones({ syncedAt: null, products: 0, shipsTo: [], cards: [], wallets: [] })).toMatchObject({
      Catalog: "warning",
      "Shipping regions": "warning",
      "Payment methods": "neutral",
    });
  });
});

describe("what the assistant is told from Settings", () => {
  const turn = (overrides: Partial<ChatTurnInput> = {}, provider = scriptedProvider([text("ok")])) =>
    handleChatTurn(
      {
        shop: SHOP_A,
        audience: "shopper",
        visitorId: "visitor-0001",
        message: "hello",
        admin: fakeGraphql({ shop: { name: "Alpine Outfitters" } }),
        storefront: fakeGraphql({}),
        ...overrides,
      },
      { db, provider, rateLimiter: new RateLimiter(), tokenBudget: new DailyBudget() },
    ).then(() => provider.requests[0].messages[0].content as string);

  it("adds the picks and Shopify's facts to the owner's notes, without asking Shopify during the chat", async () => {
    await saveSettings(
      SHOP_A,
      {
        returnWindow: "30",
        shippingFee: "flat",
        shippingAmount: "4.99",
        topics: { sizing: "small", contact: "email" },
      },
      db,
    );
    await storeFacts(SHOP_A, { ...FACTS, syncedAt: new Date().toISOString() });
    const storefront = fakeGraphql({});

    const system = await turn({ storefront });
    for (const line of [
      "Returns: accepted within 30 days of delivery.",
      "Shipping cost: a flat 4.99 CAD per order.",
      "Delivery area: this store delivers to these 2 countries: Canada, United States.",
      "Cards accepted at checkout: Visa, Mastercard.",
      "Sizing: items run small. Suggest ordering one size up.",
      "Contact: shoppers can email the store at hello@alpine.example.",
      // The store's own description, since the merchant wrote none.
      "Small-batch snowboards, built in Canada.",
    ]) {
      expect(system).toContain(line);
    }
    // Facts are notes, placed after the rules they cannot override.
    expect(system.indexOf("Rules:")).toBeLessThan(system.indexOf("From the store's own Shopify settings"));
    // Everything came from what was stored: the chat asked the Storefront API nothing.
    expect(storefront.calls).toHaveLength(0);
  });

  it("keeps the contact address and the description out unless the merchant chose them", async () => {
    await saveSettings(SHOP_A, { aboutStore: "none", topics: { contact: "page" } }, db);
    await storeFacts(SHOP_A, { ...FACTS, syncedAt: new Date().toISOString() });

    const system = await turn();
    expect(system).not.toContain("hello@alpine.example");
    expect(system).not.toContain("Small-batch snowboards");
    expect(system).toContain("Contact: shoppers can reach the store through the contact page");
  });

  it("says nothing new for a store that was never synced and has no picks", async () => {
    const system = await turn();
    expect(system).not.toContain("Notes from the store owner");
    expect(system).not.toContain("Delivery area");
  });

  it("tells the merchant's own assistant none of it", async () => {
    await saveSettings(SHOP_A, { topics: { sizing: "small" } }, db);
    await storeFacts(SHOP_A, { ...FACTS, syncedAt: new Date().toISOString() });
    const system = await turn({ audience: "merchant" });
    expect(system).not.toContain("Delivery area");
    expect(system).not.toContain("Sizing");
  });

  it("answers from day-old facts at once and refreshes them behind the reply", async () => {
    const shop = "stale-chat.myshopify.com";
    await storeFacts(shop, { syncedAt: "2026-01-01T00:00:00.000Z", shipsTo: ["GB"] });
    const admin = fakeGraphql(adminAnswer());
    const storefront = fakeGraphql(storefrontAnswer());

    const system = await turn({ shop, admin, storefront });
    // This reply used what was stored.
    expect(system).toContain("this store delivers to United Kingdom.");

    // The next one has Shopify's current answer.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await getStoredFacts(shop, db)).shipsTo).toEqual(["US", "CA"]);
    const next = await turn({ shop, visitorId: "visitor-0002" });
    expect(next).toContain("Canada, United States");
  });
});

describe("the settings pages on the server", () => {
  it("draw every part before any script runs, with only the open part and open options on show", () => {
    const state = initialDraft(DEFAULT_SETTINGS);
    const markup = renderToStaticMarkup(
      createElement(SettingsFields, {
        show: SECTIONS.map((section) => section.key),
        active: "policies",
        settings: DEFAULT_SETTINGS,
        facts: factsForPage(FACTS),
        errors: {},
        shop: SHOP_A,
        draft: {
          state,
          draft: resolveDraft(state),
          dirty: false,
          handleInput: () => {},
          open: () => {},
          reset: () => {},
        },
      }),
    );

    // All five parts are in the page; four are out of sight.
    expect(markup.match(/data-section="\w+"( hidden="")?/g)).toEqual([
      'data-section="assistant" hidden=""',
      'data-section="shopping" hidden=""',
      'data-section="orders" hidden=""',
      'data-section="policies"',
      'data-section="knowledge" hidden=""',
    ]);
    // What Shopify said is on the page as it was read, countries named by the server.
    expect(markup).toContain("Delivers to 2 countries: Canada and United States.");
    // The fields worked out from several controls carry the saved values.
    expect(markup).toContain('name="topics" value="{}"');
    expect(markup).toContain(`name="greeting" value="${DEFAULT_SETTINGS.greeting}"`);
  });

  it("draw the storefront preview the same way", () => {
    const markup = renderToStaticMarkup(
      createElement(PreviewWindow, {
        name: "Ava",
        greeting: DEFAULT_SETTINGS.greeting,
        suggestions: previewSuggestions(DEFAULT_SETTINGS),
        entries: [],
        pending: false,
        ratings: true,
        blocked: null,
        onSend: () => {},
        onReset: () => {},
      }),
    );
    expect(markup).toContain("Ava");
    expect(markup).toContain("What are your best sellers?");
    expect(markup).toContain("AI assistant. Answers can contain mistakes.");
  });
});

describe("the merchant's unsaved picks", () => {
  const control = (name: string, tag: string, extra: Partial<ControlInput> = {}): ControlInput => ({
    name,
    tag,
    checked: false,
    value: "",
    values: [],
    ...extra,
  });
  const RICH: AssistantSettings = {
    ...DEFAULT_SETTINGS,
    greeting: "Hey there, welcome to Alpine!",
    orderPaymentName: PAYMENT_NAME_PRESETS[1],
    orderPaymentNote: "Pay the courier in cash.",
    returnPolicy: "Waxed boards are exchange only.",
    topics: { sizing: "chart", hours: `${CUSTOM_PREFIX}Weekdays 10 to 4` },
  };

  it("start from the saved settings and would save exactly those", () => {
    for (const settings of [DEFAULT_SETTINGS, RICH]) {
      expect(resolveDraft(initialDraft(settings))).toEqual(settings);
    }
    // A preset is shown as that preset, the merchant's own words as "custom".
    expect(initialDraft(DEFAULT_SETTINGS).ui).toMatchObject({ greetingMode: "0", paymentNameMode: "" });
    expect(initialDraft(RICH).ui).toMatchObject({
      greetingMode: "custom",
      greetingText: "Hey there, welcome to Alpine!",
      paymentNameMode: "1",
      paymentNoteMode: "custom",
      topicPick: expect.objectContaining({ sizing: "chart", hours: "custom", warranty: "" }),
      topicText: expect.objectContaining({ hours: "Weekdays 10 to 4" }),
    });
    // A text box is on show from the start only where something was written.
    expect(initialDraft(RICH).ui.open).toEqual({
      returnPolicy: true,
      shippingInfo: false,
      faq: false,
      instructions: false,
    });
    expect(openBox(initialDraft(DEFAULT_SETTINGS), "faq").ui.open.faq).toBe(true);
  });

  it("follow each kind of control", () => {
    let state = initialDraft(DEFAULT_SETTINGS);
    const apply = (input: ControlInput) => {
      state = applyInput(state, input);
    };

    apply(control("orderLookupEnabled", "s-switch", { checked: true }));
    apply(control("returnWindow", "s-select", { value: "30" }));
    apply(control("retentionDays", "s-select", { value: "90" }));
    apply(control("aboutStore", "s-choice-list", { values: ["none"] }));
    apply(control("assistantName", "s-text-field", { value: "Mia" }));
    // Tick boxes share a name: each adds or removes its own value.
    apply(control("returnConditions", "s-checkbox", { checked: true, value: "tags" }));
    apply(control("returnConditions", "s-checkbox", { checked: true, value: "unused" }));
    apply(control("returnConditions", "s-checkbox", { checked: false, value: "tags" }));

    expect(resolveDraft(state)).toMatchObject({
      orderLookupEnabled: true,
      returnWindow: "30",
      retentionDays: 90,
      aboutStore: "none",
      assistantName: "Mia",
      returnConditions: ["unused"],
    });
    expect(sameDraft(resolveDraft(state), DEFAULT_SETTINGS)).toBe(false);

    // A control the page does not know changes nothing.
    const before = state;
    apply(control("shop", "s-text-field", { value: "victim.myshopify.com" }));
    apply(control("ui.somethingElse", "s-select", { value: "x" }));
    expect(state).toBe(before);
  });

  it("work out the welcome message, the payment wording and the answers from their controls", () => {
    let state = initialDraft(DEFAULT_SETTINGS);
    const apply = (input: ControlInput) => {
      state = applyInput(state, input);
    };

    apply(control("ui.greetingMode", "s-choice-list", { values: ["2"] }));
    expect(resolveDraft(state).greeting).toBe(GREETING_PRESETS[2]);
    // "Write my own" with nothing written saves nothing, which the server reads as the default.
    apply(control("ui.greetingMode", "s-choice-list", { values: ["custom"] }));
    expect(resolveDraft(state).greeting).toBe("");
    apply(control("ui.greetingText", "s-text-area", { value: "  Hello from Alpine!  " }));
    expect(resolveDraft(state).greeting).toBe("Hello from Alpine!");

    apply(control("ui.paymentNameMode", "s-select", { value: "0" }));
    expect(resolveDraft(state).orderPaymentName).toBe(PAYMENT_NAME_PRESETS[0]);
    apply(control("ui.paymentNameMode", "s-select", { value: "custom" }));
    apply(control("ui.paymentNameText", "s-text-field", { value: "Pay the courier" }));
    expect(resolveDraft(state).orderPaymentName).toBe("Pay the courier");
    apply(control("ui.paymentNameMode", "s-select", { value: "" }));
    expect(resolveDraft(state).orderPaymentName).toBe("");

    apply(control("ui.topic.sizing", "s-select", { value: "small" }));
    apply(control("ui.topic.hours", "s-select", { value: "custom" }));
    expect(resolveDraft(state).topics).toEqual({ sizing: "small" });
    apply(control("ui.topicText.hours", "s-text-field", { value: " Weekdays 10 to 4 " }));
    expect(resolveDraft(state).topics).toEqual({
      sizing: "small",
      hours: `${CUSTOM_PREFIX}Weekdays 10 to 4`,
    });
    apply(control("ui.topic.sizing", "s-select", { value: "" }));
    expect(resolveDraft(state).topics).toEqual({ hours: `${CUSTOM_PREFIX}Weekdays 10 to 4` });
    // What the page works out is what the server accepts.
    expect(cleanTopicAnswers(resolveDraft(state).topics)).toEqual(resolveDraft(state).topics);
  });

  it("change what the preview suggests asking", () => {
    expect(previewSuggestions(DEFAULT_SETTINGS)).toEqual([
      "What are your best sellers?",
      "Add your best seller to my cart",
      "What is your return policy?",
    ]);
    expect(
      previewSuggestions({
        ...DEFAULT_SETTINGS,
        allowAddToCart: false,
        orderLookupEnabled: true,
        allowReturns: true,
        allowOrderCancel: true,
      }),
    ).toEqual([
      "What are your best sellers?",
      "Where is my order?",
      "I want to return an item",
      "Cancel my order",
    ]);
  });
});
