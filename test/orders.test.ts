import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  checkDelivery,
  deliverySchema,
  fieldErrors,
  listDeliveryCountries,
  openCheckout,
  OrderError,
  orderErrorResponse,
  orderFormOptions,
  parse,
  shippingAddressInput,
  type OrderDeps,
} from "../app/assistant/orders.server";
import { RateLimiter } from "../app/assistant/rate-limit";
import { DEFAULT_SETTINGS, saveSettings } from "../app/assistant/settings.server";
import type { GraphqlFn } from "../app/assistant/types";
import { createTestDb } from "./helpers/db";

const SHOP_A = "shop-a.myshopify.com";
const SHOP_B = "shop-b.myshopify.com";

let db: PrismaClient;
let cleanup: () => Promise<void>;
let deps: Partial<OrderDeps>;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});
afterAll(async () => {
  await cleanup();
});
beforeEach(async () => {
  await db.conversation.deleteMany();
  await db.shopSettings.deleteMany();
  // Shop A lets shoppers change an order's delivery address in the chat.
  await saveSettings(SHOP_A, { allowAddressChange: true }, db);
  deps = {
    db,
    rateLimiter: new RateLimiter(),
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

/** What the address form posts: who the order goes to and where. */
const details = (overrides: Record<string, unknown> = {}) => ({
  contact: { firstName: "Ada", lastName: "Lovelace", phone: "+1 (613) 555-0111", email: "" },
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

const OPTIONS = orderFormOptions(DEFAULT_SETTINGS);

/** The details as they are after both checks, or the error that refused them. */
const checked = (body: Record<string, unknown>, options = OPTIONS) =>
  checkDelivery(parse(deliverySchema, body), options);

const refused = (run: () => unknown) => {
  let error: unknown = null;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(OrderError);
  return error as OrderError;
};

const failure = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OrderError);
  return error as OrderError;
};

describe("what the address form sends", () => {
  it("is tidied into the shape Shopify takes", () => {
    const sent = shippingAddressInput(checked(details()));
    expect(sent).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      company: null,
      address1: "12 Analytical Way",
      address2: null,
      city: "Ottawa",
      zip: "K1A 0B1",
      countryCode: "CA",
      // Spaces, brackets and dashes are how people write a number, not part of it.
      phone: "+16135550111",
      // A short code is a code; Shopify matches it to the country's provinces.
      provinceCode: "ON",
    });
  });

  it("passes a province given by name through as a name", () => {
    const body = details({
      contact: { lastName: "Cher", phone: "03001234567", email: "" },
      address: { address1: "5 Sheikh Zayed Road", city: "Dubai", province: "Dubai", countryCode: "AE" },
    });
    const sent = shippingAddressInput(checked(body));
    expect(sent).toMatchObject({
      firstName: null,
      lastName: "Cher",
      company: null,
      province: "Dubai",
      zip: null,
      phone: "03001234567",
    });
    expect(sent).not.toHaveProperty("provinceCode");
  });

  it("is asked for what the country's address needs, in Shopify's words", () => {
    const at = (address: Record<string, string>) =>
      details({ address: { address1: "1 High Street", ...address } });

    // The United States: a city, a state and a ZIP code that looks like one.
    const blank = refused(() => checked(at({ countryCode: "US" })));
    expect(blank.code).toBe("invalid_order");
    expect(blank.status).toBe(422);
    expect(blank.extra.fields).toEqual({
      city: "Enter a city",
      province: "Select a state",
      zip: "Enter a ZIP code",
    });
    const wrongZip = refused(() =>
      checked(at({ countryCode: "US", city: "Springfield", province: "IL", zip: "K1A 0B1" })),
    );
    expect(wrongZip.extra.fields).toEqual({
      zip: "Enter a valid ZIP code for the United States, for example 90210",
    });

    // The United Kingdom has no counties to pick, and calls it a postcode.
    const uk = refused(() => checked(at({ countryCode: "GB", city: "London", zip: "12345" })));
    expect(uk.extra.fields).toEqual({
      zip: "Enter a valid postcode for the United Kingdom, for example SE22 8DL",
    });

    // Pakistan: no state to pick and a postal code is not needed. A state
    // sent anyway is not on that country's form, so it does not reach Shopify.
    const sent = shippingAddressInput(checked(at({ countryCode: "PK", city: "Lahore", province: "Punjab" })));
    expect(sent).toMatchObject({ city: "Lahore", zip: null });
    expect(sent).not.toHaveProperty("province");
    expect(sent).not.toHaveProperty("provinceCode");
  });

  it("follows the store's choices for first name, company and the second address line", () => {
    const strictStore = orderFormOptions({
      orderFirstName: "required",
      orderCompany: "required",
      orderAddress2: "hidden",
    });
    const strict = refused(() =>
      checked(details({ contact: { lastName: "Lovelace", phone: "+1 613 555 0111", email: "" } }), strictStore),
    );
    expect(strict.extra.fields).toEqual({
      firstName: "Enter a first name",
      company: "Enter a company",
    });

    const base = details();
    const sent = shippingAddressInput(
      checked({ ...base, address: { ...base.address, company: "Analytical Engines", address2: "Unit 4" } }, strictStore),
    );
    // The second line is not on this store's form, so it is not passed on.
    expect(sent).toMatchObject({ company: "Analytical Engines", address2: null });
  });

  it("names the fields that need fixing", () => {
    const error = refused(() =>
      checked(
        details({
          contact: { firstName: "x".repeat(41), lastName: "", phone: "12", email: "not-an-email" },
          address: { address1: "", city: "", company: "x".repeat(81), countryCode: "Canada" },
        }),
      ),
    );
    expect(error.code).toBe("invalid_order");
    expect(error.status).toBe(422);
    expect(Object.keys(error.extra.fields!).sort()).toEqual([
      "address1",
      "company",
      "countryCode",
      "email",
      "firstName",
      "lastName",
      "phone",
    ]);
  });

  it("refuses what is not a form at all, without blaming a field", () => {
    for (const odd of [null, "address", {}, { contact: "Ada", address: [] }]) {
      const error = refused(() => parse(deliverySchema, odd));
      expect(error.code).toBe("invalid_request");
      expect(error.status).toBe(400);
      expect(error.extra.fields).toBeUndefined();
    }
  });

  it("maps Shopify's own address errors back to the form", () => {
    expect(
      fieldErrors([
        { field: ["input", "shippingAddress", "zip"], message: "Zip is not valid" },
        { field: ["shippingAddress", "provinceCode"], message: "Province is not valid" },
        { field: ["shippingAddress", "zip"], message: "A second complaint about the same field" },
        { field: null, message: "Something about the whole order" },
        { field: ["somethingElse"], message: "Not a field of the form" },
      ]),
    ).toEqual({ zip: "Zip is not valid", province: "Province is not valid" });
  });
});

describe("checkout for the ticked items", () => {
  const SHOP_C = "shop-c.myshopify.com";
  const cartApi = (handler: Handler) => routedGraphql({ ShopiAssistCheckoutCart: handler });
  const created = (overrides: Record<string, unknown> = {}) => ({
    cartCreate: {
      cart: { checkoutUrl: "https://shop-c.example/cart/c/abc?key=1", totalQuantity: 3 },
      userErrors: [],
      ...overrides,
    },
  });
  const body = {
    step: "checkout",
    country: "ca",
    discountCodes: ["WELCOME"],
    items: [
      { variantId: "101", quantity: 2, properties: { Engraving: "Ada" } },
      { variantId: "103", quantity: 1, sellingPlanId: "77" },
    ],
  };
  const checkout = (
    store: ReturnType<typeof cartApi>,
    request: Record<string, unknown> = body,
    shop = SHOP_C,
  ) => openCheckout({ shop, body: request, ip: "203.0.113.9", storefront: store }, deps);

  it("makes a cart of its own for them, with nothing else switched on", async () => {
    const store = cartApi(() => created());
    expect(await checkout(store)).toEqual({
      ok: true,
      step: "checkout",
      checkoutUrl: "https://shop-c.example/cart/c/abc?key=1",
    });
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0].variables).toEqual({
      country: "CA",
      input: {
        lines: [
          {
            merchandiseId: "gid://shopify/ProductVariant/101",
            quantity: 2,
            attributes: [{ key: "Engraving", value: "Ada" }],
          },
          {
            merchandiseId: "gid://shopify/ProductVariant/103",
            quantity: 1,
            sellingPlanId: "gid://shopify/SellingPlan/77",
          },
        ],
        discountCodes: ["WELCOME"],
      },
    });
  });

  it("says so when Shopify will not make the cart, and never passes on a link that is not a checkout", async () => {
    const refusedCart = await failure(
      checkout(cartApi(() => created({ cart: null, userErrors: [{ code: "INVALID", field: null, message: "No" }] }))),
    );
    expect([refusedCart.code, refusedCart.status]).toEqual(["unavailable", 409]);

    const odd = cartApi(() => created({ cart: { checkoutUrl: "javascript:alert(1)", totalQuantity: 1 } }));
    expect((await failure(checkout(odd))).code).toBe("unavailable");

    const soldOut = cartApi(() => created({ cart: { checkoutUrl: "https://shop-c.example/cart/c/x", totalQuantity: 0 } }));
    expect((await failure(checkout(soldOut))).message).toMatch(/sold out/);

    const offline = cartApi(() => {
      throw new Error("offline");
    });
    expect((await failure(checkout(offline))).code).toBe("unavailable");
  });

  it("refuses a malformed request, and a store where the chat is paused", async () => {
    const store = cartApi(() => created());
    for (const items of [[], [{ variantId: "abc", quantity: 1 }], [{ variantId: "101", quantity: 0 }]]) {
      expect((await failure(checkout(store, { step: "checkout", items }))).code).toBe("invalid_request");
    }
    expect(store.calls).toHaveLength(0);

    await saveSettings(SHOP_C, { enabled: false }, db);
    expect((await failure(checkout(store))).code).toBe("disabled");
    expect(store.calls).toHaveLength(0);
  });

  it("is limited per visitor address", async () => {
    const store = cartApi(() => created());
    for (let attempt = 0; attempt < 30; attempt += 1) await checkout(store);
    const limited = await failure(checkout(store));
    expect([limited.code, limited.status]).toEqual(["rate_limited", 429]);
    expect(limited.extra.retryAfterSeconds).toBeGreaterThan(0);
    expect(store.calls).toHaveLength(30);
  });
});

