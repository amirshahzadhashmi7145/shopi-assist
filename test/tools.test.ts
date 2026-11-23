import { describe, expect, it } from "vitest";

import { allTools, merchantTools, shopperTools } from "../app/assistant/tools";
import {
  executeToolCall,
  toLlmToolSpecs,
  toolsFor,
} from "../app/assistant/tools/registry";
import { shopifyqlRows } from "../app/assistant/tools/merchant";
import { htmlToText, numericId, samePhone } from "../app/assistant/tools/shopper";
import { RateLimiter } from "../app/assistant/rate-limit";
import { fakeGraphql, storefrontProduct, toolContext } from "./helpers/fakes";

const SHOPPER_DEFAULTS = {
  orderLookupEnabled: false,
  allowAddToCart: true,
  allowCheckout: true,
  allowReturns: false,
};

const call = (name: string, args: Record<string, unknown> = {}) => ({
  id: "c1",
  name,
  arguments: JSON.stringify(args),
});

const run = async (
  name: string,
  args: Record<string, unknown>,
  context: ReturnType<typeof toolContext>,
) => {
  const execution = await executeToolCall(toolsFor(allTools, context), call(name, args), context);
  return { ...execution, json: JSON.parse(execution.content) };
};

describe("audience boundary", () => {
  it("never offers merchant tools to shoppers, even with an admin client present", () => {
    const context = toolContext({
      audience: "shopper",
      admin: fakeGraphql({}),
      storefront: fakeGraphql({}),
      settings: { ...SHOPPER_DEFAULTS, orderLookupEnabled: true },
    });
    const names = toolsFor(allTools, context).map((tool) => tool.name);

    for (const tool of merchantTools) expect(names).not.toContain(tool.name);
    expect(names).toEqual(
      expect.arrayContaining(["search_products", "get_best_sellers", "get_order_status"]),
    );
  });

  it("never offers shopper tools to the merchant assistant", () => {
    const context = toolContext({ audience: "merchant", admin: fakeGraphql({}) });
    const names = toolsFor(allTools, context).map((tool) => tool.name);

    for (const tool of shopperTools) expect(names).not.toContain(tool.name);
    expect(names).toContain("get_top_selling_products");
  });

  it("refuses a merchant tool call that arrives on a shopper turn", async () => {
    const admin = fakeGraphql({ shopifyqlQuery: { tableData: null, parseErrors: [] } });
    const context = toolContext({ audience: "shopper", admin, storefront: fakeGraphql({}) });

    const result = await run("get_top_selling_products", {}, context);

    expect(result.ok).toBe(false);
    expect(result.json.error).toMatch(/Unknown tool/);
    expect(admin.calls).toHaveLength(0);
  });

  it("every tool declares at least one audience and a JSON-schema object", () => {
    const specs = toLlmToolSpecs(allTools);
    expect(new Set(specs.map((spec) => spec.name)).size).toBe(allTools.length);
    for (const tool of allTools) expect(tool.audiences.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(spec.parameters.type).toBe("object");
      expect(spec.parameters).not.toHaveProperty("$schema");
      expect(spec.description.length).toBeGreaterThan(20);
    }
  });

  it("marks defaulted arguments as optional for the model", () => {
    const spec = toLlmToolSpecs(allTools).find((s) => s.name === "search_products")!;
    expect(spec.parameters.required).toEqual(["query"]);
  });
});

