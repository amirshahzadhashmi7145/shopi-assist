import { describe, expect, it } from "vitest";

import { allTools, merchantTools, shopperTools } from "../app/assistant/tools";
import {
  executeToolCall,
  toLlmToolSpecs,
  toolsFor,
} from "../app/assistant/tools/registry";
import { shopifyqlRows } from "../app/assistant/tools/merchant";
import { htmlToText, numericId } from "../app/assistant/tools/shopper";
import { RateLimiter } from "../app/assistant/rate-limit";
import { fakeGraphql, storefrontProduct, toolContext } from "./helpers/fakes";

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
      settings: { orderLookupEnabled: true },
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
      settings: { orderLookupEnabled: true },
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
        settings: { orderLookupEnabled: true },
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
