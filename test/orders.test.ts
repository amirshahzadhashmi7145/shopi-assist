import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  handleChatOrder,
  listDeliveryCountries,
  OrderError,
  orderErrorResponse,
  type ChatOrderDeps,
  type ChatOrderResult,
} from "../app/assistant/orders.server";
import { RateLimiter } from "../app/assistant/rate-limit";
import { saveSettings } from "../app/assistant/settings.server";
import { createConversation, knownOrders, recentMessages } from "../app/assistant/store.server";
import type { GraphqlFn } from "../app/assistant/types";
import { createTestDb } from "./helpers/db";

const SHOP_A = "shop-a.myshopify.com";
const SHOP_B = "shop-b.myshopify.com";

let db: PrismaClient;
let cleanup: () => Promise<void>;
let deps: Partial<ChatOrderDeps>;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});
afterAll(async () => {
  await cleanup();
});
beforeEach(async () => {
  await db.conversation.deleteMany();
  await db.shopSettings.deleteMany();
  await saveSettings(SHOP_A, { allowChatOrders: true }, db);
  deps = {
    db,
    rateLimiter: new RateLimiter(),
    placed: new Map(),
    isTestStore: async () => false,
    now: () => new Date("2026-11-19T12:00:00Z"),
  };
});

type Variables = Record<string, unknown> | undefined;
type Handler = (variables: Variables) => unknown;

/** A GraphQL function that answers by operation name and records every call. */
function routedGraphql(handlers: Record<string, Handler>) {
  const calls: Array<{ operation: string; variables: Variables }> = [];
  const fn = (async (query: string, variables?: Record<string, unknown>) => {
    const operation = /(?:query|mutation)\s+(\w+)/.exec(query)![1];
    calls.push({ operation, variables });
    const handler = handlers[operation];
    if (!handler) throw new Error(`unexpected operation ${operation}`);
    return handler(variables);
  }) as GraphqlFn & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

const usd = (amount: string) => ({ amount, currencyCode: "USD" });
const set = (amount: string) => ({ presentmentMoney: usd(amount) });

const RATES = [
  { handle: "express", title: "Express", price: usd("15.0") },
  { handle: "standard", title: "Standard", price: usd("5.0") },
];

/** What Shopify works out for two mugs at 18.00 with the given delivery option. */
const calculated = (variables: Variables, overrides: Record<string, unknown> = {}) => {
  const input = variables!.input as { shippingLine?: { shippingRateHandle: string } };
  const rate = RATES.find((candidate) => candidate.handle === input.shippingLine?.shippingRateHandle);
  const shipping = rate ? Number(rate.price.amount) : 0;
  return {
    draftOrderCalculate: {
      calculatedDraftOrder: {
        taxesIncluded: false,
        lineItems: [
          {
            title: "Trail Mug",
            variantTitle: "Default Title",
            quantity: 2,
            requiresShipping: true,
            discountedTotalSet: set("36.0"),
          },
        ],
        availableShippingRates: RATES,
        subtotalPriceSet: set("36.0"),
        totalShippingPriceSet: set(shipping.toFixed(1)),
        totalTaxSet: set("3.6"),
        totalPriceSet: set((39.6 + shipping).toFixed(1)),
        ...overrides,
      },
      userErrors: [],
    },
  };
};

const storefront = (nodes: unknown[] = [{ id: "gid://shopify/ProductVariant/101", availableForSale: true }]) =>
  routedGraphql({ ShopiAssistVariantsForOrder: () => ({ nodes }) });

const adminApi = (overrides: Record<string, Handler> = {}) =>
  routedGraphql({
    ShopiAssistDraftOrderCalculate: (variables) => calculated(variables),
    ShopiAssistPayOnDeliveryTerms: () => ({
      paymentTermsTemplates: [
        { id: "gid://shopify/PaymentTermsTemplate/9", paymentTermsType: "FULFILLMENT" },
      ],
    }),
    ShopiAssistDraftOrderCreate: () => ({
      draftOrderCreate: { draftOrder: { id: "gid://shopify/DraftOrder/1" }, userErrors: [] },
    }),
    ShopiAssistDraftOrderComplete: () => ({
      draftOrderComplete: {
        draftOrder: {
          order: { id: "gid://shopify/Order/1", name: "#1001", displayFinancialStatus: "PENDING" },
        },
        userErrors: [],
      },
    }),
    ShopiAssistDraftOrderDelete: () => ({
      draftOrderDelete: { deletedId: "gid://shopify/DraftOrder/1", userErrors: [] },
    }),
    ...overrides,
  });

const details = (overrides: Record<string, unknown> = {}) => ({
  items: [{ variantId: "101", quantity: 2 }],
  contact: { firstName: "Ada", lastName: "Lovelace", phone: "+1 (613) 555-0111", email: "ada@example.com" },
  address: {
    address1: "12 Analytical Way",
    address2: "",
    city: "Ottawa",
    province: "on",
    zip: "K1A 0B1",
    countryCode: "ca",
  },
  ...overrides,
});

const placeBody = (overrides: Record<string, unknown> = {}) => ({
  step: "place",
  ...details(),
  expectedTotal: usd("44.6"),
  idempotencyKey: "form-key-0000000001",
  ...overrides,
});

const order = (
  body: Record<string, unknown>,
  clients: { admin?: ReturnType<typeof adminApi>; storefront?: ReturnType<typeof storefront> } = {},
  shop = SHOP_A,
) => {
  const admin = clients.admin ?? adminApi();
  const store = clients.storefront ?? storefront();
  return {
    admin,
    storefront: store,
    result: handleChatOrder({ shop, body, ip: "203.0.113.7", admin, storefront: store }, deps),
  };
};

const failure = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OrderError);
  return error as OrderError;
};

