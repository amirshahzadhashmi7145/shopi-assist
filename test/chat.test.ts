import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ChatError, handleChatTurn, type ChatTurnInput } from "../app/assistant/chat.server";
import { RateLimiter } from "../app/assistant/rate-limit";
import { getSettings, saveSettings } from "../app/assistant/settings.server";
import {
  deleteCustomerConversations,
  deleteShopData,
  getConversationTranscript,
  listConversations,
  purgeExpiredConversations,
} from "../app/assistant/store.server";
import { createTestDb } from "./helpers/db";
import { fakeGraphql, scriptedProvider, text } from "./helpers/fakes";

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
    expect(provider.requests[0].messages[0].content).toContain("order number and the email");
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
    expect(await getSettings("new-shop.myshopify.com", db)).toEqual({
      enabled: true,
      instructions: "",
      orderLookupEnabled: false,
      retentionDays: 30,
    });
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