describe("shopper tools", () => {
  it("get_best_sellers sorts by best selling and returns cards", async () => {
    const storefront = fakeGraphql({
      products: {
        nodes: [
          storefrontProduct(),
          // What a password-protected store returns: published, but no URL.
          storefrontProduct({
            id: "gid://shopify/Product/2",
            title: "Camp Kettle",
            handle: "camp-kettle",
            onlineStoreUrl: null,
          }),
          // A malformed node (for example a non-product search hit) is skipped.
          {},
        ],
      },
    });
    const context = toolContext({ storefront, buyer: { country: "CA", language: "FR" } });

    const result = await run("get_best_sellers", { limit: 4 }, context);

    expect(result.ok).toBe(true);
    expect(storefront.calls[0].query).toContain("sortKey: BEST_SELLING");
    expect(storefront.calls[0].variables).toEqual({ first: 4, country: "CA", language: "FR" });
    expect(result.json.count).toBe(2);
    expect(result.json.products).toEqual([
      expect.objectContaining({ title: "Trail Mug", price: "18.0 USD", inStock: true }),
      expect.objectContaining({ title: "Camp Kettle" }),
    ]);
    expect(result.cards).toEqual([
      expect.objectContaining({
        handle: "trail-mug",
        variantId: "101",
        compareAtPrice: null,
        url: "https://test-shop.example/products/trail-mug",
      }),
      // No URL from Shopify: link by handle, relative to the storefront.
      expect.objectContaining({ handle: "camp-kettle", url: "/products/camp-kettle" }),
    ]);
  });

  it("only offers one-click add to cart for single-variant products", async () => {
    const storefront = fakeGraphql({
      search: {
        nodes: [
          storefrontProduct({
            priceRange: {
              minVariantPrice: { amount: "18.0", currencyCode: "USD" },
              maxVariantPrice: { amount: "24.0", currencyCode: "USD" },
            },
            compareAtPriceRange: { maxVariantPrice: { amount: "30.0", currencyCode: "USD" } },
            variants: {
              nodes: [
                { id: "gid://shopify/ProductVariant/101", availableForSale: true },
                { id: "gid://shopify/ProductVariant/102", availableForSale: true },
              ],
            },
          }),
        ],
      },
    });

    const result = await run("search_products", { query: "mug" }, toolContext({ storefront }));

    expect(result.json.products[0].price).toBe("from 18.0 USD");
    expect(result.cards[0].variantId).toBeNull();
    expect(result.cards[0].compareAtPrice).toEqual({ amount: "30.0", currencyCode: "USD" });
  });

  it("gives a product's versions to the model and to its card", async () => {
    const variant = (id: number, title: string, amount: string, availableForSale = true) => ({
      id: `gid://shopify/ProductVariant/${id}`,
      title,
      availableForSale,
      price: { amount, currencyCode: "USD" },
    });
    const search = (nodes: unknown[]) =>
      run(
        "search_products",
        { query: "wax" },
        toolContext({
          storefront: fakeGraphql({
            search: { nodes: [storefrontProduct({ variants: { nodes } })] },
          }),
        }),
      );

    const few = await search([
      variant(201, "Regular", "24.95"),
      variant(202, "Special", "49.95", false),
      variant(203, "Sample", "9.95"),
    ]);
    expect(few.json.products[0].versions).toEqual([
      "Regular: 24.95 USD",
      "Special: 49.95 USD (sold out)",
      "Sample: 9.95 USD",
    ]);
    expect(few.cards[0].variantId).toBeNull();
    expect(few.cards[0].variants).toEqual([
      { id: "201", title: "Regular", price: { amount: "24.95", currencyCode: "USD" }, available: true },
      { id: "202", title: "Special", price: { amount: "49.95", currencyCode: "USD" }, available: false },
      { id: "203", title: "Sample", price: { amount: "9.95", currencyCode: "USD" }, available: true },
    ]);

    // One version is nothing to choose between.
    const one = await search([variant(201, "Default Title", "24.95")]);
    expect(one.json.products[0].versions).toBeUndefined();
    expect(one.cards[0].variants).toBeUndefined();
    expect(one.cards[0].variantId).toBe("201");

    // More than a card can show: the product page takes over.
    const many = await search(
      Array.from({ length: 13 }, (_, index) => variant(300 + index, `Size ${index}`, "24.95")),
    );
    expect(many.json.products[0].versions).toBeUndefined();
    expect(many.cards[0].variants).toBeUndefined();
    expect(many.cards[0].variantId).toBeNull();
  });

  it("get_products_by_price asks Shopify to do the sorting", async () => {
    const products = [
      storefrontProduct({ title: "Budget Board", handle: "budget-board" }),
      storefrontProduct({ title: "Trail Mug" }),
    ];

    // Whole catalog, cheapest first.
    const all = fakeGraphql({ products: { nodes: products } });
    const cheapest = await run(
      "get_products_by_price",
      {},
      toolContext({ storefront: all, buyer: { country: "US" } }),
    );
    expect(all.calls[0].query).toMatch(/sortKey: PRICE/);
    expect(all.calls[0].query).toMatch(/available_for_sale:true/);
    expect(all.calls[0].variables).toMatchObject({ first: 5, reverse: false, country: "US" });
    expect(cheapest.json.rankedBy).toBe("price, lowest first");
    expect(cheapest.json.products.map((product: { title: string }) => product.title)).toEqual([
      "Budget Board",
      "Trail Mug",
    ]);
    expect(cheapest.cards).toHaveLength(2);

    // Most expensive of a kind.
    const search = fakeGraphql({ search: { nodes: products } });
    const dearest = await run(
      "get_products_by_price",
      { order: "highest_first", query: "snowboard", limit: 3 },
      toolContext({ storefront: search }),
    );
    expect(search.calls[0].query).toMatch(/search\(/);
    expect(search.calls[0].variables).toMatchObject({ query: "snowboard", first: 3, reverse: true });
    expect(dearest.json.rankedBy).toBe("price, highest first");

    // Within a collection.
    const collection = fakeGraphql({ collection: { title: "Winter", products: { nodes: products } } });
    const inCollection = await run(
      "get_products_by_price",
      { collectionHandle: "winter" },
      toolContext({ storefront: collection }),
    );
    expect(collection.calls[0].variables).toMatchObject({ handle: "winter", reverse: false });
    expect(inCollection.json.collection).toBe("Winter");

    const missing = await run(
      "get_products_by_price",
      { collectionHandle: "nope" },
      toolContext({ storefront: fakeGraphql({ collection: null }) }),
    );
    expect(missing.json.error).toMatch(/No collection/);
  });

  it("get_product_details does not present a product without options as having sizes", async () => {
    const details = (variants: Array<Record<string, unknown>>, options: unknown[]) =>
      fakeGraphql({
        product: {
          ...storefrontProduct(),
          fullDescription: "A mug.",
          tags: [],
          options,
          allVariants: { nodes: variants },
        },
      });
    const variant = (id: string, title: string) => ({
      id: `gid://shopify/ProductVariant/${id}`,
      title,
      availableForSale: true,
      price: { amount: "18.0", currencyCode: "USD" },
      compareAtPrice: null,
      selectedOptions: [],
    });

    const single = await run(
      "get_product_details",
      { handle: "trail-mug" },
      toolContext({
        storefront: details(
          [variant("101", "Default Title")],
          [{ name: "Title", optionValues: [{ name: "Default Title" }] }],
        ),
      }),
    );
    expect(single.json.options).toBeUndefined();
    expect(single.json.choices).toMatch(/one version only/);
    expect(single.json.variants).toEqual([{ variantId: "101", price: "18.0 USD", inStock: true }]);
    expect(single.content).not.toContain("Default Title");

    const sized = await run(
      "get_product_details",
      { handle: "trail-mug" },
      toolContext({
        storefront: details(
          [variant("101", "Small"), variant("102", "Large")],
          [{ name: "Size", optionValues: [{ name: "Small" }, { name: "Large" }] }],
        ),
      }),
    );
    expect(sized.json.choices).toBeUndefined();
    expect(sized.json.options).toEqual([{ name: "Size", values: ["Small", "Large"] }]);
    expect(sized.json.variants.map((entry: { title: string }) => entry.title)).toEqual(["Small", "Large"]);
  });

  it("add_to_cart verifies the variant before telling the widget to add it", async () => {
    const storefront = fakeGraphql({
      node: {
        id: "gid://shopify/ProductVariant/101",
        title: "Default Title",
        availableForSale: true,
        product: { title: "Trail Mug" },
      },
    });

    const result = await run(
      "add_to_cart",
      { variantId: "101", quantity: 2 },
      toolContext({ storefront }),
    );

    expect(storefront.calls[0].variables).toEqual({ id: "gid://shopify/ProductVariant/101" });
    expect(result.actions).toEqual([
      { type: "add_to_cart", variantId: "101", quantity: 2, title: "Trail Mug" },
    ]);
  });

  it("add_to_cart rejects made-up and sold-out variants", async () => {
    const missing = await run(
      "add_to_cart",
      { variantId: "999" },
      toolContext({ storefront: fakeGraphql({ node: null }) }),
    );
    expect(missing.ok).toBe(false);
    expect(missing.actions).toEqual([]);

    const soldOut = await run(
      "add_to_cart",
      { variantId: "101" },
      toolContext({
        storefront: fakeGraphql({
          node: {
            id: "x",
            title: "Small",
            availableForSale: false,
            product: { title: "Trail Mug" },
          },
        }),
      }),
    );
    expect(soldOut.json.error).toMatch(/out of stock/);

    const malformed = await run(
      "add_to_cart",
      { variantId: "101; DROP" },
      toolContext({ storefront: fakeGraphql({}) }),
    );
    expect(malformed.json.error).toMatch(/Invalid arguments/);
  });

  it("get_store_policy returns plain text and handles unpublished policies", async () => {
    const storefront = fakeGraphql({
      shop: {
        name: "Test",
        shippingPolicy: null,
        refundPolicy: {
          title: "Refund policy",
          url: "https://shop.example/policies/refund-policy",
          body: "<p>Returns within <strong>30 days</strong>.</p><script>alert(1)</script>",
        },
        privacyPolicy: null,
        termsOfService: null,
      },
    });
    const context = toolContext({ storefront });

    const refund = await run("get_store_policy", { policy: "refund" }, context);
    expect(refund.json.text).toBe("Returns within 30 days.");
    expect(refund.json.text).not.toContain("alert");

    const shipping = await run("get_store_policy", { policy: "shipping" }, context);
    expect(shipping.json.published).toBe(false);
  });

  it("hides failures behind a generic message", async () => {
    const storefront = fakeGraphql(new Error("Storefront GraphQL error: token abc123 invalid"));
    const result = await run("search_products", { query: "mug" }, toolContext({ storefront }));

    expect(result.ok).toBe(false);
    expect(result.content).not.toContain("abc123");
  });
});

describe("get_order_status", () => {
  const order = {
    name: "#1001",
    email: "Buyer@Example.com",
    processedAt: "2026-11-10T09:00:00Z",
    cancelledAt: null,
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    fulfillments: [
      {
        status: "SUCCESS",
        estimatedDeliveryAt: null,
        trackingInfo: [{ company: "UPS", number: "1Z999", url: "https://ups.example/1Z999" }],
      },
    ],
  };
  const enabled = (admin: ReturnType<typeof fakeGraphql>) =>
    toolContext({
      admin,
      storefront: fakeGraphql({}),
      settings: { ...SHOPPER_DEFAULTS, orderLookupEnabled: true },
      buyer: { ip: "203.0.113.7" },
    });

  it("is not available unless the merchant turned it on", async () => {
    const admin = fakeGraphql({ orders: { nodes: [order] } });
    const context = toolContext({ admin, storefront: fakeGraphql({}) });

    const result = await run(
      "get_order_status",
      { orderNumber: "1001", email: "buyer@example.com" },
      context,
    );

    expect(result.json.error).toMatch(/Unknown tool/);
    expect(admin.calls).toHaveLength(0);
  });

  it("returns status and tracking when number and email both match", async () => {
    const admin = fakeGraphql({ orders: { nodes: [order] } });

    const result = await run(
      "get_order_status",
      { orderNumber: "#1001", email: "buyer@example.com" },
      enabled(admin),
    );

    expect(admin.calls[0].variables).toEqual({ query: "name:1001" });
    expect(result.json).toMatchObject({
      order: "#1001",
      placedOn: "2026-11-10",
      fulfillmentStatus: "FULFILLED",
      shipments: [{ tracking: [{ carrier: "UPS", number: "1Z999" }] }],
    });
    // The email is used for matching only and never echoed back.
    expect(result.content.toLowerCase()).not.toContain("buyer@example.com");
  });

  it("needs no email for an order the server already tied to this chat", async () => {
    const mine = { ...order, id: "gid://shopify/Order/1005", name: "#1005", email: null };
    const admin = fakeGraphql({ orders: { nodes: [mine] } });
    const context = {
      ...enabled(admin),
      knownOrders: [{ id: "gid://shopify/Order/1005", name: "#1005", source: "placed" as const }],
    };

    const result = await run("get_order_status", { orderNumber: "1005" }, context);
    expect(result.json).toMatchObject({ order: "#1005", fulfillmentStatus: "FULFILLED" });

    // The model sending an empty email means the same as leaving it out.
    const blank = await run("get_order_status", { orderNumber: "#1005", email: "" }, context);
    expect(blank.ok).toBe(true);
  });

  it("still asks for the email for any other order, and matches known orders by id", async () => {
    const admin = fakeGraphql({ orders: { nodes: [{ ...order, id: "gid://shopify/Order/1001" }] } });
    const context = {
      ...enabled(admin),
      knownOrders: [{ id: "gid://shopify/Order/1005", name: "#1005", source: "placed" as const }],
    };

    const other = await run("get_order_status", { orderNumber: "1001" }, context);
    expect(other.json.error).toMatch(/email address or the phone number used on the order is needed too/);
    // Nothing was looked up, so nothing about order 1001 leaked.
    expect(admin.calls).toHaveLength(0);

    // A known name whose id no longer matches what Shopify returns is refused.
    const renamed = await run(
      "get_order_status",
      { orderNumber: "1005" },
      {
        ...enabled(fakeGraphql({ orders: { nodes: [{ ...order, id: "gid://shopify/Order/9", name: "#1005" }] } })),
        knownOrders: [{ id: "gid://shopify/Order/1005", name: "#1005", source: "verified" as const }],
      },
    );
    expect(renamed.json.error).toMatch(/No order matches/);
  });

  it("remembers an order once the shopper has proved it is theirs", async () => {
    const remembered: Array<{ id: string; name: string }> = [];
    const admin = fakeGraphql({ orders: { nodes: [{ ...order, id: "gid://shopify/Order/1001" }] } });
    const context = {
      ...enabled(admin),
      rememberOrder: async (found: { id: string; name: string }) => {
        remembered.push(found);
      },
    };

    await run("get_order_status", { orderNumber: "1001", email: "someone@else.com" }, context);
    expect(remembered).toEqual([]);

    await run("get_order_status", { orderNumber: "1001", email: "buyer@example.com" }, context);
    expect(remembered).toEqual([{ id: "gid://shopify/Order/1001", name: "#1001" }]);
  });

  it("accepts the phone number on the order as proof, for shoppers with no email", async () => {
    const remembered: string[] = [];
    const cod = {
      ...order,
      id: "gid://shopify/Order/1005",
      name: "#1005",
      email: null,
      phone: null,
      shippingAddress: { phone: "03198754964" },
    };
    const lookup = (phone: string) => {
      const admin = fakeGraphql({ orders: { nodes: [cod] } });
      const context = {
        ...enabled(admin),
        rememberOrder: async (found: { name: string }) => {
          remembered.push(found.name);
        },
      };
      return run("get_order_status", { orderNumber: "1005", phone }, context).then((result) => ({
        result,
        admin,
      }));
    };

    // Written the local way, with spaces, or with the country code: all the same line.
    for (const phone of ["03198754964", "0319 875-4964", "+92 319 8754964"]) {
      const { result, admin } = await lookup(phone);
      expect(result.json).toMatchObject({
        order: "#1005",
        shipments: [{ tracking: [{ number: "1Z999" }] }],
      });
      // Only this path reads phone numbers from Shopify.
      expect(admin.calls[0].query).toMatch(/ShopiAssistOrderStatusWithPhone/);
      // The phone is used for matching only and never echoed back.
      expect(result.content).not.toContain("8754964");
    }
    expect(remembered).toEqual(["#1005", "#1005", "#1005"]);

    const wrong = await lookup("0300 1112223");
    expect(wrong.result.json.error).toMatch(/No order matches/);

    // The last few digits are not a phone number.
    const partial = await lookup("4964");
    expect(partial.result.json.error).toMatch(/looks incomplete/);
    expect(partial.admin.calls).toHaveLength(0);
  });

  it("looks up by email without ever asking Shopify for phone numbers", async () => {
    const admin = fakeGraphql({ orders: { nodes: [order] } });
    await run(
      "get_order_status",
      { orderNumber: "1001", email: "buyer@example.com", phone: "03198754964" },
      enabled(admin),
    );
    expect(admin.calls[0].query).toMatch(/query ShopiAssistOrderStatus\(/);
    expect(admin.calls[0].query).not.toMatch(/phone/);
  });

  it("gives only the basics from the order number alone, and only when the merchant allows it", async () => {
    const byNumber = (admin: ReturnType<typeof fakeGraphql>) => {
      const context = enabled(admin);
      const remembered: string[] = [];
      return {
        ...context,
        settings: { ...context.settings, orderLookupByNumber: true },
        rememberOrder: async (found: { name: string }) => {
          remembered.push(found.name);
        },
        remembered,
      };
    };

    const context = byNumber(fakeGraphql({ orders: { nodes: [order] } }));
    const result = await run("get_order_status", { orderNumber: "1001" }, context);
    expect(result.json).toMatchObject({
      order: "#1001",
      placedOn: "2026-11-10",
      paymentStatus: "PAID",
      fulfillmentStatus: "FULFILLED",
      shipments: [{ status: "SUCCESS", carrier: "UPS" }],
    });
    // Nothing that leads to where the parcel is going, and nothing personal.
    expect(result.content).not.toMatch(/1Z999|ups\.example|buyer@/i);
    expect(result.json.note).toMatch(/tracking number and link are shared when/i);
    // A number proves nothing, so the order is not treated as the shopper's from now on.
    expect(context.remembered).toEqual([]);

    // With proof, the same store gives the full answer.
    const proved = await run(
      "get_order_status",
      { orderNumber: "1001", email: "buyer@example.com" },
      byNumber(fakeGraphql({ orders: { nodes: [order] } })),
    );
    expect(proved.json.shipments[0].tracking[0].number).toBe("1Z999");

    const missing = await run(
      "get_order_status",
      { orderNumber: "4242" },
      byNumber(fakeGraphql({ orders: { nodes: [order] } })),
    );
    expect(missing.json.error).toMatch(/No order has that number/);

    // Walking through order numbers is slowed by the same per-address limit.
    const limited = byNumber(fakeGraphql({ orders: { nodes: [order] } }));
    limited.rateLimiter = new RateLimiter();
    const attempts = [];
    for (let index = 0; index < 6; index += 1) {
      limited.turn = { orderLookups: 0 };
      attempts.push(await run("get_order_status", { orderNumber: String(1001 + index) }, limited));
    }
    expect(attempts.at(-1)!.json.error).toMatch(/Too many order lookups/);

    // Without the merchant's opt-in, a number alone gets nothing.
    const admin = fakeGraphql({ orders: { nodes: [order] } });
    const off = await run("get_order_status", { orderNumber: "1001" }, enabled(admin));
    expect(off.json.error).toMatch(/needed too/);
    expect(admin.calls).toHaveLength(0);
  });

  it("gives the same answer for a wrong email as for a missing order", async () => {
    const wrongEmail = await run(
      "get_order_status",
      { orderNumber: "1001", email: "someone@else.com" },
      enabled(fakeGraphql({ orders: { nodes: [order] } })),
    );
    const noOrder = await run(
      "get_order_status",
      { orderNumber: "4242", email: "buyer@example.com" },
      enabled(fakeGraphql({ orders: { nodes: [] } })),
    );

    expect(wrongEmail.ok).toBe(false);
    expect(wrongEmail.content).toBe(noOrder.content);
  });

  it("does not match on a partial order number", async () => {
    // Shopify's search is fuzzy: searching 100 can return #1001.
    const result = await run(
      "get_order_status",
      { orderNumber: "100", email: "buyer@example.com" },
      enabled(fakeGraphql({ orders: { nodes: [order] } })),
    );
    expect(result.ok).toBe(false);
  });

  /** Each call is a new chat turn; the limiter is what the turns share. */
  const lookupFrom = (
    rateLimiter: RateLimiter,
    admin: ReturnType<typeof fakeGraphql>,
    ip: string,
    args: { orderNumber: string; email: string },
  ) =>
    run(
      "get_order_status",
      args,
      toolContext({
        admin,
        storefront: fakeGraphql({}),
        settings: { ...SHOPPER_DEFAULTS, orderLookupEnabled: true },
        buyer: { ip },
        rateLimiter,
      }),
    );

  it("throttles repeated lookups from one address", async () => {
    const admin = fakeGraphql({ orders: { nodes: [] } });
    const rateLimiter = new RateLimiter();
    const attempt = (n: number) =>
      lookupFrom(rateLimiter, admin, "203.0.113.7", { orderNumber: String(n), email: `a${n}@b.co` });

    for (let i = 0; i < 5; i += 1) await attempt(i);
    const sixth = await attempt(6);

    expect(sixth.json.error).toMatch(/Too many order lookups/);
    expect(admin.calls).toHaveLength(5);
  });

  it("lets one message look into the same order several times, but only a couple of orders", async () => {
    const order = { id: "gid://shopify/Order/1", name: "#1001", email: "buyer@example.com" };
    const context = toolContext({
      admin: fakeGraphql({ orders: { nodes: [order] } }),
      storefront: fakeGraphql({}),
      settings: { ...SHOPPER_DEFAULTS, orderLookupEnabled: true },
      rateLimiter: new RateLimiter(),
      isTestStore: async () => true,
    });
    const look = (orderNumber: string) =>
      run("get_order_status", { orderNumber, email: "buyer@example.com" }, context);

    // Status, then again for its items, then for the change: all one order.
    for (let i = 0; i < 4; i += 1) {
      expect((await look("1001")).json.error ?? "").not.toMatch(/Only a couple of orders/);
    }
    expect((await look("1002")).json.error ?? "").not.toMatch(/Only a couple of orders/);
    // A third order in the same message is one too many.
    expect((await look("1003")).json.error).toMatch(/Only a couple of orders/);
  });

  it("gives a development store far more lookups, and still stops in the end", async () => {
    const admin = fakeGraphql({ orders: { nodes: [] } });
    const rateLimiter = new RateLimiter();
    let asked = 0;
    const attempt = (n: number) =>
      run(
        "get_order_status",
        { orderNumber: String(n), email: `a${n}@b.co` },
        toolContext({
          admin,
          storefront: fakeGraphql({}),
          settings: { ...SHOPPER_DEFAULTS, orderLookupEnabled: true },
          buyer: { ip: "203.0.113.7" },
          rateLimiter,
          isTestStore: async () => {
            asked += 1;
            return true;
          },
        }),
      );

    for (let i = 0; i < 5; i += 1) await attempt(i);
    // Not asked while the ordinary limit still has room.
    expect(asked).toBe(0);

    const sixth = await attempt(6);
    expect(sixth.json.error).not.toMatch(/Too many/);
    expect(asked).toBe(1);

    // The extra allowance is 50 times the ordinary one: 250 more from one
    // address, of which the sixth lookup was the first.
    for (let i = 7; i <= 255; i += 1) await attempt(i);
    const last = await attempt(256);
    expect(last.json.error).toMatch(/Too many order lookups/);
  });

  it("throttles guesses against one email even when the address keeps changing", async () => {
    const admin = fakeGraphql({ orders: { nodes: [] } });
    const rateLimiter = new RateLimiter();
    const guess = (n: number) =>
      lookupFrom(rateLimiter, admin, `198.51.100.${n}`, {
        orderNumber: String(1000 + n),
        email: "Victim@Example.com",
      });

    for (let i = 0; i < 5; i += 1) expect((await guess(i)).json.error).not.toMatch(/Too many/);
    const sixth = await guess(6);

    expect(sixth.json.error).toMatch(/Too many order lookups/);
    expect(admin.calls).toHaveLength(5);
    // A different email from a fresh address is unaffected.
    const other = await lookupFrom(rateLimiter, admin, "198.51.100.99", {
      orderNumber: "1",
      email: "someone@else.com",
    });
    expect(other.json.error).not.toMatch(/Too many/);
  });

  it("caps total lookups per shop per hour", async () => {
    const admin = fakeGraphql({ orders: { nodes: [] } });
    const rateLimiter = new RateLimiter();
    const results = [];
    for (let i = 0; i < 61; i += 1) {
      results.push(
        await lookupFrom(rateLimiter, admin, `2001:db8:${i}::1`, {
          orderNumber: String(i),
          email: `user${i}@example.com`,
        }),
      );
    }

    expect(results.slice(0, 60).every((r) => !/Too many/.test(r.json.error))).toBe(true);
    expect(results[60].json.error).toMatch(/Too many order lookups/);
    expect(admin.calls).toHaveLength(60);
  });

  it("allows at most two lookups in a single chat turn", async () => {
    const admin = fakeGraphql({ orders: { nodes: [] } });
    const context = enabled(admin);
    const attempt = (n: number) =>
      run("get_order_status", { orderNumber: String(n), email: `a${n}@b.co` }, context);

    await attempt(1);
    await attempt(2);
    const third = await attempt(3);

    expect(third.json.error).toMatch(/per message/);
    expect(admin.calls).toHaveLength(2);
  });
});

describe("place_order", () => {
  const variant = (id: string, overrides: Record<string, unknown> = {}) => ({
    id: `gid://shopify/ProductVariant/${id}`,
    title: "Default Title",
    availableForSale: true,
    price: { amount: "18.0", currencyCode: "USD" },
    product: { title: "Trail Mug" },
    ...overrides,
  });

  it("checks every item, prices the order and hands the widget one order", async () => {
    const storefront = fakeGraphql({
      nodes: [
        variant("101"),
        variant("202", {
          title: "Large",
          price: { amount: "89.50", currencyCode: "USD" },
          product: { title: "Camp Blanket" },
        }),
      ],
    });

    const result = await run(
      "place_order",
      {
        items: [
          { variantId: "101", quantity: 2 },
          { variantId: "202" },
          // The same variant again is the same line, not a third one.
          { variantId: "101", quantity: 1 },
        ],
      },
      toolContext({ storefront, buyer: { country: "CA" } }),
    );

    expect(storefront.calls).toHaveLength(1);
    expect(storefront.calls[0].variables).toEqual({
      ids: ["gid://shopify/ProductVariant/101", "gid://shopify/ProductVariant/202"],
      country: "CA",
    });
    expect(result.actions).toEqual([
      {
        type: "order",
        items: [
          { variantId: "101", quantity: 3, title: "Trail Mug" },
          { variantId: "202", quantity: 1, title: "Camp Blanket (Large)" },
        ],
      },
    ]);
    expect(result.json.items).toEqual([
      { item: "Trail Mug", quantity: 3, unitPrice: "18.0 USD", lineTotal: "54.0 USD" },
      { item: "Camp Blanket (Large)", quantity: 1, unitPrice: "89.50 USD", lineTotal: "89.50 USD" },
    ]);
    expect(result.json.itemsTotal).toBe("143.50 USD");
    // The model is told the order is not placed yet.
    expect(result.json.note).toMatch(/not placed until they complete it/);
    expect(result.json.note).toMatch(/lists everything in the cart/);
  });

  it("starts nothing when one item is made up or sold out", async () => {
    const madeUp = await run(
      "place_order",
      { items: [{ variantId: "101" }, { variantId: "999" }] },
      toolContext({ storefront: fakeGraphql({ nodes: [variant("101"), null] }) }),
    );
    expect(madeUp.json.error).toMatch(/Variant 999 does not exist/);
    expect(madeUp.actions).toEqual([]);

    const soldOut = await run(
      "place_order",
      { items: [{ variantId: "101" }] },
      toolContext({
        storefront: fakeGraphql({ nodes: [variant("101", { availableForSale: false })] }),
      }),
    );
    expect(soldOut.json.error).toMatch(/"Trail Mug" is out of stock/);
    expect(soldOut.actions).toEqual([]);
  });

  it("rejects malformed orders before calling Shopify", async () => {
    const storefront = fakeGraphql({ nodes: [] });
    const context = toolContext({ storefront });

    for (const args of [
      { items: [] },
      { items: [{ variantId: "101; DROP" }] },
      { items: [{ variantId: "101", quantity: 500 }] },
      { items: Array.from({ length: 11 }, (_, index) => ({ variantId: String(index + 1) })) },
    ]) {
      expect((await run("place_order", args, context)).json.error).toMatch(/Invalid arguments/);
    }
    expect(storefront.calls).toHaveLength(0);
  });

  it("needs both checkout and add to cart switched on", async () => {
    for (const off of [{ allowCheckout: false }, { allowAddToCart: false }]) {
      const context = toolContext({
        storefront: fakeGraphql({ nodes: [variant("101")] }),
        settings: { ...SHOPPER_DEFAULTS, ...off },
      });
      const result = await run("place_order", { items: [{ variantId: "101" }] }, context);
      expect(result.json.error).toMatch(/Unknown tool/);
    }
  });

  it("is never offered to the merchant assistant", () => {
    const context = toolContext({ audience: "merchant", admin: fakeGraphql({}) });
    expect(toolsFor(allTools, context).map((tool) => tool.name)).not.toContain("place_order");
  });
});

describe("changing the cart", () => {
  const cart = [
    { variantId: "101", title: "Trail Mug", quantity: 2 },
    { variantId: "103", title: "Camp Blanket", quantity: 1 },
  ];

  it("place_order can make the order hold only the named items", async () => {
    const storefront = fakeGraphql({
      nodes: [
        {
          id: "gid://shopify/ProductVariant/103",
          title: "Default Title",
          availableForSale: true,
          price: { amount: "89.50", currencyCode: "USD" },
          product: { title: "Camp Blanket" },
        },
      ],
    });
    const result = await run(
      "place_order",
      { items: [{ variantId: "103" }], onlyTheseItems: true },
      toolContext({ storefront, cart }),
    );

    expect(result.actions).toEqual([
      {
        type: "order",
        replace: true,
        items: [{ variantId: "103", quantity: 1, title: "Camp Blanket" }],
      },
    ]);
    expect(result.json.note).toMatch(/emptying the shopper's cart, putting in only these items/);
  });

  it("remove_from_cart takes out an item that is in the cart", async () => {
    const result = await run("remove_from_cart", { variantId: "103" }, toolContext({ cart }));
    expect(result.actions).toEqual([
      { type: "remove_from_cart", variantId: "103", title: "Camp Blanket" },
    ]);

    const missing = await run("remove_from_cart", { variantId: "999" }, toolContext({ cart }));
    expect(missing.json.error).toMatch(/not in the shopper's cart/);
    expect(missing.actions).toEqual([]);

    // With no view of the cart, the widget is left to find out.
    const blind = await run("remove_from_cart", { variantId: "999" }, toolContext());
    expect(blind.actions).toEqual([{ type: "remove_from_cart", variantId: "999", title: undefined }]);

    const malformed = await run("remove_from_cart", { variantId: "1 OR 1=1" }, toolContext({ cart }));
    expect(malformed.json.error).toMatch(/Invalid arguments/);
  });

  it("clear_cart empties the cart", async () => {
    const result = await run("clear_cart", {}, toolContext({ cart }));
    expect(result.actions).toEqual([{ type: "clear_cart" }]);
  });

  it("is off when the merchant does not let the assistant touch the cart", async () => {
    const context = toolContext({
      cart,
      settings: { ...SHOPPER_DEFAULTS, allowAddToCart: false },
    });
    expect((await run("clear_cart", {}, context)).json.error).toMatch(/Unknown tool/);
    expect((await run("remove_from_cart", { variantId: "103" }, context)).json.error).toMatch(
      /Unknown tool/,
    );
  });

  it("is never offered to the merchant assistant", () => {
    const names = toolsFor(allTools, toolContext({ audience: "merchant", admin: fakeGraphql({}) })).map(
      (tool) => tool.name,
    );
    expect(names).not.toContain("clear_cart");
    expect(names).not.toContain("remove_from_cart");
  });
});

describe("start_checkout", () => {
  it("shows the cart summary and never claims to place the order", async () => {
    const result = await run("start_checkout", {}, toolContext({ storefront: fakeGraphql({}) }));
    expect(result.actions).toEqual([{ type: "checkout" }]);
    expect(result.json.note).toMatch(/pay on the store's checkout page/);
    expect(result.json.note).toMatch(/Do not say an order has been placed/);
  });

  it("is unavailable when the merchant switched it off, as is add to cart", async () => {
    const context = toolContext({
      storefront: fakeGraphql({}),
      settings: { ...SHOPPER_DEFAULTS, allowCheckout: false, allowAddToCart: false },
    });
    expect((await run("start_checkout", {}, context)).json.error).toMatch(/Unknown tool/);
    expect((await run("add_to_cart", { variantId: "101" }, context)).json.error).toMatch(/Unknown tool/);
  });
});

describe("request_return", () => {
  const order = {
    id: "gid://shopify/Order/9001",
    name: "#1001",
    email: "buyer@example.com",
    processedAt: "2026-11-10T09:00:00Z",
    cancelledAt: null,
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    fulfillments: [],
  };
  const returnable = (...items: Array<[id: string, title: string, quantity: number]>) => ({
    returnableFulfillments: {
      nodes: [
        {
          returnableFulfillmentLineItems: {
            nodes: items.map(([id, title, quantity]) => ({
              quantity,
              fulfillmentLineItem: { id, lineItem: { title } },
            })),
          },
        },
      ],
    },
  });
  const created = { returnRequest: { return: { name: "#1001-R1", status: "REQUESTED" }, userErrors: [] } };
  // Shopify's reason categories, which every request must name one of.
  const reasons = {
    returnReasonDefinitions: {
      nodes: [
        { id: "gid://shopify/ReturnReasonDefinition/7", handle: "too-small" },
        { id: "gid://shopify/ReturnReasonDefinition/5", handle: "other-reason" },
      ],
    },
  };
  const proof = { orderNumber: "1001", email: "buyer@example.com", reason: "Too small" };
  const returnsOn = (admin: ReturnType<typeof fakeGraphql>, rateLimiter = new RateLimiter()) =>
    toolContext({
      admin,
      storefront: fakeGraphql({}),
      settings: { ...SHOPPER_DEFAULTS, allowReturns: true },
      buyer: { ip: "203.0.113.7" },
      rateLimiter,
    });

  it("is off by default", async () => {
    const admin = fakeGraphql({ orders: { nodes: [order] } });
    const result = await run("request_return", proof, toolContext({ admin, storefront: fakeGraphql({}) }));
    expect(result.json.error).toMatch(/Unknown tool/);
    expect(admin.calls).toHaveLength(0);
  });

  it("sends a return request for a single-item order", async () => {
    const admin = fakeGraphql(
      { orders: { nodes: [order] } },
      returnable(["gid://shopify/FulfillmentLineItem/1", "Trail Mug", 2]),
      reasons,
      created,
    );

    const result = await run(
      "request_return",
      { ...proof, quantity: 5, reasonKind: "too_small" },
      returnsOn(admin),
    );

    expect(result.json).toMatchObject({ status: "requested", returnReference: "#1001-R1", quantity: 2 });
    expect(result.json.note).toMatch(/request, not an approval/);
    expect(admin.calls[2].variables).toEqual({ handles: ["too-small", "other-reason"] });
    expect(admin.calls[3].variables).toEqual({
      input: {
        orderId: "gid://shopify/Order/9001",
        returnLineItems: [
          {
            fulfillmentLineItemId: "gid://shopify/FulfillmentLineItem/1",
            // Capped at what can actually be returned.
            quantity: 2,
            customerNote: "Too small",
            returnReasonDefinitionId: "gid://shopify/ReturnReasonDefinition/7",
          },
        ],
      },
    });
  });

  it("files the request under 'other' when no category was chosen", async () => {
    const admin = fakeGraphql(
      { orders: { nodes: [order] } },
      returnable(["gid://shopify/FulfillmentLineItem/1", "Trail Mug", 1]),
      reasons,
      created,
    );

    await run("request_return", { ...proof, reason: "It is the wrong size" }, returnsOn(admin));

    expect(admin.calls[2].variables).toEqual({ handles: ["other-reason"] });
    const line = (admin.calls[3].variables as { input: { returnLineItems: Array<Record<string, unknown>> } })
      .input.returnLineItems[0];
    expect(line.returnReasonDefinitionId).toBe("gid://shopify/ReturnReasonDefinition/5");
  });

  it("asks which item instead of guessing when the order has several", async () => {
    const items = returnable(
      ["gid://shopify/FulfillmentLineItem/1", "Trail Mug", 1],
      ["gid://shopify/FulfillmentLineItem/2", "Camp Kettle", 1],
    );
    const admin = fakeGraphql({ orders: { nodes: [order] } }, items);

    const result = await run("request_return", proof, returnsOn(admin));

    expect(result.json.status).toBe("need_item");
    expect(result.json.returnableItems.map((item: { title: string }) => item.title)).toEqual([
      "Trail Mug",
      "Camp Kettle",
    ]);
    // Looked up the order and its items, but sent nothing.
    expect(admin.calls).toHaveLength(2);

    const second = fakeGraphql({ orders: { nodes: [order] } }, items, reasons, created);
    const chosen = await run("request_return", { ...proof, itemTitle: "kettle" }, returnsOn(second));
    expect(chosen.json).toMatchObject({ status: "requested", item: "Camp Kettle" });
  });

  it("refuses without proof of ownership and never reaches the returns API", async () => {
    const admin = fakeGraphql({ orders: { nodes: [order] } });
    const result = await run(
      "request_return",
      { ...proof, email: "someone@else.com" },
      returnsOn(admin),
    );
    expect(result.ok).toBe(false);
    expect(result.json.error).toMatch(/No order matches/);
    expect(admin.calls).toHaveLength(1);
  });

  it("allows one request per order per day", async () => {
    const rateLimiter = new RateLimiter();
    const item = returnable(["gid://shopify/FulfillmentLineItem/1", "Trail Mug", 1]);
    const first = fakeGraphql({ orders: { nodes: [order] } }, item, reasons, created);
    const again = fakeGraphql({ orders: { nodes: [order] } }, item, reasons, created);

    expect((await run("request_return", proof, returnsOn(first, rateLimiter))).json.status).toBe("requested");
    const repeat = await run("request_return", proof, returnsOn(again, rateLimiter));

    expect(repeat.json.error).toMatch(/already requested for this order today/);
    // Order, items and reasons were read; no second request was sent.
    expect(again.calls).toHaveLength(3);
  });

  it("lets the shopper try again after Shopify turned a request down", async () => {
    const rateLimiter = new RateLimiter();
    const item = returnable(["gid://shopify/FulfillmentLineItem/1", "Trail Mug", 1]);
    const refused = fakeGraphql({ orders: { nodes: [order] } }, item, reasons, {
      returnRequest: { return: null, userErrors: [{ message: "Return reason can't be blank" }] },
    });
    const retry = fakeGraphql({ orders: { nodes: [order] } }, item, reasons, created);

    const first = await run("request_return", proof, returnsOn(refused, rateLimiter));
    expect(first.json.error).toMatch(/did not accept the return request/);
    const second = await run("request_return", proof, returnsOn(retry, rateLimiter));
    expect(second.json.status).toBe("requested");
  });

  it("explains when nothing can be returned or Shopify rejects the request", async () => {
    const nothing = await run(
      "request_return",
      proof,
      returnsOn(fakeGraphql({ orders: { nodes: [order] } }, returnable())),
    );
    expect(nothing.json.error).toMatch(/Nothing on this order can be returned/);

    const rejected = await run(
      "request_return",
      proof,
      returnsOn(
        fakeGraphql(
          { orders: { nodes: [order] } },
          returnable(["gid://shopify/FulfillmentLineItem/1", "Trail Mug", 1]),
          reasons,
          { returnRequest: { return: null, userErrors: [{ message: "Return window has closed" }] } },
        ),
      ),
    );
    expect(rejected.json.error).toMatch(/did not accept the return request: Return window has closed/);
  });
});

describe("merchant tools", () => {
  const merchant = (admin: ReturnType<typeof fakeGraphql>) =>
    toolContext({ audience: "merchant", admin });

  it("get_top_selling_products ranks with ShopifyQL", async () => {
    const admin = fakeGraphql({
      shopifyqlQuery: {
        parseErrors: [],
        tableData: {
          columns: [
            { name: "product_title", dataType: "STRING", displayName: "Product title" },
            { name: "net_items_sold", dataType: "INTEGER", displayName: "Net items sold" },
            { name: "net_sales", dataType: "MONEY", displayName: "Net sales" },
          ],
          rows: [
            { product_title: "Trail Mug", net_items_sold: "42", net_sales: "756.004" },
            { product_title: "Camp Kettle", net_items_sold: "17", net_sales: "680" },
          ],
        },
      },
    });

    const result = await run(
      "get_top_selling_products",
      { days: 7, limit: 2, rankBy: "revenue" },
      merchant(admin),
    );

    expect(admin.calls[0].variables!.query).toBe(
      "FROM sales SHOW net_items_sold, net_sales GROUP BY product_title SINCE -7d UNTIL today ORDER BY net_sales DESC LIMIT 2",
    );
    expect(result.json).toMatchObject({
      periodDays: 7,
      source: "sales analytics",
      products: [
        { rank: 1, title: "Trail Mug", unitsSold: 42, netSales: 756 },
        { rank: 2, title: "Camp Kettle", unitsSold: 17, netSales: 680 },
      ],
    });
  });

  it("falls back to recent orders when ShopifyQL is unavailable, and says so", async () => {
    const lineItem = (title: string, quantity: number, amount: string) => ({
      title,
      currentQuantity: quantity,
      discountedTotalSet: { shopMoney: { amount, currencyCode: "USD" } },
    });
    const orderNode = (items: unknown[], cancelledAt: string | null = null) => ({
      cancelledAt,
      currentTotalPriceSet: { shopMoney: { amount: "50.0", currencyCode: "USD" } },
      lineItems: { nodes: items },
    });
    const admin = fakeGraphql(new Error("Admin GraphQL error: access denied for shopifyqlQuery"), {
      orders: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          orderNode([lineItem("Trail Mug", 2, "36.0"), lineItem("Camp Kettle", 1, "40.0")]),
          orderNode([lineItem("Trail Mug", 3, "54.0")]),
          orderNode([lineItem("Camp Kettle", 9, "360.0")], "2026-11-12T00:00:00Z"),
        ],
      },
    });

    const result = await run("get_top_selling_products", { days: 30 }, merchant(admin));

    expect(admin.calls[1].variables).toEqual({ query: "created_at:>=2026-10-19", after: null });
    expect(result.json.source).toBe("recent orders");
    expect(result.json.note).toMatch(/approximate/);
    expect(result.json.ordersCounted).toBe(2);
    expect(result.json.products).toEqual([
      { rank: 1, title: "Trail Mug", unitsSold: 5, netSales: 90 },
      { rank: 2, title: "Camp Kettle", unitsSold: 1, netSales: 40 },
    ]);
  });

  it("get_low_stock_products skips drafts and archived products", async () => {
    const admin = fakeGraphql({
      productVariants: {
        nodes: [
          { title: "Small", sku: "MUG-S", inventoryQuantity: 0, product: { title: "Trail Mug", handle: "trail-mug", status: "ACTIVE" } },
          { title: "Default Title", sku: null, inventoryQuantity: 1, product: { title: "Old Lamp", handle: "old-lamp", status: "ARCHIVED" } },
        ],
      },
    });

    const result = await run("get_low_stock_products", { threshold: 3 }, merchant(admin));

    expect(admin.calls[0].variables).toMatchObject({ query: "inventory_quantity:<=3" });
    expect(result.json.variants).toEqual([
      { product: "Trail Mug", variant: "Small", sku: "MUG-S", inStock: 0 },
    ]);
  });

  it("no merchant query selects customer names, emails or addresses", () => {
    const admin = fakeGraphql({});
    const context = merchant(admin);
    expect(toolsFor(allTools, context).length).toBe(merchantTools.length);
    // Static check over the query documents used by merchant tools.
    return import("../app/assistant/tools/merchant").then((module) => {
      const documents = Object.entries(module)
        .filter(([name, value]) => name.endsWith("_QUERY") && typeof value === "string")
        .map(([, value]) => value as string);
      expect(documents.length).toBeGreaterThanOrEqual(5);
      for (const document of documents) {
        expect(document).not.toMatch(/\b(email|phone|firstName|lastName|shippingAddress|billingAddress|customer)\b/);
      }
    });
  });
});

describe("samePhone", () => {
  it("matches the same line however it is written", () => {
    expect(samePhone("03198754964", "+92 319 8754964")).toBe(true);
    expect(samePhone("+1 (202) 555-0143", "2025550143")).toBe(true);
    expect(samePhone("+12025550143", "+12025550143")).toBe(true);
  });

  it("does not match different lines, short tails or nothing", () => {
    expect(samePhone("03198754964", "03198754965")).toBe(false);
    expect(samePhone("03198754964", "4964")).toBe(false);
    expect(samePhone("03198754964", "")).toBe(false);
    expect(samePhone(null, undefined)).toBe(false);
    expect(samePhone("", "")).toBe(false);
  });
});

describe("helpers", () => {
  it("numericId extracts the id from a Shopify gid", () => {
    expect(numericId("gid://shopify/ProductVariant/4567")).toBe("4567");
    expect(numericId("not-a-gid")).toBeNull();
  });

  it("htmlToText strips tags and truncates", () => {
    expect(htmlToText("<p>Hello&nbsp;&amp; welcome</p><p>Bye</p>", 100)).toBe("Hello & welcome\nBye");
    expect(htmlToText("abcdefghij", 5)).toBe("abcde…");
  });

  it("shopifyqlRows accepts array rows and object rows", () => {
    const columns = [
      { name: "a", dataType: "STRING", displayName: "A" },
      { name: "b", dataType: "INTEGER", displayName: "B" },
    ];
    expect(shopifyqlRows({ columns, rows: [["x", 1]] })).toEqual([{ a: "x", b: 1 }]);
    expect(shopifyqlRows({ columns, rows: [{ a: "y", b: 2 }] })).toEqual([{ a: "y", b: 2 }]);
    expect(shopifyqlRows(null)).toEqual([]);
  });
});
