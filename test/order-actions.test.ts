import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  GRANT_LIFETIME_MS,
  readGrant,
  signGrant,
  type OrderActionGrant,
} from "../app/assistant/action-grant.server";
import {
  blocker,
  handleOrderAction,
  type ActionOrder,
  type OrderActionDeps,
} from "../app/assistant/order-actions.server";
import { OrderError } from "../app/assistant/orders.server";
import { RateLimiter } from "../app/assistant/rate-limit";
import { saveSettings } from "../app/assistant/settings.server";
import { createConversation, recentMessages } from "../app/assistant/store.server";
import { allTools } from "../app/assistant/tools";
import { executeToolCall, toolsFor } from "../app/assistant/tools/registry";
import type { ClientAction, GraphqlFn } from "../app/assistant/types";
import { createTestDb } from "./helpers/db";
import { toolContext } from "./helpers/fakes";

const SHOP = "shop-a.myshopify.com";
const SECRET = "test-signing-secret";
const NOW = new Date("2026-11-20T12:00:00Z");
const ORDER_ID = "gid://shopify/Order/1005";

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

/** An unpaid, unshipped pay-on-delivery order of two mugs and a blanket. */
const shopifyOrder = (overrides: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  name: "#1005",
  note: null,
  cancelledAt: null,
  closed: false,
  displayFulfillmentStatus: "UNFULFILLED",
  displayFinancialStatus: "PENDING",
  fulfillments: [],
  totalReceivedSet: set("0.0"),
  currentTotalPriceSet: set("125.0"),
  shippingAddress: { countryCodeV2: "US" },
  lineItems: {
    nodes: [
      {
        title: "Trail Mug",
        variantTitle: "Default Title",
        currentQuantity: 2,
        variant: { id: "gid://shopify/ProductVariant/101" },
        discountedUnitPriceSet: set("18.0"),
      },
      {
        title: "Camp Blanket",
        variantTitle: "Large",
        currentQuantity: 1,
        variant: { id: "gid://shopify/ProductVariant/103" },
        discountedUnitPriceSet: set("89.0"),
      },
    ],
  },
  ...overrides,
});

const adminApi = (order: Record<string, unknown> = shopifyOrder(), overrides: Record<string, Handler> = {}) =>
  routedGraphql({
    ShopiAssistOrderForAction: () => ({ order }),
    ShopiAssistOrderCancel: () => ({
      orderCancel: { job: { id: "gid://shopify/Job/1" }, orderCancelUserErrors: [], userErrors: [] },
    }),
    ShopiAssistOrderUpdate: () => ({ orderUpdate: { order: { id: ORDER_ID }, userErrors: [] } }),
    ShopiAssistOrderTagsAdd: () => ({ tagsAdd: { userErrors: [] } }),
    ShopiAssistOrderEditBegin: () => ({
      orderEditBegin: {
        calculatedOrder: {
          id: "gid://shopify/CalculatedOrder/1",
          lineItems: {
            nodes: [
              { id: "gid://shopify/CalculatedLineItem/1", quantity: 2, variant: { id: "gid://shopify/ProductVariant/101" } },
              { id: "gid://shopify/CalculatedLineItem/2", quantity: 1, variant: { id: "gid://shopify/ProductVariant/103" } },
            ],
          },
        },
        userErrors: [],
      },
    }),
    ShopiAssistOrderEditSetQuantity: () => ({ orderEditSetQuantity: { calculatedOrder: { id: "x" }, userErrors: [] } }),
    ShopiAssistOrderEditAddVariant: () => ({ orderEditAddVariant: { calculatedOrder: { id: "x" }, userErrors: [] } }),
    ShopiAssistOrderEditCommit: () => ({
      orderEditCommit: { order: { name: "#1005", currentTotalPriceSet: set("161.0") }, userErrors: [] },
    }),
    ...overrides,
  });

