import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ChatError,
  handleChatTurn,
  maskForStorage,
  readCart,
  type ChatTurnInput,
} from "../app/assistant/chat.server";
import { DailyBudget, RateLimiter } from "../app/assistant/rate-limit";
import { defineTool } from "../app/assistant/tools/registry";
import { z } from "zod";
import {
  DEFAULT_SETTINGS,
  describeQuickPolicies,
  getSettings,
  getSetupState,
  markSetupCompleted,
  markSetupStarted,
  saveSettings,
  settingsFromForm,
  setupProgress,
} from "../app/assistant/settings.server";
import {
  countConversationsSince,
  deleteCustomerConversations,
  deleteShopData,
  getConversationTranscript,
  listConversations,
  purgeAllExpiredConversations,
  purgeExpiredConversations,
  knownOrders,
  recentMessages,
  rememberOrder,
} from "../app/assistant/store.server";
import { createTestDb } from "./helpers/db";
import { callTool, fakeGraphql, scriptedProvider, text } from "./helpers/fakes";

const SHOP_A = "shop-a.myshopify.com";
const SHOP_B = "shop-b.myshopify.com";
const VISITOR = "visitor-0001";

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

const turn = (
  overrides: Partial<ChatTurnInput> = {},
  deps: Parameters<typeof handleChatTurn>[1] = {},
) =>
  handleChatTurn(
    {
      shop: SHOP_A,
      audience: "shopper",
      visitorId: VISITOR,
      message: "hello",
      storefront: fakeGraphql({}),
      ...overrides,
    },
    {
      db,
      provider: scriptedProvider([text("Hi! How can I help?")]),
      rateLimiter: new RateLimiter(),
      tokenBudget: new DailyBudget(),
      ...deps,
    },
  );

const expectChatError = async (promise: Promise<unknown>, code: string, status: number) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ChatError);
  expect((error as ChatError).code).toBe(code);
  expect((error as ChatError).status).toBe(status);
};

