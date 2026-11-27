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
  describeShippingPicks,
  shippingPicksText,
  getSettings,
  saveSettings,
  settingsFromForm,
  setupProgress,
  type AssistantSettings,
} from "../app/assistant/settings.server";
import {
  NO_FACTS,
  cleanStoreFacts,
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
import { NO_SHIPPING_RATES, shippingForPage } from "../app/assistant/shipping";
import { ACCENT_PRESETS, DEFAULT_ACCENT, isAccent } from "../app/assistant/widget-look";
import { SettingsFields } from "../app/components/settings/SettingsFields";
import { PreviewWindow, previewSuggestions } from "../app/components/settings/StorefrontPreview";
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
  shop: { contactEmail: "hello@alpine.example", currencyCode: "CAD" },
  ...overrides,
});
const storefrontAnswer = (overrides: Record<string, unknown> = {}) => ({
  shop: {
    description: "Small-batch snowboards, built in Canada.",
    shipsToCountries: ["US", "CA"],
    refundPolicy: { id: "gid://shopify/ShopPolicy/1" },
    shippingPolicy: null,
    ...overrides,
  },
});
const FACTS: StoreFacts = {
  syncedAt: "2026-11-26T10:00:00.000Z",
  description: "Small-batch snowboards, built in Canada.",
  currencyCode: "CAD",
  contactEmail: "hello@alpine.example",
  shipsTo: ["US", "CA"],
  policies: { refund: true, shipping: false },
};
const storeFacts = (shop: string, facts: StoreFacts) =>
  db.shopSettings.upsert({
    where: { shop },
    create: { shop, storeFacts: JSON.stringify(facts) },
    update: { storeFacts: JSON.stringify(facts) },
  });