const grant = (overrides: Partial<OrderActionGrant> = {}): OrderActionGrant => ({
  shop: SHOP,
  orderId: ORDER_ID,
  orderName: "#1005",
  kind: "cancel",
  exp: NOW.getTime() + GRANT_LIFETIME_MS,
  ...overrides,
});

let db: PrismaClient;
let cleanup: () => Promise<void>;
let deps: Partial<OrderActionDeps>;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});
afterAll(async () => {
  await cleanup();
});
beforeEach(async () => {
  await db.conversation.deleteMany();
  await db.shopSettings.deleteMany();
  await saveSettings(
    SHOP,
    { allowOrderCancel: true, allowAddressChange: true, allowOrderEdit: true },
    db,
  );
  deps = { db, rateLimiter: new RateLimiter(), secret: SECRET, now: () => NOW };
});

const act = (
  body: Record<string, unknown>,
  admin = adminApi(),
  given: OrderActionGrant | string = grant({ kind: body.step as OrderActionGrant["kind"] }),
) => ({
  admin,
  result: handleOrderAction(
    {
      shop: SHOP,
      body: { ...body, token: typeof given === "string" ? given : signGrant(given, SECRET) },
      ip: "203.0.113.7",
      admin,
    },
    deps,
  ),
});

const failure = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OrderError);
  return error as OrderError;
};

const operations = (admin: ReturnType<typeof adminApi>) => admin.calls.map((call) => call.operation);

describe("grants", () => {
  const expected = { shop: SHOP, secret: SECRET, now: NOW.getTime() };

  it("round-trips a grant signed by this app", () => {
    const token = signGrant(grant({ reason: "Changed my mind" }), SECRET);
    expect(readGrant(token, expected)).toMatchObject({
      orderId: ORDER_ID,
      kind: "cancel",
      reason: "Changed my mind",
    });
  });

  it("refuses anything altered, forged, for another shop, or out of date", () => {
    const token = signGrant(grant(), SECRET);
    const [body, mac] = token.split(".");

    // The browser swaps in another order and keeps the old signature.
    const otherOrder = Buffer.from(
      JSON.stringify({ ...grant(), orderId: "gid://shopify/Order/1" }),
    ).toString("base64url");
    expect(readGrant(`${otherOrder}.${mac}`, expected)).toBeNull();

    expect(readGrant(signGrant(grant(), "another-secret"), expected)).toBeNull();
    expect(readGrant(token, { ...expected, shop: "shop-b.myshopify.com" })).toBeNull();
    expect(readGrant(token, { ...expected, now: NOW.getTime() + GRANT_LIFETIME_MS + 1 })).toBeNull();

    for (const bad of [undefined, 42, "", "nonsense", `${body}.`, `${body}.${mac}.extra`, "a".repeat(9000)]) {
      expect(readGrant(bad, expected)).toBeNull();
    }
  });
});

describe("whether an order can still be changed", () => {
  const order = (overrides: Partial<ActionOrder> = {}): ActionOrder => ({
    id: ORDER_ID,
    name: "#1005",
    note: "",
    cancelled: false,
    closed: false,
    fulfillmentStatus: "UNFULFILLED",
    hasFulfillments: false,
    nothingPaid: true,
    countryCode: "US",
    total: usd("125.0"),
    lines: [],
    ...overrides,
  });

  it("allows an order nothing has shipped from", () => {
    expect(blocker(order())).toBeNull();
    // Whether it has been paid is a separate matter.
    expect(blocker(order({ nothingPaid: false }))).toBeNull();
  });

  it("refuses once shipping has started in any way", () => {
    for (const fulfillmentStatus of [
      "FULFILLED",
      "PARTIALLY_FULFILLED",
      "IN_PROGRESS",
      "ON_HOLD",
      "SCHEDULED",
      "PENDING_FULFILLMENT",
      "OPEN",
      "RESTOCKED",
    ]) {
      expect(blocker(order({ fulfillmentStatus }))).toBe("shipping_started");
    }
    // A fulfilment exists even though the summary status has not caught up.
    expect(blocker(order({ hasFulfillments: true }))).toBe("shipping_started");
  });

  it("refuses a cancelled or closed order", () => {
    expect(blocker(order({ cancelled: true }))).toBe("cancelled");
    expect(blocker(order({ closed: true }))).toBe("closed");
  });
});