describe("handleChatTurn", () => {
  it("turns a question's answers into buttons only for a widget that can draw them", async () => {
    const listed =
      "What is the reason for the return? You can choose from these options:\n\n- Changed my mind\n- Too big\n- Other";
    const provider = () => scriptedProvider([text(listed)]);

    // An older widget, still open in a shopper's browser, says nothing about
    // buttons: it gets the reply exactly as written, answers included.
    const old = await turn({ message: "1012" }, { provider: provider() });
    expect(old.reply).toBe(listed);
    expect(old.actions).toEqual([]);

    // Anything but a short list of plain names counts as saying nothing.
    for (const supports of ["choices", [42], [{ choices: true }], ["CHOICES!"]]) {
      const odd = await turn({ message: "1012", supports }, { provider: provider() });
      expect(odd.reply).toBe(listed);
    }

    const current = await turn({ message: "1012", supports: ["choices"] }, { provider: provider() });
    expect(current.reply).toBe("What is the reason for the return?");
    expect(current.actions).toEqual([
      { type: "choices", options: ["Changed my mind", "Too big", "Other"], other: true },
    ]);
    // The model still sees what it offered: the saved reply keeps the list.
    const transcript = await getConversationTranscript(db, SHOP_A, current.conversationId);
    expect(transcript!.messages.at(-1)!.content).toBe(listed);

    // A plain yes-or-no question gets its two buttons the same way.
    const yesNo = await turn(
      { message: "ok", supports: ["choices"] },
      { provider: scriptedProvider([text("It has not shipped yet. Would you like to cancel it instead?")]) },
    );
    expect(yesNo.actions).toEqual([{ type: "choices", options: ["Yes", "No"], other: true }]);
    expect(yesNo.reply).toBe("It has not shipped yet. Would you like to cancel it instead?");
  });

  it("offers a signed-in shopper only the orders that can be returned right now", async () => {
    await saveSettings(
      SHOP_A,
      { orderLookupEnabled: true, recogniseCustomers: true, allowReturns: true },
      db,
    );
    const order = (number: number) => ({ id: `gid://shopify/Order/${number}`, name: `#${number}` });
    const returnChecks: string[] = [];
    // Their account has three orders; #3002 has not shipped.
    const admin = (async (query: string, variables?: Record<string, unknown>) => {
      if (query.includes("ShopiAssistCustomerOrders")) {
        return { orders: { nodes: [order(3001), order(3002), order(3003)] } };
      }
      if (query.includes("ShopiAssistReturnableOrder")) {
        const id = String(variables!.orderId);
        returnChecks.push(id);
        const shipped = !id.endsWith("/3002");
        return {
          order: { name: "x", cancelledAt: null, returnStatus: "NO_RETURN", fulfillments: shipped ? [{ id: "f" }] : [] },
          returnableFulfillments: {
            nodes: shipped
              ? [
                  {
                    returnableFulfillmentLineItems: {
                      nodes: [{ quantity: 1, fulfillmentLineItem: { lineItem: { title: "Trail Mug" } } }],
                    },
                  },
                ]
              : [],
          },
        };
      }
      return { shop: { name: "Shop A" } };
    }) as NonNullable<ChatTurnInput["admin"]>;
    const ask = (reply: string, visitorId: string) =>
      turn(
        { message: "i want to return an order", customerId: "7100", admin, supports: ["choices"], visitorId },
        { provider: scriptedProvider([text(reply)]) },
      );

    const forReturn = await ask("Which order would you like to return?", "visitor-return-1");
    expect(forReturn.actions).toEqual([{ type: "choices", options: ["#3001", "#3003"], other: true }]);
    expect(returnChecks).toHaveLength(3);

    // Any other question about their orders offers them all, and asks Shopify nothing more.
    const other = await ask("Which order do you mean?", "visitor-return-2");
    expect(other.actions).toEqual([
      { type: "choices", options: ["#3001", "#3002", "#3003"], other: true },
    ]);
    expect(returnChecks).toHaveLength(3);
  });

  it("answers again when the model asks a known shopper for an email or phone number", async () => {
    await saveSettings(SHOP_A, { orderLookupEnabled: true, recogniseCustomers: true }, db);
    const admin = () =>
      fakeGraphql({
        shop: { name: "Shop A" },
        orders: { nodes: [{ id: "gid://shopify/Order/4001", name: "#4001" }] },
      });
    const asking = "I'll need to confirm the order is yours. Could you give me the email address or phone number used on it?";
    const usage = { inputTokens: 100, outputTokens: 10 };

    // Signed in, the order is on their account: the draft is not sent.
    const corrected = scriptedProvider([
      { ...text(asking), usage },
      { ...text("What is the reason for the return?"), usage },
    ]);
    const result = await turn(
      { message: "it is damaged", customerId: "7200", admin: admin() },
      { provider: corrected },
    );
    expect(result.reply).toBe("What is the reason for the return?");
    expect(corrected.requests).toHaveLength(2);
    const [first, second] = corrected.requests.map((request) => request.messages[0].content as string);
    expect(first).not.toMatch(/Correction:/);
    expect(second).toMatch(/Correction: your draft reply asked the shopper for an email address or phone number/);
    expect(second.startsWith(first)).toBe(true);
    // Only what was sent to the shopper is kept.
    const transcript = await getConversationTranscript(db, SHOP_A, result.conversationId);
    expect(transcript!.messages.map((message) => message.content)).toEqual([
      "it is damaged",
      "What is the reason for the return?",
    ]);

    // An order number that is not one of theirs may well need proof: asking is right.
    const stranger = scriptedProvider([text(asking)]);
    const other = await turn(
      { message: "return order 9999", customerId: "7200", admin: admin(), visitorId: "visitor-proof-2" },
      { provider: stranger },
    );
    expect(other.reply).toBe(asking);
    expect(stranger.requests).toHaveLength(1);

    // So is asking a guest this chat knows nothing about.
    const guestProvider = scriptedProvider([text(asking)]);
    const guest = await turn(
      { message: "it is damaged", admin: admin(), visitorId: "visitor-proof-3" },
      { provider: guestProvider },
    );
    expect(guest.reply).toBe(asking);
    expect(guestProvider.requests).toHaveLength(1);
  });

  it("answers, creates a conversation and stores the exchange", async () => {
    const result = await turn({ message: "  hello  " });

    expect(result.reply).toBe("Hi! How can I help?");
    const transcript = await getConversationTranscript(db, SHOP_A, result.conversationId);
    expect(transcript!.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "hello"],
      ["assistant", "Hi! How can I help?"],
    ]);
  });

  it("sends earlier turns of the same conversation back to the model", async () => {
    const first = await turn({ message: "I like mugs" });
    const provider = scriptedProvider([text("Sure.")]);

    const second = await turn(
      { message: "show me some", conversationId: first.conversationId },
      { provider },
    );

    expect(second.conversationId).toBe(first.conversationId);
    expect(provider.requests[0].messages.slice(1)).toEqual([
      { role: "user", content: "I like mugs" },
      { role: "assistant", content: "Hi! How can I help?" },
      { role: "user", content: "show me some" },
    ]);
  });

  it("does not let another shop continue or read a conversation", async () => {
    const first = await turn({ message: "my secret question" });
    const provider = scriptedProvider([text("Hello from B.")]);

    const other = await turn(
      { shop: SHOP_B, conversationId: first.conversationId, message: "hi" },
      { provider },
    );

    expect(other.conversationId).not.toBe(first.conversationId);
    expect(JSON.stringify(provider.requests[0].messages)).not.toContain("my secret question");
    expect(await getConversationTranscript(db, SHOP_B, first.conversationId)).toBeNull();
    expect((await getConversationTranscript(db, SHOP_A, first.conversationId))!.messages).toHaveLength(2);
  });

  it("does not let another visitor of the same shop continue a conversation", async () => {
    const first = await turn({ message: "my secret question" });
    const provider = scriptedProvider([text("Hello.")]);

    const other = await turn(
      { visitorId: "visitor-9999", conversationId: first.conversationId, message: "hi" },
      { provider },
    );

    expect(other.conversationId).not.toBe(first.conversationId);
    expect(JSON.stringify(provider.requests[0].messages)).not.toContain("my secret question");
  });

  it("keeps shopper and merchant conversations apart", async () => {
    const shopper = await turn({ message: "shopper question" });
    const provider = scriptedProvider([text("Merchant answer.")]);

    const merchant = await turn(
      {
        audience: "merchant",
        conversationId: shopper.conversationId,
        admin: fakeGraphql({ shop: { name: "Shop A" } }),
        storefront: undefined,
      },
      { provider },
    );

    expect(merchant.conversationId).not.toBe(shopper.conversationId);
    // Merchant threads are not listed among shopper conversations.
    const listed = await listConversations(db, SHOP_A, { audience: "shopper" });
    expect(listed.map((c) => c.id)).toEqual([shopper.conversationId]);
  });

  it("gives each audience only its own tools", async () => {
    const shopperProvider = scriptedProvider([text("ok")]);
    await turn(
      { admin: fakeGraphql({ shop: { name: "Shop A" } }) },
      { provider: shopperProvider },
    );
    const shopperTools = shopperProvider.requests[0].tools.map((tool) => tool.name);
    expect(shopperTools).toContain("get_best_sellers");
    expect(shopperTools).not.toContain("get_top_selling_products");
    expect(shopperTools).not.toContain("get_order_status");

    const merchantProvider = scriptedProvider([text("ok")]);
    await turn(
      {
        audience: "merchant",
        admin: fakeGraphql({ shop: { name: "Shop A" } }),
        storefront: undefined,
      },
      { provider: merchantProvider },
    );
    const merchantToolNames = merchantProvider.requests[0].tools.map((tool) => tool.name);
    expect(merchantToolNames).toContain("get_top_selling_products");
    expect(merchantToolNames).not.toContain("add_to_cart");
  });

  it("offers order lookup only after the merchant enables it", async () => {
    await saveSettings(
      SHOP_A,
      { enabled: true, instructions: "", orderLookupEnabled: true, retentionDays: 30 },
      db,
    );
    const provider = scriptedProvider([text("ok")]);
    await turn({ admin: fakeGraphql({ shop: { name: "Shop A" } }) }, { provider });

    expect(provider.requests[0].tools.map((tool) => tool.name)).toContain("get_order_status");
    expect(provider.requests[0].messages[0].content).toContain("the order number and proof that it is theirs");
  });

  it("puts the merchant's guidance and the server-side shop name in the prompt", async () => {
    await saveSettings(
      SHOP_A,
      { enabled: true, instructions: "Always mention free shipping over $50.", orderLookupEnabled: false, retentionDays: 30 },
      db,
    );
    const provider = scriptedProvider([text("ok")]);
    await turn(
      { shop: SHOP_A, admin: fakeGraphql({ shop: { name: "Alpine Outfitters" } }) },
      { provider, now: () => new Date("2031-01-01T00:00:00Z") },
    );

    const system = provider.requests[0].messages[0].content as string;
    expect(system).toContain("Alpine Outfitters");
    expect(system).toContain("Always mention free shipping over $50.");
  });

  it("teaches the assistant what the merchant wrote in setup", async () => {
    await saveSettings(
      SHOP_A,
      {
        businessDescription: "Small-batch snowboards for beginners.",
        returnPolicy: "30 days, unused, free return label.",
        shippingInfo: "Ships next business day from Calgary.",
        faq: "Do you wax boards? Yes, free on request.",
        assistantName: "Ava",
        tone: "professional",
      },
      db,
    );
    const provider = scriptedProvider([text("ok")]);
    await turn({}, { provider });

    const system = provider.requests[0].messages[0].content as string;
    expect(system).toContain("You are Ava, the shopping assistant");
    expect(system).toContain("Polite, precise and businesslike");
    for (const fact of [
      "Small-batch snowboards for beginners.",
      "30 days, unused, free return label.",
      "Ships next business day from Calgary.",
      "Do you wax boards? Yes, free on request.",
    ]) {
      expect(system).toContain(fact);
    }
    // Owner notes come after the fixed rules, which they cannot override.
    expect(system.indexOf("Rules:")).toBeLessThan(system.indexOf("Notes from the store owner"));
  });

  it("gives the assistant only the abilities the merchant ticked", async () => {
    const names = async () => {
      const provider = scriptedProvider([text("ok")]);
      await turn({ admin: fakeGraphql({ shop: { name: "Shop A" } }) }, { provider });
      return {
        tools: provider.requests[0].tools.map((tool) => tool.name),
        system: provider.requests[0].messages[0].content as string,
      };
    };

    // Defaults: cart and checkout on, order status and returns off.
    const byDefault = await names();
    expect(byDefault.tools).toEqual(
      expect.arrayContaining(["add_to_cart", "place_order", "start_checkout"]),
    );
    expect(byDefault.system).toContain("start the order in that same reply");
    expect(byDefault.system).toContain("never say an order has been placed");
    expect(byDefault.tools).not.toContain("request_return");
    expect(byDefault.tools).not.toContain("get_order_status");
    expect(byDefault.system).toContain("you cannot start a return");

    await saveSettings(
      SHOP_A,
      { allowAddToCart: false, allowCheckout: false, allowReturns: true, returnWindow: "14" },
      db,
    );
    const changed = await names();
    expect(changed.tools).not.toContain("add_to_cart");
    expect(changed.tools).not.toContain("start_checkout");
    expect(changed.tools).not.toContain("place_order");
    expect(changed.system).not.toContain("pay on delivery");

    // Pay-on-delivery orders are opt-in and ride on the checkout summary.
    expect(byDefault.system).not.toContain("pay on delivery");
    await saveSettings(SHOP_A, { allowAddToCart: true, allowCheckout: true, allowChatOrders: true }, db);
    expect((await names()).system).toContain("'Order here, pay on delivery' button");
    expect(changed.tools).toContain("request_return");
    expect(changed.system).toContain("You cannot add items to the cart");
    expect(changed.system).toContain("You cannot start a checkout");
    expect(changed.system).toContain("a return is a request the store will review");
    expect(changed.system).toContain("Returns: accepted within 14 days of delivery.");
  });

  it("remembers a proved order, so follow-up questions need no email", async () => {
    await saveSettings(SHOP_A, { orderLookupEnabled: true }, db);
    const shopifyOrder = {
      id: "gid://shopify/Order/1001",
      name: "#1001",
      email: "buyer@example.com",
      processedAt: "2026-11-10T09:00:00Z",
      cancelledAt: null,
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "FULFILLED",
      fulfillments: [],
    };
    // One answer that serves both the shop-name lookup and the order lookup.
    const admin = () =>
      fakeGraphql({ shop: { name: "Shop A" }, orders: { nodes: [shopifyOrder] } });

    // Turn 1: number and email, checked against Shopify.
    const first = await turn(
      { message: "1001 buyer@example.com", admin: admin() },
      {
        provider: scriptedProvider([
          callTool("get_order_status", { orderNumber: "1001", email: "buyer@example.com" }),
          text("Order #1001 is paid and fulfilled."),
        ]),
        rateLimiter: new RateLimiter(),
      },
    );
    expect(await knownOrders(db, SHOP_A, first.conversationId)).toEqual([
      { id: "gid://shopify/Order/1001", name: "#1001", source: "verified" },
    ]);

    // Turn 2: "where is it?" names no order, so the assistant is told which
    // order the chat has already proved and looks it up with the number alone.
    const provider = scriptedProvider([
      callTool("get_order_status", { orderNumber: "1001" }),
      text("It has shipped."),
    ]);
    await turn(
      { message: "where is it?", conversationId: first.conversationId, admin: admin() },
      { provider },
    );
    const system = provider.requests[0].messages[0].content as string;
    expect(system).toContain("it names no order number. #1001 (proved earlier in this chat) is an order already proved to be theirs");
    expect(system).toMatch(/the order number alone is enough/);
    const toolResult = provider.requests[1].messages.at(-1)!;
    expect(toolResult.content).toContain('"fulfillmentStatus":"FULFILLED"');

    // Another visitor's chat knows nothing about it.
    const other = scriptedProvider([text("ok")]);
    await turn({ visitorId: "visitor-0002", admin: admin() }, { provider: other });
    expect(other.requests[0].messages[0].content).not.toContain("#1001");
  });

  it("keeps known orders within their own shop and conversation", async () => {
    const mine = await turn();
    const order = { id: "gid://shopify/Order/5", name: "#1005", source: "placed" as const };
    await rememberOrder(db, SHOP_A, mine.conversationId, order);
    // Looking it up again later does not change how it became known.
    await rememberOrder(db, SHOP_A, mine.conversationId, { ...order, source: "verified" });

    expect(await knownOrders(db, SHOP_A, mine.conversationId)).toEqual([order]);
    expect(await knownOrders(db, SHOP_B, mine.conversationId)).toEqual([]);
    await expect(rememberOrder(db, SHOP_B, mine.conversationId, order)).rejects.toThrow(
      /does not belong/,
    );

    // Deleting the conversation takes its orders with it.
    await db.conversation.deleteMany({ where: { shop: SHOP_A } });
    expect(await db.conversationOrder.count()).toBe(0);
  });

  it("allows lookups by order number alone only when both order settings are on", async () => {
    const system = async () => {
      const provider = scriptedProvider([text("ok")]);
      await turn({ admin: fakeGraphql({ shop: { name: "Shop A" } }) }, { provider });
      return provider.requests[0].messages[0].content as string;
    };

    await saveSettings(SHOP_A, { orderLookupEnabled: false, orderLookupByNumber: true }, db);
    expect(await system()).toMatch(/you cannot look up orders/);

    await saveSettings(SHOP_A, { orderLookupEnabled: true, orderLookupByNumber: false }, db);
    expect(await system()).toMatch(/proof that it is theirs/);

    await saveSettings(SHOP_A, { orderLookupByNumber: true }, db);
    expect(await system()).toMatch(/with the order number alone, so look it up as soon as you have the number/);
  });

  it("recognises a signed-in customer's own orders, only when the merchant allows it", async () => {
    const adminFor = (name: string) =>
      fakeGraphql({
        shop: { name: "Shop A" },
        orders: { nodes: [{ id: `gid://shopify/Order/${name.slice(1)}`, name }] },
      });
    const prompt = async (overrides: Partial<ChatTurnInput>) => {
      const provider = scriptedProvider([text("ok")]);
      const admin = overrides.admin as ReturnType<typeof fakeGraphql>;
      await turn(overrides, { provider });
      return { system: provider.requests[0].messages[0].content as string, admin };
    };

    await saveSettings(SHOP_A, { orderLookupEnabled: true, recogniseCustomers: true }, db);
    const signedIn = await prompt({ customerId: "7001", admin: adminFor("#2001") });
    expect(signedIn.system).toContain("#2001 (on their account: they are signed in)");
    expect(signedIn.system).toMatch(/This shopper is signed in/);
    // Asked of Shopify by the customer id Shopify signed, and nothing else.
    expect(signedIn.admin.calls.at(-1)!.variables).toEqual({ query: "customer_id:7001" });

    // A guest gets no such list.
    const guest = await prompt({ visitorId: "visitor-0002", admin: adminFor("#2002") });
    expect(guest.system).not.toMatch(/signed in/);
    expect(guest.system).not.toContain("#2002");

    // Nor does anyone while the merchant has it switched off.
    await saveSettings(SHOP_A, { recogniseCustomers: false }, db);
    const off = await prompt({ visitorId: "visitor-0003", customerId: "7003", admin: adminFor("#2003") });
    expect(off.system).not.toContain("#2003");

    // Staff trying the assistant in the admin are not a customer.
    await saveSettings(SHOP_A, { recogniseCustomers: true }, db);
    const preview = await prompt({ preview: true, customerId: "7004", admin: adminFor("#2004") });
    expect(preview.system).not.toContain("#2004");
  });

  it("offers order changes only to shoppers on a server that can sign a grant", async () => {
    await saveSettings(
      SHOP_A,
      { allowOrderCancel: true, allowAddressChange: true, allowOrderEdit: true },
      db,
    );
    const tools = async (overrides: Partial<ChatTurnInput> = {}) => {
      const provider = scriptedProvider([text("ok")]);
      await turn({ admin: fakeGraphql({ shop: { name: "Shop A" } }), ...overrides }, { provider });
      return provider.requests[0].tools.map((tool) => tool.name);
    };
    const changes = ["cancel_order", "change_delivery_address", "change_order_items"];
    const before = process.env.SHOPIFY_API_SECRET;

    try {
      process.env.SHOPIFY_API_SECRET = "test-signing-secret";
      expect(await tools()).toEqual(expect.arrayContaining(changes));
      // The admin's "try it as a shopper" chat cannot change real orders.
      for (const name of changes) expect(await tools({ preview: true })).not.toContain(name);

      delete process.env.SHOPIFY_API_SECRET;
      for (const name of changes) expect(await tools({ visitorId: "visitor-0009" })).not.toContain(name);
    } finally {
      if (before === undefined) delete process.env.SHOPIFY_API_SECRET;
      else process.env.SHOPIFY_API_SECRET = before;
    }
  });

  it("passes the shopper's cart to the assistant, and only a well-formed one", async () => {
    const system = async (overrides: Partial<ChatTurnInput>) => {
      const provider = scriptedProvider([text("ok")]);
      await turn(overrides, { provider });
      return {
        prompt: provider.requests[0].messages[0].content as string,
        tools: provider.requests[0].tools.map((tool) => tool.name),
      };
    };

    const seen = await system({ cart: [{ variantId: "101", title: "Trail Mug", quantity: 2 }] });
    expect(seen.prompt).toContain("- 2 x Trail Mug [variantId 101]");
    expect(seen.tools).toEqual(expect.arrayContaining(["remove_from_cart", "clear_cart"]));

    expect((await system({})).prompt).toMatch(/you cannot see what is in it/);
    expect((await system({ cart: "2 x free stuff" })).prompt).toMatch(/you cannot see what is in it/);

    // Staff in the admin have no storefront cart, whatever the request says.
    const merchant = await system({
      audience: "merchant",
      admin: fakeGraphql({ shop: { name: "Shop A" } }),
      cart: [{ variantId: "101", title: "Trail Mug", quantity: 2 }],
    });
    expect(merchant.prompt).not.toContain("Trail Mug");
  });

  it("reads a cart strictly", () => {
    expect(readCart([{ variantId: "101", title: "Mug", quantity: 2 }])).toEqual([
      { variantId: "101", title: "Mug", quantity: 2 },
    ]);
    expect(readCart([])).toEqual([]);
    expect(readCart([{ variantId: "101", title: "x".repeat(500), quantity: 1 }])![0].title).toHaveLength(120);
    expect(readCart(Array.from({ length: 50 }, () => ({ variantId: "1", title: "a", quantity: 1 })))).toHaveLength(20);

    for (const bad of [
      undefined,
      null,
      "cart",
      {},
      [null],
      [{ variantId: 101, title: "Mug", quantity: 1 }],
      [{ variantId: "101; DROP", title: "Mug", quantity: 1 }],
      [{ variantId: "101", title: "Mug", quantity: 0 }],
      [{ variantId: "101", title: "Mug", quantity: 1.5 }],
      [{ variantId: "101", quantity: 1 }],
    ]) {
      expect(readCart(bad)).toBeUndefined();
    }
  });

  it("removes one-click add from product cards when add to cart is off", async () => {
    const product = {
      id: "gid://shopify/Product/1",
      title: "Trail Mug",
      handle: "trail-mug",
      vendor: "",
      productType: "",
      availableForSale: true,
      onlineStoreUrl: null,
      description: "",
      featuredImage: null,
      priceRange: {
        minVariantPrice: { amount: "18.0", currencyCode: "USD" },
        maxVariantPrice: { amount: "18.0", currencyCode: "USD" },
      },
      compareAtPriceRange: { maxVariantPrice: { amount: "0.0", currencyCode: "USD" } },
      variants: { nodes: [{ id: "gid://shopify/ProductVariant/101", availableForSale: true }] },
    };
    const ask = () =>
      turn(
        { storefront: fakeGraphql({ products: { nodes: [product] } }) },
        {
          provider: scriptedProvider([
            { content: null, toolCalls: [{ id: "c1", name: "get_best_sellers", arguments: "{}" }] },
            text("Try the Trail Mug."),
          ]),
        },
      );

    expect((await ask()).cards[0].variantId).toBe("101");
    await saveSettings(SHOP_A, { allowAddToCart: false }, db);
    const off = await ask();
    expect(off.cards[0]).toMatchObject({ title: "Trail Mug", variantId: null });
  });

  it("runs a staff preview as a shopper but keeps it out of the conversation log", async () => {
    await saveSettings(SHOP_A, { enabled: false }, db);
    const provider = scriptedProvider([text("Preview answer.")]);

    const preview = await turn(
      { preview: true, visitorId: "preview-staff-1", message: "best sellers?" },
      { provider },
    );

    // Same tools as a real shopper: nothing merchant-only.
    const toolNames = provider.requests[0].tools.map((tool) => tool.name);
    expect(toolNames).toContain("get_best_sellers");
    expect(toolNames).not.toContain("get_top_selling_products");
    // Works even while chat is paused for real shoppers.
    expect(preview.reply).toBe("Preview answer.");
    await expectChatError(turn({ message: "hi" }), "disabled", 403);

    expect(await listConversations(db, SHOP_A, { audience: "shopper" })).toEqual([]);
    expect(await countConversationsSince(db, SHOP_A, new Date(0))).toBe(0);
    const row = await db.conversation.findUnique({ where: { id: preview.conversationId } });
    expect(row!.isPreview).toBe(true);
  });

  it("does not let a shopper pose as a preview or reach a preview conversation", async () => {
    const preview = await turn({ preview: true, visitorId: "preview-staff-1", message: "staff note" });
    const provider = scriptedProvider([text("Hello.")]);

    // A real shopper sends the same visitor id and the preview's conversation id.
    const shopper = await turn(
      { visitorId: "preview-staff-1", conversationId: preview.conversationId, message: "hi" },
      { provider },
    );

    expect(shopper.conversationId).not.toBe(preview.conversationId);
    expect(JSON.stringify(provider.requests[0].messages)).not.toContain("staff note");
    // And their conversation is logged like any other shopper's.
    const listed = await listConversations(db, SHOP_A, { audience: "shopper" });
    expect(listed.map((c) => c.id)).toEqual([shopper.conversationId]);
  });

  it("refuses shoppers when the merchant paused chat, but not the merchant", async () => {
    await saveSettings(
      SHOP_A,
      { enabled: false, instructions: "", orderLookupEnabled: false, retentionDays: 30 },
      db,
    );

    await expectChatError(turn(), "disabled", 403);
    const merchant = await turn({ audience: "merchant", admin: fakeGraphql({ shop: { name: "A" } }) });
    expect(merchant.reply).toBeTruthy();
  });

  it("reports a clear error when no model is configured", async () => {
    await expectChatError(turn({}, { provider: null }), "not_configured", 503);
  });

  it("validates the message and visitor id", async () => {
    await expectChatError(turn({ message: "   " }), "invalid_request", 400);
    await expectChatError(turn({ message: "x".repeat(2001) }), "invalid_request", 400);
    await expectChatError(turn({ message: { $ne: "" } }), "invalid_request", 400);
    await expectChatError(turn({ visitorId: "short" }), "invalid_request", 400);
    await expectChatError(turn({ visitorId: "../../etc/passwd" }), "invalid_request", 400);
  });

  it("rate limits a single address without affecting others", async () => {
    const rateLimiter = new RateLimiter();
    const now = () => new Date("2026-11-18T12:00:00Z");
    const fromIp = (ip: string) => turn({ ip }, { rateLimiter, now });

    for (let i = 0; i < 12; i += 1) await fromIp("203.0.113.7");

    await expectChatError(fromIp("203.0.113.7"), "rate_limited", 429);
    expect((await fromIp("198.51.100.4")).reply).toBeTruthy();
  });

  it("stops one address long before it can use up the shop's hourly budget", async () => {
    const rateLimiter = new RateLimiter();
    let clock = Date.parse("2026-11-18T12:00:00Z");
    const now = () => new Date(clock);
    const abuser = () => turn({ ip: "203.0.113.7" }, { rateLimiter, now });

    let accepted = 0;
    // 12 a minute for an hour would be 720 turns without an hourly limit.
    for (let minute = 0; minute < 59; minute += 1) {
      for (let i = 0; i < 12; i += 1) {
        await abuser().then(
          () => (accepted += 1),
          () => undefined,
        );
      }
      clock += 60_000;
    }

    expect(accepted).toBe(60);
    // Everyone else can still chat: the shop-wide bucket was barely touched.
    for (let i = 0; i < 100; i += 1) {
      const other = await turn({ ip: `198.51.100.${i}` }, { rateLimiter, now });
      expect(other.reply).toBeTruthy();
    }
  });

  it("groups IPv6 addresses in one /64 under a single limit", async () => {
    const rateLimiter = new RateLimiter();
    const now = () => new Date("2026-11-18T12:00:00Z");
    for (let i = 0; i < 12; i += 1) {
      await turn({ ip: `2001:db8:1:2::${i.toString(16)}` }, { rateLimiter, now });
    }

    await expectChatError(
      turn({ ip: "2001:db8:1:2:ffff:ffff:ffff:ffff" }, { rateLimiter, now }),
      "rate_limited",
      429,
    );
    expect((await turn({ ip: "2001:db8:1:3::1" }, { rateLimiter, now })).reply).toBeTruthy();
  });

  it("enforces a daily cap per shop", async () => {
    process.env.CHAT_LIMIT_PER_SHOP_PER_DAY = "3";
    try {
      const rateLimiter = new RateLimiter();
      const now = () => new Date("2026-11-18T12:00:00Z");
      for (let i = 0; i < 3; i += 1) await turn({ ip: `198.51.100.${i}` }, { rateLimiter, now });

      await expectChatError(turn({ ip: "198.51.100.50" }, { rateLimiter, now }), "rate_limited", 429);
      // Another shop has its own cap.
      expect((await turn({ shop: SHOP_B, ip: "198.51.100.51" }, { rateLimiter, now })).reply).toBeTruthy();
    } finally {
      delete process.env.CHAT_LIMIT_PER_SHOP_PER_DAY;
    }
  });

  it("stops all chat once the daily token budget is spent, and resumes the next day", async () => {
    process.env.LLM_DAILY_TOKEN_BUDGET = "1000";
    try {
      const tokenBudget = new DailyBudget();
      const costly = () =>
        scriptedProvider([{ ...text("ok"), usage: { inputTokens: 700, outputTokens: 100 } }]);
      const day1 = () => new Date("2026-11-18T12:00:00Z");

      await turn({}, { tokenBudget, provider: costly(), now: day1 });
      await turn({ shop: SHOP_B }, { tokenBudget, provider: costly(), now: day1 });

      // 1,600 tokens used against a 1,000 budget: refused for every shop.
      await expectChatError(turn({}, { tokenBudget, now: day1 }), "over_capacity", 503);
      await expectChatError(turn({ shop: SHOP_B }, { tokenBudget, now: day1 }), "over_capacity", 503);

      const day2 = () => new Date("2026-11-19T00:00:01Z");
      expect((await turn({}, { tokenBudget, now: day2 })).reply).toBeTruthy();
    } finally {
      delete process.env.LLM_DAILY_TOKEN_BUDGET;
    }
  });

  it("gives shopper tools no Admin API client unless order lookup is on", async () => {
    const seen: Array<{ admin: boolean; storefront: boolean }> = [];
    const probe = defineTool({
      name: "probe",
      description: "records which API clients a shopper tool can reach",
      audiences: ["shopper", "merchant"],
      schema: z.object({}),
      async run(_args, context) {
        seen.push({ admin: Boolean(context.admin), storefront: Boolean(context.storefront) });
        return { output: {} };
      },
    });
    const callProbe = () =>
      scriptedProvider([
        { content: null, toolCalls: [{ id: "c1", name: "probe", arguments: "{}" }] },
        text("done"),
      ]);
    const admin = () => fakeGraphql({ shop: { name: "Shop A" } });

    await turn({ admin: admin() }, { provider: callProbe(), tools: [probe] });
    expect(seen.at(-1)).toEqual({ admin: false, storefront: true });

    await saveSettings(
      SHOP_A,
      { enabled: true, instructions: "", orderLookupEnabled: true, retentionDays: 30 },
      db,
    );
    await turn({ admin: admin() }, { provider: callProbe(), tools: [probe] });
    expect(seen.at(-1)).toEqual({ admin: true, storefront: true });

    await turn(
      { audience: "merchant", admin: admin(), storefront: undefined },
      { provider: callProbe(), tools: [probe] },
    );
    expect(seen.at(-1)).toEqual({ admin: true, storefront: false });
  });

  it("masks email addresses before a transcript is stored", async () => {
    const provider = scriptedProvider([text("Thanks, I found the order for jane.doe@example.com.")]);
    const result = await turn(
      { message: "My order is #1001 and my email is Jane.Doe@Example.com" },
      { provider },
    );

    // The model needs the address for this turn...
    expect(JSON.stringify(provider.requests[0].messages)).toContain("Jane.Doe@Example.com");
    // ...but it is never written to the database.
    const stored = await db.message.findMany({ where: { conversationId: result.conversationId } });
    expect(stored.map((m) => m.content)).toEqual([
      "My order is #1001 and my email is [email removed]",
      "Thanks, I found the order for [email removed].",
    ]);
    expect(maskForStorage("a@b.co, c.d+tag@sub.example.org!")).toBe(
      "[email removed], [email removed]!",
    );
  });

  it("abandons a turn whose deadline has passed", async () => {
    const original = AbortSignal.timeout;
    AbortSignal.timeout = () => AbortSignal.abort();
    try {
      const provider = scriptedProvider([text("too late")]);
      await expectChatError(turn({}, { provider }), "assistant_failed", 502);
      expect(provider.requests).toHaveLength(0);
    } finally {
      AbortSignal.timeout = original;
    }
  });

  it("stores nothing when the model call fails", async () => {
    const failing = {
      name: "failing",
      complete: async () => {
        throw new Error("upstream 500 with key fake-key-value");
      },
    };

    const error = await turn({}, { provider: failing }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ChatError);
    expect((error as ChatError).code).toBe("assistant_failed");
    expect((error as ChatError).message).not.toContain("fake-key-value");
    expect(await db.message.count()).toBe(0);
  });

  it("records the logged-in customer for later redaction", async () => {
    const result = await turn({ customerId: "777" });
    const row = await db.conversation.findUnique({ where: { id: result.conversationId } });
    expect(row!.customerId).toBe("777");
  });
});