describe("the four parts of Settings", () => {
  it("put every setting in exactly one part", () => {
    const placed = SECTIONS.flatMap((section) => [...SECTION_FIELDS[section.key]]);
    expect(new Set(placed).size).toBe(placed.length);
    expect([...placed].sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    // No part for shopping: adding to the cart and the way to the checkout
    // are on for every store, so there is nothing to set.
    expect(SECTIONS.map((section) => section.key)).toEqual([
      "assistant",
      "orders",
      "policies",
      "knowledge",
    ]);
    expect(placed).not.toContain("allowAddToCart");
    expect(placed).not.toContain("allowCheckout");
    expect(fieldsOf(["assistant", "orders"])).toEqual([
      ...SECTION_FIELDS.assistant,
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

describe("how the chat looks", () => {
  it("is the app's own color, bottom right, until the merchant picks", async () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ accentColor: DEFAULT_ACCENT, widgetPosition: "right" });
    expect(await getSettings(SHOP_A, db)).toMatchObject({
      accentColor: DEFAULT_ACCENT,
      widgetPosition: "right",
    });
    // Each swatch is a color the widget takes, and the first is the default.
    expect(ACCENT_PRESETS[0].value).toBe(DEFAULT_ACCENT);
    for (const preset of ACCENT_PRESETS) expect(isAccent(preset.value), preset.label).toBe(true);
    expect(new Set(ACCENT_PRESETS.map((preset) => preset.value)).size).toBe(ACCENT_PRESETS.length);
  });

  it("is saved as picked, for this shop only", async () => {
    const saved = await saveSettings(SHOP_A, { accentColor: " #ab12cd ", widgetPosition: "left" }, db);
    expect(saved.ok).toBe(true);
    // One spelling of a color, whatever was typed.
    expect(await getSettings(SHOP_A, db)).toMatchObject({ accentColor: "#AB12CD", widgetPosition: "left" });
    expect(await getSettings(SHOP_B, db)).toMatchObject({
      accentColor: DEFAULT_ACCENT,
      widgetPosition: "right",
    });
    // Read from the form like any other pick.
    const form = new FormData();
    form.set("accentColor", "#0F766E");
    form.set("widgetPosition", "right");
    expect(settingsFromForm(form, ["accentColor", "widgetPosition"])).toEqual({
      accentColor: "#0F766E",
      widgetPosition: "right",
    });
  });

  it("refuses what is not a color or a corner, and keeps what the store had", async () => {
    await saveSettings(SHOP_A, { accentColor: "#2563EB", widgetPosition: "left" }, db);
    for (const accentColor of ["", "red", "#12", "#GGGGGG", "#2563EB; background: url(x)", "rgb(1, 2, 3)"]) {
      const refused = await saveSettings(SHOP_A, { accentColor }, db);
      expect(refused, accentColor).toEqual({
        ok: false,
        errors: { accentColor: "Pick a colour, or enter one like #1F3D2F." },
      });
    }
    const corner = await saveSettings(SHOP_A, { widgetPosition: "top" }, db);
    expect(corner).toMatchObject({ ok: false, errors: { widgetPosition: expect.any(String) } });
    expect(await getSettings(SHOP_A, db)).toMatchObject({ accentColor: "#2563EB", widgetPosition: "left" });

    // Something in the database that is neither is read as the default, never passed on.
    await db.shopSettings.update({
      where: { shop: SHOP_A },
      data: { accentColor: "javascript:alert(1)", widgetPosition: "middle" },
    });
    expect(await getSettings(SHOP_A, db)).toMatchObject({
      accentColor: DEFAULT_ACCENT,
      widgetPosition: "right",
    });
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
        returnConditions: ["unused", "sniffed"],
      },
      db,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual([
        "exchanges",
        "refundMethod",
        "returnConditions",
        "shippingFee",
      ]);
    }
    const amount = await saveSettings(SHOP_A, { shippingFee: "flat", shippingAmount: "about fifty" }, db);
    expect(amount.ok).toBe(false);
    if (!amount.ok) {
      expect(amount.errors).toEqual({ shippingAmount: "Enter an amount like 50 or 4.99." });
    }
    for (const amount of ["4.999", "-5", "1e3", "12,50"]) {
      expect((await saveSettings(SHOP_A, { shippingAmount: amount }, db)).ok).toBe(false);
    }
    for (const amount of ["", "0", "50", "4.99", "1234567.5"]) {
      expect((await saveSettings(SHOP_A, { shippingAmount: amount }, db)).ok).toBe(true);
    }
  });

  it("drops an amount saved with a shipping pick that has none, whatever was left in it", async () => {
    // Typed while "flat rate" was picked, then the pick was changed: the box
    // is hidden but still submitted. It must not block the save or linger.
    const saved = await saveSettings(SHOP_A, { shippingFee: "calculated", shippingAmount: "1.2345" }, db);
    expect(saved.ok).toBe(true);
    expect((await getSettings(SHOP_A, db)).shippingAmount).toBe("");

    // With a pick that takes one it is checked as before.
    expect((await saveSettings(SHOP_A, { shippingFee: "flat", shippingAmount: "1.2345" }, db)).ok).toBe(false);
    expect((await saveSettings(SHOP_A, { shippingFee: "flat", shippingAmount: "4.99" }, db)).ok).toBe(true);
    expect(await getSettings(SHOP_A, db)).toMatchObject({ shippingFee: "flat", shippingAmount: "4.99" });
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
    };
    expect(describeQuickPolicies(settings).split("\n")).toEqual([
      "Returns: accepted within 30 days of delivery.",
      "Return conditions: Items must be unused and unworn. Tags must still be attached. Sale items cannot be returned.",
      "Return shipping: paid by the customer.",
      "Refunds: the customer chooses between the original payment method and store credit, once the store approves the return.",
      "Exchanges: the store exchanges items. The shopper contacts the store to arrange one.",
    ]);
    // Nothing about paying on delivery: the checkout page shows what the store offers.
    expect(describeQuickPolicies(settings)).not.toMatch(/cash on delivery/i);
    // What delivery costs is asked of Shopify when a shopper asks. The pick is
    // kept apart, for when Shopify cannot say.
    expect(describeShippingPicks(settings, FACTS)).toEqual({
      cost: "Shipping cost: free on orders over 75 CAD. Below that, the checkout shows the cost.",
    });
    expect(describeReturnConditions([])).toBe("");
  });

  it("states a shipping amount only with the pick it belongs to, in the store's currency", () => {
    const cost = (overrides: Partial<AssistantSettings>, facts: StoreFacts = FACTS) =>
      describeShippingPicks({ ...DEFAULT_SETTINGS, ...overrides }, facts).cost;

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


    // Nothing about delivery is among the policies. Where the store ships, how
    // soon orders leave and how long they take are Shopify's to say, through
    // the shipping tool: each pick is only what that tool falls back on.
    const picked = {
      ...DEFAULT_SETTINGS,
      shipsTo: "international" as const,
      processingTime: "3_5" as const,
      deliveryTime: "5_8" as const,
    };
    expect(describeQuickPolicies(picked)).toBe("");
    expect(describeShippingPicks(picked)).toEqual({
      area: "Shipping area: ships internationally.",
      dispatch: "Dispatch: orders usually ship within 3 to 5 business days.",
      deliveryTime: "Delivery: usually 5 to 8 business days after the order ships.",
    });
    expect(describeShippingPicks({ ...DEFAULT_SETTINGS, processingTime: "same_day" })).toEqual({
      dispatch: "Dispatch: orders usually ship the same business day.",
    });
    expect(describeShippingPicks(DEFAULT_SETTINGS)).toEqual({});
    // An assistant with no shipping tool to ask is told them as lines, in one order.
    expect(shippingPicksText(describeShippingPicks({ ...picked, shippingFee: "free" })).split("\n")).toEqual([
      "Shipping area: ships internationally.",
      "Shipping cost: free on every order.",
      "Dispatch: orders usually ship within 3 to 5 business days.",
      "Delivery: usually 5 to 8 business days after the order ships.",
    ]);
    expect(shippingPicksText({})).toBe("");
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
    expect(setupProgress({ ...DEFAULT_SETTINGS, exchanges: "yes" }).policies).toBe(true);
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
        policies: { refund: true, shipping: "yes", privacy: true, terms: true },
        // Once kept here, now read live each time: a stored copy is dropped.
        processingDays: 2,
        // Once kept only to be shown in a panel that is gone: dropped too.
        cards: ["VISA"],
        wallets: ["SHOPIFY_PAY"],
        products: 42,
        productsCapped: true,
        giftCards: true,
        admin: true,
      }),
    ).toEqual({
      syncedAt: "2026-11-26T10:00:00.000Z",
      description: "x".repeat(400),
      shipsTo: ["CA"],
      policies: { refund: true, shipping: false },
    });
    for (const nothing of [null, "facts", [], 5]) expect(cleanStoreFacts(nothing)).toEqual(NO_FACTS);
    expect(readStoreFacts("{not json")).toEqual(NO_FACTS);
    expect(readStoreFacts(undefined)).toEqual(NO_FACTS);
    expect(readStoreFacts(JSON.stringify(FACTS))).toEqual(FACTS);
  });

  it("names cards and wallets the way shoppers know them", () => {
    expect(
      paymentNames({
        cards: ["AMERICAN_EXPRESS", "SOME_NEW_CARD"],
        wallets: ["ANDROID_PAY", "GOOGLE_PAY"],
      }),
    ).toEqual({ cards: ["American Express", "Some New Card"], wallets: ["Google Pay"] });
    expect(paymentNames({})).toEqual({ cards: [], wallets: [] });
  });

  it("asks Shopify and stores the answer for the signed-in shop only", async () => {
    await saveSettings(SHOP_B, { assistantName: "Other" }, db);
    const admin = fakeGraphql(adminAnswer());
    const storefront = fakeGraphql(storefrontAnswer());
    const now = new Date("2026-11-26T10:00:00Z");

    const { facts, reached } = await syncStoreFacts(SHOP_A, { admin, storefront }, { db, now });
    expect(reached).toEqual({ admin: true, storefront: true });
    expect(facts).toEqual(FACTS);
    // One question for each of Shopify's two APIs.
    expect([admin.calls.length, storefront.calls.length]).toEqual([1, 1]);
    // Kept with the shop's settings, without touching the settings themselves.
    expect(await getStoredFacts(SHOP_A, db)).toEqual(FACTS);
    expect(await getSettings(SHOP_A, db)).toEqual(DEFAULT_SETTINGS);

    // How soon orders leave is not among the facts kept: it is read from
    // Shopify when a shopper asks, like everything else about delivery. A copy
    // stored by an earlier version is dropped when the facts are read.
    expect(admin.calls.map((call) => call.query).join()).not.toContain("deliveryPromiseSettings");
    await db.shopSettings.update({
      where: { shop: SHOP_A },
      data: { storeFacts: JSON.stringify({ ...FACTS, processingDays: 2 }) },
    });
    expect(await getStoredFacts(SHOP_A, db)).toEqual(FACTS);
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
      // From the Admin API, as last known.
      contactEmail: "hello@alpine.example",
      currencyCode: "CAD",
      shipsTo: ["CA"],
      // Half an answer is not a sync: the time of the last full one stands.
      syncedAt: "2026-11-26T10:00:00.000Z",
    });
    expect(partial.facts).not.toHaveProperty("description");

    // Half an answer must not count as fresh either, or the missing half
    // would go unasked for as long as facts are trusted. On another shop: a
    // full sync, then one the Storefront API missed...
    const full = { admin: fakeGraphql(adminAnswer()), storefront: fakeGraphql(storefrontAnswer()) };
    const synced = await syncStoreFacts(SHOP_B, full, {
      db,
      now: new Date("2026-11-27T10:00:10Z"),
      maxAgeMs: 60_000,
    });
    expect(synced.reached).toEqual({ admin: true, storefront: true });
    await syncStoreFacts(
      SHOP_B,
      { admin: fakeGraphql(adminAnswer()), storefront: fakeGraphql(new Error("offline")) },
      { db, now: new Date("2026-11-27T10:02:00Z") },
    );
    // ...and five seconds after that, well inside the minute a full sync is
    // trusted for, the next page load asks Shopify again.
    const afterHalf = { admin: fakeGraphql(adminAnswer()), storefront: fakeGraphql(storefrontAnswer()) };
    await syncStoreFacts(SHOP_B, afterHalf, { db, now: new Date("2026-11-27T10:02:05Z"), maxAgeMs: 60_000 });
    expect(afterHalf.storefront.calls).toHaveLength(1);

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

    // Facts that could not be read are never written over with half of them.
    await storeFacts(SHOP_A, FACTS);
    let written = 0;
    const unreadable = {
      shopSettings: {
        findUnique: async () => {
          throw new Error("database is locked");
        },
        upsert: async () => {
          written += 1;
        },
      },
    } as unknown as PrismaClient;
    await expect(
      syncStoreFacts(
        SHOP_A,
        { admin: fakeGraphql(adminAnswer()), storefront: fakeGraphql(new Error("offline")) },
        { db: unreadable },
      ),
    ).rejects.toThrow("database is locked");
    expect(written).toBe(0);
    expect(await getStoredFacts(SHOP_A, db)).toEqual(FACTS);

    const page = await syncStoreFactsForPage(
      SHOP_A,
      { admin: fakeGraphql(adminAnswer()), storefront: fakeGraphql(storefrontAnswer()) },
      { db: broken },
    );
    expect(page).toEqual({ facts: NO_FACTS, reached: { admin: false, storefront: false } });
  });

  it("reads the facts again once they are a few minutes old, and leaves a never-synced store alone", async () => {
    const clients = () => ({ admin: fakeGraphql(adminAnswer()), storefront: fakeGraphql(storefrontAnswer()) });
    const shop = "refresh-test.myshopify.com";
    const now = new Date("2026-11-28T12:00:00Z");

    // Never synced: the merchant opening the app does the first sync, not a chat.
    const untouched = clients();
    expect(refreshStoreFactsIfStale(shop, NO_FACTS, untouched, { db, now })).toBeNull();
    // Synced a few minutes ago: still good.
    expect(
      refreshStoreFactsIfStale(shop, { syncedAt: "2026-11-28T11:55:00.000Z" }, untouched, { db, now }),
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

  it("asks Shopify only for what something uses", async () => {
    const admin = fakeGraphql(adminAnswer());
    const storefront = fakeGraphql(storefrontAnswer());
    await syncStoreFacts(SHOP_A, { admin, storefront }, { db });
    const asked = [...admin.calls, ...storefront.calls].map((call) => call.query).join("\n");
    // Facts once read only to be listed in a panel are not read at all now.
    for (const gone of ["productsCount", "gift_card", "paymentSettings", "privacyPolicy", "termsOfService", "name"]) {
      expect(asked).not.toMatch(new RegExp(`\\b${gone}\\b`));
    }
    for (const kept of ["contactEmail", "currencyCode", "description", "shipsToCountries", "refundPolicy", "shippingPolicy"]) {
      expect(asked).toContain(kept);
    }
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

  it("adds the picks, the answers and the store's own description to the owner's notes", async () => {
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
      "Sizing: items run small. Suggest ordering one size up.",
      "Contact: shoppers can email the store at hello@alpine.example.",
      // The store's own description, since the merchant wrote none.
      "Small-batch snowboards, built in Canada.",
    ]) {
      expect(system).toContain(line);
    }
    // Notes come after the rules they cannot override.
    expect(system.indexOf("Rules:")).toBeLessThan(system.indexOf("Notes from the store owner"));
    // Fresh facts: nothing was asked of Shopify for this turn.
    expect(storefront.calls).toHaveLength(0);
  });

  it("is never told where the store delivers, what delivery costs or how to pay: it has to look", async () => {
    await saveSettings(
      SHOP_A,
      {
        // No description, so nothing the store wrote about itself is in the way.
        aboutStore: "none",
        shippingFee: "flat",
        shippingAmount: "4.99",
        shipsTo: "domestic",
        // A typed note that has fallen behind the store's settings.
        shippingInfo: "We also ship to Mexico. Shipping is 35 dollars.",
      },
      db,
    );
    await storeFacts(SHOP_A, { ...FACTS, syncedAt: new Date().toISOString() });

    const system = await turn();
    // Not from what was stored, and not from the merchant's own picks either.
    for (const stale of [
      "Canada",
      "United States",
      "Visa",
      "Mastercard",
      "Shop Pay",
      "4.99",
      "home country",
      "Mexico",
      "35 dollars",
    ]) {
      expect(system).not.toContain(stale);
    }
    expect(system).toMatch(
      /Delivery and payment: for anything about delivery .*, and how shoppers can pay, use your shipping and payment tools every time/,
    );
    expect(system).toContain("never answer these from memory or from earlier in this chat");
  });

  it("keeps the contact address and the description out unless the merchant chose them", async () => {
    await saveSettings(SHOP_A, { aboutStore: "none", topics: { contact: "page" } }, db);
    await storeFacts(SHOP_A, { ...FACTS, syncedAt: new Date().toISOString() });

    const system = await turn();
    expect(system).not.toContain("hello@alpine.example");
    expect(system).not.toContain("Small-batch snowboards");
    expect(system).toContain("Contact: shoppers can reach the store through the contact page");
  });

  it("adds no notes for a store that was never synced and has no picks", async () => {
    const system = await turn();
    expect(system).not.toContain("Notes from the store owner");
  });

  it("tells the merchant's own assistant none of it", async () => {
    await saveSettings(SHOP_A, { topics: { sizing: "small" } }, db);
    await storeFacts(SHOP_A, { ...FACTS, syncedAt: new Date().toISOString() });
    const system = await turn({ audience: "merchant" });
    expect(system).not.toContain("Delivery and payment");
    expect(system).not.toContain("Sizing");
  });

  it("reads the store's facts again before using ones that have gone stale", async () => {
    const shop = "stale-chat.myshopify.com";
    await saveSettings(shop, { topics: { contact: "email" } }, db);
    await storeFacts(shop, {
      syncedAt: "2026-01-01T00:00:00.000Z",
      contactEmail: "old@alpine.example",
      description: "An old description.",
    });
    const admin = fakeGraphql(adminAnswer());
    const storefront = fakeGraphql(storefrontAnswer());

    // The very turn that found them stale answers with Shopify's current ones.
    const system = await turn({ shop, admin, storefront });
    expect(system).toContain("shoppers can email the store at hello@alpine.example.");
    expect(system).toContain("Small-batch snowboards, built in Canada.");
    expect(system).not.toContain("old@alpine.example");
    expect((await getStoredFacts(shop, db)).contactEmail).toBe("hello@alpine.example");

    // And the next turn, a moment later, does not ask Shopify again.
    const quiet = fakeGraphql(storefrontAnswer());
    await turn({ shop, visitorId: "visitor-0002", storefront: quiet });
    expect(quiet.calls).toHaveLength(0);
  });

  it("goes ahead with what it has when Shopify cannot be reached for fresher facts", async () => {
    const shop = "stale-offline.myshopify.com";
    await saveSettings(shop, { topics: { contact: "email" } }, db);
    await storeFacts(shop, { syncedAt: "2026-01-01T00:00:00.000Z", contactEmail: "old@alpine.example" });

    const system = await turn({
      shop,
      admin: fakeGraphql(new Error("offline")),
      storefront: fakeGraphql(new Error("offline")),
    });
    expect(system).toContain("shoppers can email the store at old@alpine.example.");
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
        // A store that keeps its shipping in zones and has not yet approved the
        // permission to read its rates: Shopify's list of countries is shown.
        shipping: shippingForPage({ ...NO_SHIPPING_RATES, state: "no_access", model: "profiles" }),
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

    // All four parts are in the page; three are out of sight.
    expect(markup.match(/data-section="\w+"( hidden="")?/g)).toEqual([
      'data-section="assistant" hidden=""',
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
        entries: [],
        pending: false,
        ratings: true,
        blocked: null,
        onSend: () => {},
        onReset: () => {},
      }),
    );
    expect(markup).toContain("Ava");
    expect(markup).toContain(DEFAULT_SETTINGS.greeting);
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
    returnPolicy: "Waxed boards are exchange only.",
    topics: { sizing: "chart", hours: `${CUSTOM_PREFIX}Weekdays 10 to 4` },
  };

  it("start from the saved settings and would save exactly those", () => {
    for (const settings of [DEFAULT_SETTINGS, RICH]) {
      expect(resolveDraft(initialDraft(settings))).toEqual(settings);
    }
    // A preset is shown as that preset, the merchant's own words as "custom".
    expect(initialDraft(DEFAULT_SETTINGS).ui).toMatchObject({ greetingMode: "0", greetingText: "" });
    expect(initialDraft(RICH).ui).toMatchObject({
      greetingMode: "custom",
      greetingText: "Hey there, welcome to Alpine!",
      topicPick: expect.objectContaining({ sizing: "chart", hours: "custom", warranty: "" }),
      topicText: expect.objectContaining({ hours: "Weekdays 10 to 4" }),
    });
    // A text box is on show from the start only where something was written.
    expect(initialDraft(RICH).ui.open).toEqual({
      returnPolicy: true,
      shippingInfo: false,
      faq: false,
      instructions: false,
      addressForm: false,
    });
    expect(openBox(initialDraft(DEFAULT_SETTINGS), "faq").ui.open.faq).toBe(true);
    // The address form's options are on show from the start only where one of
    // them is no longer what Shopify's checkout starts with.
    for (const changed of [
      { orderFirstName: "required" as const },
      { orderCompany: "optional" as const },
      { orderAddress2: "hidden" as const },
    ]) {
      expect(initialDraft({ ...DEFAULT_SETTINGS, ...changed }).ui.open.addressForm).toBe(true);
    }
    expect(openBox(initialDraft(DEFAULT_SETTINGS), "addressForm").ui.open.addressForm).toBe(true);
  });

  it("work the color out from a swatch or the merchant's own", () => {
    // A swatch's color is shown as that swatch, any other as "custom".
    expect(initialDraft(DEFAULT_SETTINGS).ui).toMatchObject({
      accentMode: DEFAULT_ACCENT,
      accentText: DEFAULT_ACCENT,
    });
    // Stored in small letters by something older: still the same swatch.
    expect(initialDraft({ ...DEFAULT_SETTINGS, accentColor: "#be123c" }).ui.accentMode).toBe("#BE123C");
    const own = initialDraft({ ...DEFAULT_SETTINGS, accentColor: "#AB12CD" });
    expect(own.ui).toMatchObject({ accentMode: "custom", accentText: "#AB12CD" });
    expect(resolveDraft(own).accentColor).toBe("#AB12CD");

    let state = initialDraft(DEFAULT_SETTINGS);
    const apply = (input: ControlInput) => {
      state = applyInput(state, input);
    };
    // A swatch is a plain radio button: it reports its own value.
    apply(control("ui.accentMode", "input", { checked: true, value: "#2563EB" }));
    expect(resolveDraft(state).accentColor).toBe("#2563EB");
    // Custom starts from the color the store had, not from the swatch just left.
    apply(control("ui.accentMode", "input", { checked: true, value: "custom" }));
    expect(resolveDraft(state).accentColor).toBe(DEFAULT_ACCENT);
    apply(control("ui.accentText", "s-color-field", { value: " #0a0b0c " }));
    expect(resolveDraft(state).accentColor).toBe("#0A0B0C");
    // Not a color: handed on as it is, so the save is refused instead of
    // going through with a color nobody picked.
    apply(control("ui.accentText", "s-color-field", { value: "" }));
    expect(resolveDraft(state).accentColor).toBe("");
    apply(control("widgetPosition", "s-choice-list", { values: ["left"] }));
    expect(resolveDraft(state).widgetPosition).toBe("left");
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

    // Ticking a box off and on again is not a change, whatever order that leaves them in.
    let ticks = initialDraft({ ...DEFAULT_SETTINGS, returnConditions: ["unused", "tags"] });
    ticks = applyInput(ticks, control("returnConditions", "s-checkbox", { checked: false, value: "unused" }));
    ticks = applyInput(ticks, control("returnConditions", "s-checkbox", { checked: true, value: "unused" }));
    expect(resolveDraft(ticks).returnConditions).toEqual(["unused", "tags"]);

    // A control the page does not know changes nothing.
    const before = state;
    apply(control("shop", "s-text-field", { value: "victim.myshopify.com" }));
    apply(control("ui.somethingElse", "s-select", { value: "x" }));
    expect(state).toBe(before);
  });

  it("work out the welcome message and the answers from their controls", () => {
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

    // A control of a setting that no longer exists changes nothing.
    const before = resolveDraft(state);
    apply(control("ui.paymentNameMode", "s-select", { value: "custom" }));
    apply(control("ui.paymentNameText", "s-text-field", { value: "Pay the courier" }));
    expect(resolveDraft(state)).toEqual(before);
    expect(resolveDraft(state)).not.toHaveProperty("orderPaymentName");

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
      previewSuggestions({ ...DEFAULT_SETTINGS, orderLookupEnabled: true, allowReturns: true }),
    ).toEqual([
      "What are your best sellers?",
      "Add your best seller to my cart",
      "Where is my order?",
      "I want to return an item",
    ]);
    // Four at most, so a cancellation is suggested where returns are not.
    expect(previewSuggestions({ ...DEFAULT_SETTINGS, allowOrderCancel: true })).toEqual([
      "What are your best sellers?",
      "Add your best seller to my cart",
      "What is your return policy?",
      "Cancel my order",
    ]);
  });
});