describe("order quote", () => {
  it("prices the order with the cheapest delivery option and creates nothing", async () => {
    const { result, admin, storefront: store } = order({ step: "quote", ...details() });

    expect(await result).toEqual({
      ok: true,
      step: "quote",
      quote: {
        lines: [{ title: "Trail Mug", quantity: 2, total: usd("36.0") }],
        subtotal: usd("36.0"),
        shipping: usd("5.0"),
        tax: usd("3.6"),
        total: usd("44.6"),
        shippingRates: RATES,
        shippingRateHandle: "standard",
      },
    });

    // The catalog check runs first, priced for the delivery country.
    expect(store.calls[0].variables).toEqual({
      ids: ["gid://shopify/ProductVariant/101"],
      country: "CA",
    });
    // Only calculations: nothing was written to the store.
    expect(admin.calls.map((call) => call.operation)).toEqual([
      "ShopiAssistDraftOrderCalculate",
      "ShopiAssistDraftOrderCalculate",
    ]);
    expect(admin.calls[0].variables!.input).toEqual({
      lineItems: [{ variantId: "gid://shopify/ProductVariant/101", quantity: 2 }],
      shippingAddress: {
        firstName: "Ada",
        lastName: "Lovelace",
        address1: "12 Analytical Way",
        address2: null,
        city: "Ottawa",
        zip: "K1A 0B1",
        countryCode: "CA",
        phone: "+16135550111",
        provinceCode: "ON",
      },
      email: "ada@example.com",
    });
  });

  it("uses the delivery option the shopper picked", async () => {
    const { result } = order({ step: "quote", ...details(), shippingRateHandle: "express" });
    const quoted = (await result) as Extract<ChatOrderResult, { step: "quote" }>;

    expect(quoted.quote.shippingRateHandle).toBe("express");
    expect(quoted.quote.total).toEqual(usd("54.6"));
  });

  it("accepts delivery option handles as long as Shopify's real ones", async () => {
    // Real handles are signed tokens; 327 characters on the dev store.
    const handle = `eyJhbGciOiJIUzI1NiJ9.${"x".repeat(340)}`;
    const rates = [...RATES, { handle, title: "Courier", price: usd("9.0") }];
    const admin = adminApi({
      ShopiAssistDraftOrderCalculate: (variables) =>
        calculated(variables, { availableShippingRates: rates }),
    });
    const quoted = (await order({ step: "quote", ...details(), shippingRateHandle: handle }, { admin })
      .result) as Extract<ChatOrderResult, { step: "quote" }>;

    expect(quoted.quote.shippingRateHandle).toBe(handle);
    expect(admin.calls[1].variables!.input).toMatchObject({
      shippingLine: { shippingRateHandle: handle },
    });
  });

  it("leaves tax out when prices already include it", async () => {
    const admin = adminApi({
      ShopiAssistDraftOrderCalculate: (variables) => calculated(variables, { taxesIncluded: true }),
    });
    const quoted = (await order({ step: "quote", ...details() }, { admin }).result) as Extract<
      ChatOrderResult,
      { step: "quote" }
    >;
    expect(quoted.quote.tax).toBeNull();
  });

  it("passes a province name through as a name and leaves an empty email out", async () => {
    const body = details({
      contact: { lastName: "Cher", phone: "03001234567", email: "" },
      address: { address1: "5 Mall Road", city: "Lahore", province: "Punjab", countryCode: "PK" },
    });
    const { result, admin } = order({ step: "quote", ...body });
    await result;

    const input = admin.calls[0].variables!.input as Record<string, unknown>;
    expect(input.email).toBeUndefined();
    expect(input.shippingAddress).toMatchObject({
      firstName: null,
      lastName: "Cher",
      province: "Punjab",
      zip: null,
      phone: "03001234567",
    });
    expect(input.shippingAddress).not.toHaveProperty("provinceCode");
  });

  it("names the form fields that need fixing, without calling Shopify", async () => {
    const { result, admin, storefront: store } = order({
      step: "quote",
      ...details({
        contact: { firstName: "x".repeat(41), lastName: "", phone: "12", email: "not-an-email" },
        address: { address1: "", city: "", countryCode: "Canada" },
      }),
    });
    const error = await failure(result);

    expect(error.code).toBe("invalid_order");
    expect(error.status).toBe(422);
    expect(Object.keys(error.extra.fields!).sort()).toEqual([
      "address1",
      "city",
      "countryCode",
      "email",
      "firstName",
      "lastName",
      "phone",
    ]);
    expect(admin.calls).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
  });

  it("refuses a malformed cart", async () => {
    for (const items of [
      [],
      [{ variantId: "101; DROP", quantity: 1 }],
      [{ variantId: "101", quantity: 500 }],
      Array.from({ length: 11 }, (_, index) => ({ variantId: String(index + 1), quantity: 1 })),
    ]) {
      const error = await failure(order({ step: "quote", ...details({ items }) }).result);
      expect(error.code).toBe("invalid_request");
    }
  });

  it("refuses products the store has not published or has sold out", async () => {
    for (const nodes of [[null], [{ id: "gid://shopify/ProductVariant/101", availableForSale: false }]]) {
      const admin = adminApi();
      const error = await failure(
        order({ step: "quote", ...details() }, { admin, storefront: storefront(nodes) }).result,
      );
      expect(error.code).toBe("unavailable");
      // The Admin API, which can see unpublished products, is never asked.
      expect(admin.calls).toHaveLength(0);
    }
  });

  it("says so when the address cannot be delivered to", async () => {
    const admin = adminApi({
      ShopiAssistDraftOrderCalculate: (variables) =>
        calculated(variables, { availableShippingRates: [] }),
    });
    const error = await failure(order({ step: "quote", ...details() }, { admin }).result);
    expect(error.code).toBe("undeliverable");
    expect(error.message).toMatch(/can't deliver to that address/);
  });

  it("asks for the state and postal code before giving up on an address", async () => {
    // What Shopify does for an address without them: no options and no error.
    const admin = adminApi({
      ShopiAssistDraftOrderCalculate: (variables) =>
        calculated(variables, { availableShippingRates: [] }),
    });
    const address = { address1: "742 Evergreen Terrace", city: "Springfield", countryCode: "US" };

    const neither = await failure(order({ step: "quote", ...details({ address }) }, { admin }).result);
    expect(neither.code).toBe("invalid_order");
    expect(neither.message).toMatch(/a bit more of your address/);
    expect(Object.keys(neither.extra.fields!).sort()).toEqual(["province", "zip"]);

    const noZip = await failure(
      order({ step: "quote", ...details({ address: { ...address, province: "IL" } }) }, { admin }).result,
    );
    expect(noZip.extra.fields).toEqual({
      zip: "Add your postal code so delivery can be worked out.",
    });
  });

  it("maps Shopify's address errors back to the form", async () => {
    const admin = adminApi({
      ShopiAssistDraftOrderCalculate: () => ({
        draftOrderCalculate: {
          calculatedDraftOrder: null,
          userErrors: [{ field: ["input", "shippingAddress", "zip"], message: "Zip is not valid" }],
        },
      }),
    });
    const error = await failure(order({ step: "quote", ...details() }, { admin }).result);
    expect(error.code).toBe("invalid_order");
    expect(error.extra.fields).toEqual({ zip: "Zip is not valid" });
  });

  it("hides Shopify failures behind a generic message", async () => {
    const admin = adminApi({
      ShopiAssistDraftOrderCalculate: () => {
        throw new Error("Admin GraphQL error: 12 Analytical Way is invalid");
      },
    });
    const error = await failure(order({ step: "quote", ...details() }, { admin }).result);
    expect(error.code).toBe("order_failed");
    expect(error.message).not.toContain("Analytical");
  });
});

describe("placing an order", () => {
  it("creates an unpaid order through a draft order and returns its number", async () => {
    const { result, admin } = order(placeBody());

    expect(await result).toEqual({
      ok: true,
      step: "place",
      order: { name: "#1001", total: usd("44.6") },
    });
    expect(admin.calls.map((call) => call.operation)).toEqual([
      "ShopiAssistDraftOrderCalculate",
      "ShopiAssistDraftOrderCalculate",
      "ShopiAssistPayOnDeliveryTerms",
      "ShopiAssistDraftOrderCreate",
      "ShopiAssistDraftOrderComplete",
    ]);

    const created = admin.calls[3].variables!.input as Record<string, unknown>;
    expect(created).toMatchObject({
      lineItems: [{ variantId: "gid://shopify/ProductVariant/101", quantity: 2 }],
      shippingLine: { shippingRateHandle: "standard" },
      // Payment terms are what make the order unpaid instead of paid.
      paymentTerms: { paymentTermsTemplateId: "gid://shopify/PaymentTermsTemplate/9" },
      tags: ["shopi-assist", "chat-order", "pay-on-delivery"],
    });
    expect(created.note).toMatch(/paid on delivery/);
    // Prices are Shopify's: the browser never sends one for a line.
    expect(JSON.stringify(created.lineItems)).not.toMatch(/price/i);
    expect(admin.calls[4].variables).toEqual({ id: "gid://shopify/DraftOrder/1" });
  });

  it("refuses when the total is not the one the shopper saw", async () => {
    const { result, admin } = order(placeBody({ expectedTotal: usd("40.0") }));
    const error = await failure(result);

    expect(error.code).toBe("quote_changed");
    expect(error.status).toBe(409);
    expect(error.extra.quote!.total).toEqual(usd("44.6"));
    expect(admin.calls.map((call) => call.operation)).not.toContain("ShopiAssistDraftOrderCreate");
  });

  it("never completes an order without pay-on-delivery terms", async () => {
    const admin = adminApi({ ShopiAssistPayOnDeliveryTerms: () => ({ paymentTermsTemplates: [] }) });
    const error = await failure(order(placeBody(), { admin }).result);

    expect(error.code).toBe("order_failed");
    expect(error.message).toMatch(/Nothing was ordered/);
    expect(admin.calls.map((call) => call.operation)).not.toContain("ShopiAssistDraftOrderCreate");
  });

  it("removes the draft when it cannot be completed", async () => {
    const admin = adminApi({
      ShopiAssistDraftOrderComplete: () => ({
        draftOrderComplete: { draftOrder: null, userErrors: [{ field: null, message: "No stock" }] },
      }),
    });
    const error = await failure(order(placeBody(), { admin }).result);

    expect(error.code).toBe("order_failed");
    expect(admin.calls.at(-1)).toEqual({
      operation: "ShopiAssistDraftOrderDelete",
      variables: { input: { id: "gid://shopify/DraftOrder/1" } },
    });
  });

  it("returns the same order when the same request is sent again", async () => {
    const admin = adminApi();
    const first = await order(placeBody(), { admin }).result;
    const again = await order(placeBody(), { admin }).result;

    expect(again).toEqual(first);
    expect(admin.calls.filter((call) => call.operation === "ShopiAssistDraftOrderCreate")).toHaveLength(1);

    // A different shop with the same key is a different order.
    await saveSettings(SHOP_B, { allowChatOrders: true }, db);
    await order(placeBody(), { admin }, SHOP_B).result;
    expect(admin.calls.filter((call) => call.operation === "ShopiAssistDraftOrderCreate")).toHaveLength(2);
  });

  it("lets the shopper try again after a failed attempt", async () => {
    let fail = true;
    const admin = adminApi({
      ShopiAssistDraftOrderCreate: () => {
        if (fail) throw new Error("temporary");
        return { draftOrderCreate: { draftOrder: { id: "gid://shopify/DraftOrder/1" }, userErrors: [] } };
      },
    });
    await failure(order(placeBody(), { admin }).result);
    fail = false;

    expect(await order(placeBody(), { admin }).result).toMatchObject({ order: { name: "#1001" } });
  });

  it("limits orders per phone number, whatever the address or formatting", async () => {
    const attempt = (index: number, phone: string) =>
      handleChatOrder(
        {
          shop: SHOP_A,
          body: placeBody({
            idempotencyKey: `form-key-00000000${index}0`,
            contact: { firstName: "Ada", lastName: "Lovelace", phone, email: "" },
          }),
          ip: `203.0.113.${index}`,
          admin: adminApi(),
          storefront: storefront(),
        },
        deps,
      );

    await attempt(1, "+16135550111");
    await attempt(2, "+1 613 555 0111");
    await attempt(3, "+1 (613) 555-0111");
    const error = await failure(attempt(4, "+1-613-555-0111"));

    expect(error.code).toBe("rate_limited");
    expect(error.status).toBe(429);
    expect(error.extra.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("loosens the limits and tags the order on a development store", async () => {
    deps.isTestStore = async () => true;
    const admin = adminApi();
    const attempt = (index: number) =>
      handleChatOrder(
        {
          shop: SHOP_A,
          body: placeBody({ idempotencyKey: `form-key-0000000${String(index).padStart(2, "0")}0` }),
          ip: "203.0.113.7",
          admin,
          storefront: storefront(),
        },
        deps,
      );

    // The same tester, phone and office, well past the limits of a real store.
    for (let index = 0; index < 12; index += 1) await attempt(index);

    const created = admin.calls.filter((call) => call.operation === "ShopiAssistDraftOrderCreate");
    expect(created).toHaveLength(12);
    expect((created[0].variables!.input as { tags: string[] }).tags).toContain("shopi-assist-test");
  });

  it("does not tag real orders as tests", async () => {
    const { result, admin } = order(placeBody());
    await result;
    const created = admin.calls.find((call) => call.operation === "ShopiAssistDraftOrderCreate")!;
    expect((created.variables!.input as { tags: string[] }).tags).not.toContain("shopi-assist-test");
  });

  it("tells the chat it was placed from, without any personal details", async () => {
    const key = { shop: SHOP_A, audience: "shopper" as const, visitorId: "visitor-0001" };
    const conversation = await createConversation(db, key);

    await order(placeBody({ visitorId: "visitor-0001", conversationId: conversation.id })).result;

    expect(await knownOrders(db, SHOP_A, conversation.id)).toEqual([
      { id: "gid://shopify/Order/1", name: "#1001", source: "placed" },
    ]);
    const messages = await recentMessages(db, SHOP_A, conversation.id, 10);
    expect(messages).toEqual([
      { role: "user", content: "(I placed an order using the order form in this chat.)" },
      {
        role: "assistant",
        content:
          "Order #1001 is placed, to be paid on delivery. Items: 2 x Trail Mug. Delivery: Standard. Total: 44.6 USD.",
      },
    ]);
    // What the assistant and the merchant's transcript get: the order, not the person.
    expect(JSON.stringify(messages)).not.toMatch(/Lovelace|Analytical|Ottawa|613|ada@/);
  });

  it("tells no chat when the conversation is not this visitor's or this shop's", async () => {
    // Four orders from one phone number: past a real store's limit, so run as a test store.
    deps.isTestStore = async () => true;
    const mine = await createConversation(db, {
      shop: SHOP_A,
      audience: "shopper",
      visitorId: "visitor-0001",
    });
    await saveSettings(SHOP_B, { allowChatOrders: true }, db);
    const elsewhere = await createConversation(db, {
      shop: SHOP_B,
      audience: "shopper",
      visitorId: "visitor-0001",
    });

    for (const [index, ids] of [
      { visitorId: "visitor-9999", conversationId: mine.id },
      { visitorId: "visitor-0001", conversationId: elsewhere.id },
      { visitorId: "visitor-0001" },
      {},
    ].entries()) {
      const placed = await order(
        placeBody({ ...ids, idempotencyKey: `form-key-00000000${index}9` }),
      ).result;
      // The order itself always goes through.
      expect(placed).toMatchObject({ ok: true, order: { name: "#1001" } });
    }

    expect(await knownOrders(db, SHOP_A, mine.id)).toEqual([]);
    expect(await knownOrders(db, SHOP_B, elsewhere.id)).toEqual([]);
    expect(await recentMessages(db, SHOP_A, mine.id, 10)).toEqual([]);
  });

  it("rejects malformed chat ids instead of guessing", async () => {
    const error = await failure(
      order(placeBody({ visitorId: "v", conversationId: "DROP TABLE" })).result,
    );
    expect(error.code).toBe("invalid_request");
  });

  it("requires a well-formed total and retry key", async () => {
    for (const body of [
      placeBody({ idempotencyKey: "short" }),
      placeBody({ expectedTotal: { amount: "free", currencyCode: "USD" } }),
      placeBody({ expectedTotal: undefined }),
    ]) {
      expect((await failure(order(body).result)).code).toBe("invalid_request");
    }
  });
});

describe("who may order", () => {
  it("is off until the merchant switches it on, and needs checkout help on too", async () => {
    const off = await failure(order({ step: "quote", ...details() }, {}, SHOP_B).result);
    expect(off.code).toBe("disabled");
    expect(off.status).toBe(403);

    await saveSettings(SHOP_A, { allowCheckout: false }, db);
    expect((await failure(order(placeBody()).result)).code).toBe("disabled");

    await saveSettings(SHOP_A, { allowCheckout: true, enabled: false }, db);
    expect((await failure(order(placeBody()).result)).code).toBe("disabled");
  });

  it("refuses an unknown step", async () => {
    expect((await failure(order({ step: "refund", ...details() }).result)).code).toBe("invalid_request");
  });
});

describe("delivery countries", () => {
  const countries = (handler: Handler) =>
    routedGraphql({ ShopiAssistDeliveryCountries: handler });

  it("lists the countries the store sells to, by name", async () => {
    const store = countries(() => ({
      localization: {
        availableCountries: [
          { isoCode: "US", name: "United States" },
          { isoCode: "CA", name: "Canada" },
          { isoCode: "bad", name: "Nowhere" },
        ],
      },
    }));
    const list = await listDeliveryCountries(
      { shop: SHOP_A, language: "fr", storefront: store },
      deps,
    );

    expect(list).toEqual([
      { code: "CA", name: "Canada" },
      { code: "US", name: "United States" },
    ]);
    expect(store.calls[0].variables).toEqual({ language: "FR" });
  });

  it("returns an empty list when Shopify cannot be asked, and nothing when switched off", async () => {
    const broken = countries(() => {
      throw new Error("offline");
    });
    expect(await listDeliveryCountries({ shop: SHOP_A, storefront: broken }, deps)).toEqual([]);

    const error = await failure(
      listDeliveryCountries({ shop: SHOP_B, storefront: broken }, deps),
    );
    expect(error.code).toBe("disabled");
  });
});

describe("helpers", () => {
  it("turns errors into responses the widget can show", async () => {
    const response = orderErrorResponse(
      new OrderError("invalid_order", 422, "Please check the highlighted details.", {
        fields: { phone: "Enter a phone number with 7 to 15 digits." },
      }),
    );
    expect(response.status).toBe(422);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_order",
        message: "Please check the highlighted details.",
        fields: { phone: "Enter a phone number with 7 to 15 digits." },
      },
    });

    const unknown = orderErrorResponse(new Error("12 Analytical Way"));
    expect(unknown.status).toBe(500);
    expect(JSON.stringify(await unknown.json())).not.toContain("Analytical");
  });
});