describe("data lifecycle", () => {
  it("purges conversations past the retention period for one shop only", async () => {
    const old = new Date("2026-09-01T00:00:00Z");
    const recent = new Date("2026-11-17T00:00:00Z");
    const make = (shop: string, updatedAt: Date) =>
      db.conversation.create({
        data: {
          shop,
          audience: "shopper",
          visitorId: VISITOR,
          updatedAt,
          messages: { create: [{ role: "user", content: "hi" }] },
        },
      });
    await make(SHOP_A, old);
    await make(SHOP_A, recent);
    await make(SHOP_B, old);

    const removed = await purgeExpiredConversations(db, SHOP_A, 30, new Date("2026-11-18T00:00:00Z"));

    expect(removed).toBe(1);
    expect(await db.conversation.count({ where: { shop: SHOP_A } })).toBe(1);
    expect(await db.conversation.count({ where: { shop: SHOP_B } })).toBe(1);
    // Messages go with their conversation.
    expect(await db.message.count()).toBe(2);
  });

  it("the scheduled sweep applies each shop's own retention period", async () => {
    const tenDaysAgo = new Date("2026-11-08T00:00:00Z");
    const make = (shop: string) =>
      db.conversation.create({
        data: { shop, audience: "shopper", visitorId: VISITOR, updatedAt: tenDaysAgo },
      });
    await saveSettings(SHOP_A, { enabled: true, instructions: "", orderLookupEnabled: false, retentionDays: 7 }, db);
    await make(SHOP_A); // 7-day retention: expired
    await make(SHOP_B); // no settings, default 30 days: kept

    const removed = await purgeAllExpiredConversations(db, 30, new Date("2026-11-18T00:00:00Z"));

    expect(removed).toBe(1);
    expect(await db.conversation.count({ where: { shop: SHOP_A } })).toBe(0);
    expect(await db.conversation.count({ where: { shop: SHOP_B } })).toBe(1);
  });

  it("message history cannot be read with another shop's name", async () => {
    const result = await turn({ message: "private" });

    expect(await recentMessages(db, SHOP_A, result.conversationId, 20)).toHaveLength(2);
    expect(await recentMessages(db, SHOP_B, result.conversationId, 20)).toEqual([]);
  });

  it("customers/redact removes only that customer's conversations in that shop", async () => {
    await turn({ customerId: "777", message: "mine" });
    await turn({ customerId: "888", visitorId: "visitor-0002", message: "someone else" });
    await turn({ shop: SHOP_B, customerId: "777", message: "same id, other shop" });

    const removed = await deleteCustomerConversations(db, SHOP_A, "777");

    expect(removed).toBe(1);
    expect(await db.conversation.count({ where: { shop: SHOP_A } })).toBe(1);
    expect(await db.conversation.count({ where: { shop: SHOP_B } })).toBe(1);
  });

  it("shop/redact removes everything for the shop and nothing else", async () => {
    await saveSettings(SHOP_A, { enabled: true, instructions: "x", orderLookupEnabled: false, retentionDays: 10 }, db);
    await turn({ message: "a" });
    await turn({ shop: SHOP_B, message: "b" });

    await deleteShopData(db, SHOP_A);

    expect(await db.conversation.count({ where: { shop: SHOP_A } })).toBe(0);
    expect((await getSettings(SHOP_A, db)).retentionDays).toBe(30);
    expect(await db.conversation.count({ where: { shop: SHOP_B } })).toBe(1);
  });
});