describe("cancelling", () => {
  it("cancels an unpaid, unshipped order when the shopper confirms", async () => {
    const conversation = await createConversation(db, {
      shop: SHOP,
      audience: "shopper",
      visitorId: "visitor-0001",
    });
    const { result, admin } = act(
      { step: "cancel" },
      adminApi(),
      grant({ reason: "Ordered the wrong size", conversationId: conversation.id }),
    );

    expect(await result).toEqual({
      ok: true,
      step: "cancel",
      order: { name: "#1005" },
      message: "Order #1005 is cancelled. Nothing had been charged for it.",
    });
    expect(operations(admin)).toEqual([
      "ShopiAssistOrderForAction",
      "ShopiAssistOrderCancel",
      "ShopiAssistOrderTagsAdd",
    ]);
    expect(admin.calls[1].variables).toEqual({
      orderId: ORDER_ID,
      staffNote: "Cancelled by the customer in the Shopi Assist chat. Reason: Ordered the wrong size",
    });
    expect(admin.calls[2].variables).toEqual({ id: ORDER_ID, tags: ["cancelled-in-chat"] });

    // The chat is told, so the assistant knows the order is gone.
    expect(await recentMessages(db, SHOP, conversation.id, 10)).toEqual([
      { role: "user", content: "(I confirmed cancelling the order with the button.)" },
      { role: "assistant", content: "Order #1005 is cancelled. Nothing had been charged for it." },
    ]);
  });

  it("refuses when the order started shipping after the card was shown", async () => {
    for (const order of [
      shopifyOrder({ displayFulfillmentStatus: "FULFILLED", fulfillments: [{ status: "SUCCESS" }] }),
      shopifyOrder({ displayFulfillmentStatus: "IN_PROGRESS" }),
      shopifyOrder({ displayFulfillmentStatus: "PARTIALLY_FULFILLED", fulfillments: [{ status: "SUCCESS" }] }),
    ]) {
      const { result, admin } = act({ step: "cancel" }, adminApi(order));
      const error = await failure(result);
      expect(error.code).toBe("unavailable");
      expect(error.message).toMatch(/already being prepared or has shipped/);
      expect(operations(admin)).toEqual(["ShopiAssistOrderForAction"]);
    }
  });

  it("never cancels an order that has been paid", async () => {
    const paid = shopifyOrder({ displayFinancialStatus: "PAID", totalReceivedSet: set("125.0") });
    const { result, admin } = act({ step: "cancel" }, adminApi(paid));
    const error = await failure(result);

    expect(error.code).toBe("unavailable");
    expect(error.message).toMatch(/store needs to cancel and refund/);
    expect(operations(admin)).not.toContain("ShopiAssistOrderCancel");

    // Authorised but not captured is money held, so it counts as paid too.
    const authorised = shopifyOrder({ displayFinancialStatus: "AUTHORIZED" });
    await failure(act({ step: "cancel" }, adminApi(authorised)).result);
  });

  it("passes a paid order's cancellation to the store as a tagged request", async () => {
    const paid = shopifyOrder({
      displayFinancialStatus: "PAID",
      totalReceivedSet: set("125.0"),
      note: "Leave at the door",
    });
    const { result, admin } = act(
      { step: "cancel_request" },
      adminApi(paid),
      grant({ kind: "cancel_request", reason: "Found it cheaper" }),
    );

    expect((await result).message).toMatch(/request to cancel order #1005 has been sent to the store/);
    expect(operations(admin)).toEqual([
      "ShopiAssistOrderForAction",
      "ShopiAssistOrderUpdate",
      "ShopiAssistOrderTagsAdd",
    ]);
    // The store's own note is kept; the request is added under it.
    expect(admin.calls[1].variables).toEqual({
      input: {
        id: ORDER_ID,
        note: "Leave at the door\nCancellation requested by the customer in the Shopi Assist chat on 2026-11-20. Reason: Found it cheaper",
      },
    });
    expect(admin.calls[2].variables).toEqual({ id: ORDER_ID, tags: ["cancellation-requested"] });
    expect(operations(admin)).not.toContain("ShopiAssistOrderCancel");
  });

  it("says so when the order was already cancelled", async () => {
    const error = await failure(
      act({ step: "cancel" }, adminApi(shopifyOrder({ cancelledAt: "2026-11-20T10:00:00Z" }))).result,
    );
    expect(error.message).toBe("Order #1005 has already been cancelled.");
  });
});

describe("a new delivery address", () => {
  const address = {
    contact: { firstName: "Ada", lastName: "Lovelace", phone: "+1 202 555 0143", email: "" },
    address: {
      address1: "350 Fifth Avenue",
      address2: "",
      city: "New York",
      province: "New York",
      zip: "10118",
      countryCode: "US",
    },
  };
  const addressGrant = grant({ kind: "address", countryCode: "US" });

  it("updates an unshipped order's address and tags it for the merchant", async () => {
    const { result, admin } = act({ step: "address", ...address }, adminApi(), addressGrant);

    expect((await result).message).toBe("The delivery address for order #1005 is updated.");
    expect(admin.calls[1]).toEqual({
      operation: "ShopiAssistOrderUpdate",
      variables: {
        input: {
          id: ORDER_ID,
          shippingAddress: {
            firstName: "Ada",
            lastName: "Lovelace",
            company: null,
            address1: "350 Fifth Avenue",
            address2: null,
            city: "New York",
            zip: "10118",
            countryCode: "US",
            phone: "+12025550143",
            province: "New York",
          },
        },
      },
    });
    expect(admin.calls[2].variables).toEqual({ id: ORDER_ID, tags: ["address-changed-in-chat"] });
  });

  it("works for a paid order too, since no money moves", async () => {
    const paid = shopifyOrder({ displayFinancialStatus: "PAID", totalReceivedSet: set("125.0") });
    const { result } = act({ step: "address", ...address }, adminApi(paid), addressGrant);
    expect((await result).ok).toBe(true);
  });

  it("keeps the order in the same country", async () => {
    const abroad = { ...address, address: { ...address.address, countryCode: "CA" } };
    const { result, admin } = act({ step: "address", ...abroad }, adminApi(), addressGrant);
    const error = await failure(result);

    expect(error.code).toBe("invalid_order");
    expect(error.extra.fields!.countryCode).toMatch(/country can't be changed here/);
    expect(operations(admin)).not.toContain("ShopiAssistOrderUpdate");
  });

  it("names the fields that need fixing, ours and Shopify's", async () => {
    const blank = { ...address, contact: { ...address.contact, lastName: "" } };
    const ours = await failure(act({ step: "address", ...blank }, adminApi(), addressGrant).result);
    expect(ours.extra.fields).toEqual({ lastName: "Enter your last name." });

    const admin = adminApi(shopifyOrder(), {
      ShopiAssistOrderUpdate: () => ({
        orderUpdate: {
          order: null,
          userErrors: [{ field: ["input", "shippingAddress", "zip"], message: "Zip is not valid for New York" }],
        },
      }),
    });
    const theirs = await failure(act({ step: "address", ...address }, admin, addressGrant).result);
    expect(theirs.extra.fields).toEqual({ zip: "Zip is not valid for New York" });
    expect(operations(admin)).not.toContain("ShopiAssistOrderTagsAdd");
  });

  it("refuses once the order has shipped", async () => {
    const shipped = shopifyOrder({ displayFulfillmentStatus: "FULFILLED", fulfillments: [{ status: "SUCCESS" }] });
    const error = await failure(act({ step: "address", ...address }, adminApi(shipped), addressGrant).result);
    expect(error.code).toBe("unavailable");
  });
});

describe("changing the items", () => {
  const editGrant = (changes: OrderActionGrant["changes"]) => grant({ kind: "edit", changes });

  it("sets quantities, adds new items and saves the edit", async () => {
    const { result, admin } = act(
      { step: "edit" },
      adminApi(),
      editGrant([
        { variantId: "101", quantity: 3 },
        { variantId: "103", quantity: 0 },
        { variantId: "202", quantity: 1 },
      ]),
    );

    expect((await result).message).toBe(
      "Order #1005 is updated. The new total is $161.00, to be paid on delivery.",
    );
    expect(operations(admin)).toEqual([
      "ShopiAssistOrderForAction",
      "ShopiAssistOrderEditBegin",
      "ShopiAssistOrderEditSetQuantity",
      "ShopiAssistOrderEditSetQuantity",
      "ShopiAssistOrderEditAddVariant",
      "ShopiAssistOrderEditCommit",
      "ShopiAssistOrderTagsAdd",
    ]);
    expect(admin.calls[2].variables).toEqual({
      id: "gid://shopify/CalculatedOrder/1",
      lineItemId: "gid://shopify/CalculatedLineItem/1",
      quantity: 3,
    });
    expect(admin.calls[3].variables).toMatchObject({ lineItemId: "gid://shopify/CalculatedLineItem/2", quantity: 0 });
    expect(admin.calls[4].variables).toEqual({
      id: "gid://shopify/CalculatedOrder/1",
      variantId: "gid://shopify/ProductVariant/202",
      quantity: 1,
    });
    expect(admin.calls[6].variables).toEqual({ id: ORDER_ID, tags: ["changed-in-chat"] });
  });

  it("changes nothing twice: quantities are what the order should end up with", async () => {
    // The order already holds two mugs; asking for two again touches no line.
    const { result, admin } = act({ step: "edit" }, adminApi(), editGrant([{ variantId: "101", quantity: 2 }]));
    await result;
    expect(operations(admin)).not.toContain("ShopiAssistOrderEditSetQuantity");
    expect(operations(admin)).not.toContain("ShopiAssistOrderEditAddVariant");
  });

  it("never re-prices an order that has been paid", async () => {
    const paid = shopifyOrder({ displayFinancialStatus: "PAID", totalReceivedSet: set("125.0") });
    const { result, admin } = act({ step: "edit" }, adminApi(paid), editGrant([{ variantId: "101", quantity: 1 }]));
    const error = await failure(result);

    expect(error.message).toMatch(/has been paid, so its items can't be changed here/);
    expect(operations(admin)).toEqual(["ShopiAssistOrderForAction"]);
  });

  it("saves nothing when Shopify refuses a line", async () => {
    const admin = adminApi(shopifyOrder(), {
      ShopiAssistOrderEditAddVariant: () => ({
        orderEditAddVariant: { calculatedOrder: null, userErrors: [{ field: null, message: "Out of stock" }] },
      }),
    });
    const error = await failure(act({ step: "edit" }, admin, editGrant([{ variantId: "202", quantity: 1 }])).result);

    expect(error.code).toBe("order_failed");
    expect(error.message).toMatch(/Nothing was changed/);
    expect(operations(admin)).not.toContain("ShopiAssistOrderEditCommit");
  });
});

describe("what a confirmation must carry", () => {
  it("gives one answer for every kind of bad grant, and touches nothing", async () => {
    const admin = adminApi();
    const attempts = [
      act({ step: "cancel" }, admin, "not-a-token-at-all-000000"),
      act({ step: "cancel" }, admin, signGrant(grant(), "another-secret")),
      act({ step: "cancel" }, admin, grant({ exp: NOW.getTime() - 1 })),
      act({ step: "cancel" }, admin, grant({ shop: "shop-b.myshopify.com" })),
      // A grant to change the address cannot be spent on cancelling.
      act({ step: "cancel" }, admin, grant({ kind: "address" })),
    ];
    for (const attempt of attempts) {
      const error = await failure(attempt.result);
      expect(error.status).toBe(410);
      expect(error.message).toBe("This has expired. Please ask the assistant again.");
    }
    expect(admin.calls).toHaveLength(0);
  });

  it("stops working when the merchant switches the feature off", async () => {
    await saveSettings(SHOP, { allowOrderCancel: false }, db);
    const { result, admin } = act({ step: "cancel" });
    expect((await failure(result)).code).toBe("disabled");
    expect(admin.calls).toHaveLength(0);
  });

  it("cannot confirm anything on a server with no signing secret", async () => {
    deps.secret = undefined;
    expect((await failure(act({ step: "cancel" }).result)).status).toBe(410);
  });

  it("limits how often one order can be acted on", async () => {
    let last: OrderError | null = null;
    for (let index = 0; index < 9; index += 1) {
      last = await act({ step: "cancel" }).result.then(
        () => null,
        (error: OrderError) => error,
      );
    }
    expect(last!.code).toBe("rate_limited");
  });

  it("hides Shopify failures behind a generic message", async () => {
    const admin = adminApi(shopifyOrder(), {
      ShopiAssistOrderCancel: () => {
        throw new Error("Admin GraphQL error: something about 12 Analytical Way");
      },
    });
    const error = await failure(act({ step: "cancel" }, admin).result);
    expect(error.code).toBe("order_failed");
    expect(error.message).not.toContain("Analytical");
  });
});

describe("the tools that start a change", () => {
  const known = [{ id: ORDER_ID, name: "#1005", source: "placed" as const }];
  const statusLookup = {
    ShopiAssistOrderStatus: () => ({
      orders: {
        nodes: [
          {
            id: ORDER_ID,
            name: "#1005",
            email: "buyer@example.com",
            processedAt: "2026-11-19T09:00:00Z",
            cancelledAt: null,
            displayFinancialStatus: "PENDING",
            displayFulfillmentStatus: "UNFULFILLED",
            fulfillments: [],
          },
        ],
      },
    }),
  };
  const granted: Array<Record<string, unknown>> = [];
  const context = (
    order: Record<string, unknown> = shopifyOrder(),
    overrides: Partial<ReturnType<typeof toolContext>> = {},
  ) => {
    granted.length = 0;
    return toolContext({
      admin: adminApi(order, statusLookup),
      settings: {
        orderLookupEnabled: true,
        orderLookupByNumber: true,
        allowReturns: true,
        allowOrderCancel: true,
        allowAddressChange: true,
        allowOrderEdit: true,
      },
      knownOrders: known,
      grantOrderAction: (given) => {
        granted.push(given);
        return `signed-grant-${granted.length}`;
      },
      buyer: { ip: "203.0.113.7" },
      ...overrides,
    });
  };
  const run = async (name: string, args: Record<string, unknown>, given: ReturnType<typeof toolContext>) => {
    const execution = await executeToolCall(
      toolsFor(allTools, given),
      { id: "c1", name, arguments: JSON.stringify(args) },
      given,
    );
    return { ...execution, json: JSON.parse(execution.content) };
  };
  const card = (actions: ClientAction[]) => actions[0] as Extract<ClientAction, { type: "order_action" }>;

  it("offers none of them unless the merchant ticked the box, and none to staff", () => {
    const names = (given: ReturnType<typeof toolContext>) =>
      toolsFor(allTools, given).map((tool) => tool.name);
    const all = ["cancel_order", "change_delivery_address", "change_order_items"];

    expect(names(context())).toEqual(expect.arrayContaining(all));
    for (const name of all) {
      expect(names(toolContext({ admin: adminApi() }))).not.toContain(name);
      // No way to sign a grant: nothing can be offered.
      expect(names(context(shopifyOrder(), { grantOrderAction: undefined }))).not.toContain(name);
      expect(names(toolContext({ audience: "merchant", admin: adminApi() }))).not.toContain(name);
    }
  });

  it("cancel_order hands out a grant and a card, and cancels nothing itself", async () => {
    const given = context();
    const result = await run("cancel_order", { orderNumber: "1005", reason: "Changed my mind" }, given);

    expect(granted).toEqual([
      { orderId: ORDER_ID, orderName: "#1005", kind: "cancel", reason: "Changed my mind" },
    ]);
    expect(card(result.actions)).toMatchObject({
      type: "order_action",
      kind: "cancel",
      order: "#1005",
      token: "signed-grant-1",
      title: "Cancel order #1005?",
      lines: ["2 × Trail Mug", "1 × Camp Blanket (Large)"],
      confirmLabel: "Cancel order",
    });
    expect(result.json.note).toMatch(/Nothing has been changed yet/);
    const admin = given.admin as ReturnType<typeof adminApi>;
    expect(operations(admin)).not.toContain("ShopiAssistOrderCancel");
  });

  it("never starts a change from an order number alone", async () => {
    // Number-only lookups are on in this store, but they are for status only.
    for (const [name, args] of [
      ["cancel_order", { orderNumber: "1005", reason: "Changed my mind" }],
      ["change_delivery_address", { orderNumber: "1005" }],
      ["change_order_items", { orderNumber: "1005" }],
    ] as const) {
      const stranger = context(shopifyOrder(), { knownOrders: [] });
      const result = await run(name, args, stranger);
      expect(result.json.error).toMatch(/email address or the phone number used on the order is needed/);
      expect(result.actions).toEqual([]);
      expect(granted).toEqual([]);
      // Nothing about the order was even read.
      expect((stranger.admin as ReturnType<typeof adminApi>).calls).toHaveLength(0);
    }

    // With proof, the same shopper gets the card.
    const proved = await run(
      "cancel_order",
      { orderNumber: "1005", email: "buyer@example.com", reason: "Changed my mind" },
      context(shopifyOrder(), { knownOrders: [] }),
    );
    expect(card(proved.actions).kind).toBe("cancel");
  });

  it("tells the assistant when it is too late, and points to a return", async () => {
    const shipped = shopifyOrder({ displayFulfillmentStatus: "FULFILLED", fulfillments: [{ status: "SUCCESS" }] });
    for (const [name, args] of [
      ["cancel_order", { orderNumber: "1005", reason: "Changed my mind" }],
      ["change_delivery_address", { orderNumber: "1005" }],
      ["change_order_items", { orderNumber: "1005", items: [{ variantId: "101", quantity: 1 }] }],
    ] as const) {
      const result = await run(name, args, context(shipped));
      expect(result.json.error).toMatch(/already being prepared or has shipped/);
      expect(result.json.error).toMatch(/ask for a return/);
      expect(result.actions).toEqual([]);
    }
    expect(granted).toEqual([]);
  });

  it("turns a paid order's cancellation into a request to the store", async () => {
    const paid = shopifyOrder({ displayFinancialStatus: "PAID", totalReceivedSet: set("125.0") });
    const result = await run("cancel_order", { orderNumber: "1005", reason: "Too late" }, context(paid));

    expect(granted[0].kind).toBe("cancel_request");
    expect(card(result.actions)).toMatchObject({
      kind: "cancel_request",
      title: "Ask the store to cancel order #1005?",
      confirmLabel: "Send request",
    });
    expect(result.json.note).toMatch(/never promise a refund/);
  });

  it("change_delivery_address opens a form locked to the order's country", async () => {
    const result = await run("change_delivery_address", { orderNumber: "#1005" }, context());

    expect(granted).toEqual([
      { orderId: ORDER_ID, orderName: "#1005", kind: "address", countryCode: "US" },
    ]);
    expect(card(result.actions)).toMatchObject({
      kind: "address",
      countryCode: "US",
      confirmLabel: "Enter new address",
    });
    expect(result.json.note).toMatch(/Do not ask for the address in the chat/);
  });

  it("change_order_items lists the order, then proposes exactly the change asked for", async () => {
    const listed = await run("change_order_items", { orderNumber: "1005" }, context());
    expect(listed.json.items).toEqual([
      { item: "Trail Mug", quantity: 2, variantId: "101", unitPrice: "18.0 USD" },
      { item: "Camp Blanket (Large)", quantity: 1, variantId: "103", unitPrice: "89.0 USD" },
    ]);
    expect(listed.actions).toEqual([]);

    const storefront = routedGraphql({
      ShopiAssistVariantsForOrder: () => ({
        nodes: [
          {
            id: "gid://shopify/ProductVariant/202",
            title: "Default Title",
            availableForSale: true,
            price: usd("42.0"),
            product: { title: "Camp Kettle" },
          },
        ],
      }),
    });
    const changed = await run(
      "change_order_items",
      {
        orderNumber: "1005",
        items: [
          { variantId: "101", quantity: 3 },
          { variantId: "103", quantity: 0 },
          { variantId: "202", quantity: 1 },
        ],
      },
      context(shopifyOrder(), { storefront }),
    );

    expect(granted[0]).toEqual({
      orderId: ORDER_ID,
      orderName: "#1005",
      kind: "edit",
      changes: [
        { variantId: "101", quantity: 3 },
        { variantId: "103", quantity: 0 },
        { variantId: "202", quantity: 1 },
      ],
    });
    expect(card(changed.actions)).toMatchObject({
      kind: "edit",
      lines: ["3 × Trail Mug (was 2)", "1 × Camp Kettle (added)", "Removed: Camp Blanket (Large)"],
      confirmLabel: "Confirm change",
    });
    // 3 x 18 + 1 x 42
    expect(changed.json.estimatedItemsTotal).toBe("96.0 USD");
    // Only the new item is looked up, and it must be a published, in-stock one.
    expect(storefront.calls[0].variables).toEqual({
      ids: ["gid://shopify/ProductVariant/202"],
      country: "US",
    });
  });

  it("refuses item changes that make no sense", async () => {
    const same = await run(
      "change_order_items",
      { orderNumber: "1005", items: [{ variantId: "101", quantity: 2 }] },
      context(),
    );
    expect(same.json.error).toMatch(/already like that/);

    const empty = await run(
      "change_order_items",
      { orderNumber: "1005", items: [{ variantId: "101", quantity: 0 }, { variantId: "103", quantity: 0 }] },
      context(),
    );
    expect(empty.json.error).toMatch(/offer to cancel the order instead/);

    const madeUp = await run(
      "change_order_items",
      { orderNumber: "1005", items: [{ variantId: "999", quantity: 1 }] },
      context(shopifyOrder(), {
        storefront: routedGraphql({ ShopiAssistVariantsForOrder: () => ({ nodes: [null] }) }),
      }),
    );
    expect(madeUp.json.error).toMatch(/Variant 999 is not in this order and is not a product of this store/);

    const paid = shopifyOrder({ displayFinancialStatus: "PAID", totalReceivedSet: set("125.0") });
    const paidChange = await run(
      "change_order_items",
      { orderNumber: "1005", items: [{ variantId: "101", quantity: 1 }] },
      context(paid),
    );
    expect(paidChange.json.error).toMatch(/has been paid, so its items cannot be changed/);
    expect(granted).toEqual([]);
  });
});