describe("what the address form asks for", () => {
  const countries = (handler: Handler) => routedGraphql({ ShopiAssistDeliveryCountries: handler });

  it("is each country the store sells to, by name, with that country's own form", async () => {
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

    // Both countries have the same layout but name the state and the
    // postal code differently, so each gets its own form.
    expect(list.countries).toEqual([
      { code: "CA", name: "Canada", form: 0 },
      { code: "US", name: "United States", form: 1 },
    ]);
    const labels = list.forms.map((form) => form.map((row) => row.map((field) => field.label)));
    expect(labels).toEqual([
      [
        ["First name (optional)", "Last name"],
        ["Address"],
        ["Apartment, suite, etc (optional)"],
        ["City", "Province", "Postal code"],
        ["Phone"],
      ],
      [
        ["First name (optional)", "Last name"],
        ["Address"],
        ["Apartment, suite, etc (optional)"],
        ["City", "State", "ZIP code"],
        ["Phone"],
      ],
    ]);
    expect(list.forms[1].flat().filter((field) => !field.required).map((field) => field.name)).toEqual([
      "firstName",
      "address2",
    ]);
    expect(store.calls).toEqual([{ operation: "ShopiAssistDeliveryCountries", variables: { language: "FR" } }]);
    // Nothing about paying: that is the checkout's business, not this form's.
    expect(Object.keys(list).sort()).toEqual(["countries", "forms"]);
  });

  it("follows the store's own choices for the form", async () => {
    await saveSettings(SHOP_A, { orderFirstName: "required", orderCompany: "optional", orderAddress2: "hidden" }, db);
    const store = countries(() => ({
      localization: { availableCountries: [{ isoCode: "US", name: "United States" }] },
    }));
    const { forms } = await listDeliveryCountries({ shop: SHOP_A, storefront: store }, deps);
    const names = forms[0].flat().map((field) => field.name);
    expect(names).toContain("company");
    expect(names).not.toContain("address2");
    expect(forms[0].flat().find((field) => field.name === "firstName")?.required).toBe(true);
  });

  it("is an empty list when Shopify cannot be asked", async () => {
    const broken = countries(() => {
      throw new Error("offline");
    });
    expect(await listDeliveryCountries({ shop: SHOP_A, storefront: broken }, deps)).toEqual({
      countries: [],
      forms: [],
    });
  });

  it("is given only where shoppers may change an order's address in the chat", async () => {
    const store = countries(() => ({
      localization: { availableCountries: [{ isoCode: "US", name: "United States" }] },
    }));
    // Shop B has not switched address changes on. Checkout help alone is not enough.
    const off = await failure(listDeliveryCountries({ shop: SHOP_B, storefront: store }, deps));
    expect([off.code, off.status]).toEqual(["disabled", 403]);

    await saveSettings(SHOP_A, { enabled: false }, db);
    expect((await failure(listDeliveryCountries({ shop: SHOP_A, storefront: store }, deps))).code).toBe("disabled");
    expect(store.calls).toHaveLength(0);
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

    const limited = orderErrorResponse(new OrderError("rate_limited", 429, "Too many requests.", { retryAfterSeconds: 42 }));
    expect(limited.headers.get("Retry-After")).toBe("42");

    const unknown = orderErrorResponse(new Error("12 Analytical Way"));
    expect(unknown.status).toBe(500);
    expect(JSON.stringify(await unknown.json())).not.toContain("Analytical");
  });
});