describe("settings", () => {
  it("returns defaults for a shop with no saved settings", async () => {
    expect(await getSettings("new-shop.myshopify.com", db)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toMatchObject({
      enabled: true,
      orderLookupEnabled: false,
      retentionDays: 30,
      tone: "friendly",
      businessDescription: "",
    });
  });

  it("saves one setup step without touching the others", async () => {
    await saveSettings(SHOP_A, { businessDescription: "We sell snowboards." }, db);
    await saveSettings(SHOP_A, { returnPolicy: "30 days.", shippingInfo: "" }, db);
    await saveSettings(SHOP_A, { assistantName: "  Ava  ", tone: "playful" }, db);

    expect(await getSettings(SHOP_A, db)).toMatchObject({
      businessDescription: "We sell snowboards.",
      returnPolicy: "30 days.",
      assistantName: "Ava",
      tone: "playful",
      enabled: true,
      retentionDays: 30,
    });
    // Another shop is unaffected.
    expect((await getSettings(SHOP_B, db)).businessDescription).toBe("");
  });

  it("rejects an unknown tone and over-long answers", async () => {
    const result = await saveSettings(
      SHOP_A,
      { tone: "sarcastic", assistantName: "x".repeat(41), faq: "y".repeat(3001) },
      db,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(["assistantName", "faq", "tone"]);
    }
  });

  it("reads only the fields a page is allowed to change", () => {
    const form = new FormData();
    form.set("businessDescription", "Snowboards");
    form.set("retentionDays", "1");
    form.set("enabled", "on");
    form.set("shop", "victim.myshopify.com");

    expect(settingsFromForm(form, ["businessDescription"])).toEqual({
      businessDescription: "Snowboards",
    });
    expect(settingsFromForm(form, ["enabled", "orderLookupEnabled", "retentionDays"])).toEqual({
      enabled: true,
      orderLookupEnabled: false,
      retentionDays: 1,
    });
  });

  it("tracks the setup tour and reports progress from what is actually saved", async () => {
    expect(await getSetupState(SHOP_A, db)).toEqual({ started: false, completed: false });

    await markSetupStarted(SHOP_A, db);
    expect(await getSetupState(SHOP_A, db)).toEqual({ started: true, completed: false });
    // Opening the tour fills nothing in.
    expect(setupProgress(await getSettings(SHOP_A, db))).toEqual({
      policies: false,
      personality: false,
      details: false,
    });

    await saveSettings(SHOP_A, { returnWindow: "30" }, db);
    await markSetupCompleted(SHOP_A, db);
    expect(await getSetupState(SHOP_A, db)).toEqual({ started: true, completed: true });
    expect(setupProgress(await getSettings(SHOP_A, db))).toMatchObject({
      policies: true,
      personality: false,
    });
    // Starting the tour never wiped the saved pick.
    expect((await getSettings(SHOP_A, db)).returnWindow).toBe("30");
  });

  it("turns dropdown picks into plain sentences and says nothing for unset ones", async () => {
    expect(describeQuickPolicies(DEFAULT_SETTINGS)).toBe("");

    await saveSettings(
      SHOP_A,
      {
        returnWindow: "30",
        returnShipping: "free",
        processingTime: "same_day",
        deliveryTime: "5_8",
        shipsTo: "domestic",
      },
      db,
    );
    expect(describeQuickPolicies(await getSettings(SHOP_A, db)).split("\n")).toEqual([
      "Returns: accepted within 30 days of delivery.",
      "Return shipping: free for the customer.",
      "Dispatch: orders usually ship the same business day.",
      "Delivery: usually 5 to 8 business days after the order ships.",
      "Shipping area: the store's home country only. No international shipping.",
    ]);

    // "No returns" drops the return-shipping line, which would contradict it.
    await saveSettings(SHOP_A, { returnWindow: "none" }, db);
    const noReturns = describeQuickPolicies(await getSettings(SHOP_A, db));
    expect(noReturns).toContain("does not accept returns");
    expect(noReturns).not.toContain("Return shipping");
  });

  it("rejects a dropdown value that is not one of the choices", async () => {
    const result = await saveSettings(SHOP_A, { returnWindow: "45", shipsTo: "mars" }, db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors).sort()).toEqual(["returnWindow", "shipsTo"]);
  });

  it("rejects out-of-range values with a message per field", async () => {
    const result = await saveSettings(
      SHOP_A,
      { enabled: true, instructions: "x".repeat(2001), orderLookupEnabled: false, retentionDays: 0 },
      db,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.retentionDays).toMatch(/at least 1 day/);
      expect(result.errors.instructions).toMatch(/2,000/);
    }
    expect(await db.shopSettings.count()).toBe(0);
  });
});
