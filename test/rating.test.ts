import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatError } from "../app/assistant/chat.server";
import { RateLimiter } from "../app/assistant/rate-limit";
import { handleChatRating } from "../app/assistant/rating.server";
import { getSettings, saveSettings } from "../app/assistant/settings.server";
import {
  chatAnalytics,
  createConversation,
  getConversationTranscript,
  listConversations,
  ratingCounts,
} from "../app/assistant/store.server";
import { createTestDb } from "./helpers/db";

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

const chat = (shop = SHOP_A, visitorId = VISITOR, extra: { isPreview?: boolean } = {}) =>
  createConversation(db, { shop, audience: "shopper", visitorId, ...extra });
const rate = (
  body: Record<string, unknown>,
  shop = SHOP_A,
  rateLimiter = new RateLimiter(),
) => handleChatRating({ shop, body, ip: "203.0.113.7" }, { db, rateLimiter });
const refused = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ChatError);
  return error as ChatError;
};
const stored = async (id: string) =>
  (await db.conversation.findFirst({ where: { id }, select: { rating: true, ratedAt: true } }))!;

describe("chat ratings", () => {
  it("records a thumbs-up or thumbs-down on the shopper's own chat, and lets them change or take it back", async () => {
    const { id } = await chat();
    const before = (await db.conversation.findFirst({ where: { id } }))!.updatedAt;

    expect(await rate({ visitorId: VISITOR, conversationId: id, rating: "up" })).toEqual({
      ok: true,
      rating: "up",
    });
    expect(await stored(id)).toMatchObject({ rating: "up" });
    expect((await stored(id)).ratedAt).toBeInstanceOf(Date);
    // Rating a chat is not activity in it: it keeps its place and its retention clock.
    expect((await db.conversation.findFirst({ where: { id } }))!.updatedAt).toEqual(before);

    await rate({ visitorId: VISITOR, conversationId: id, rating: "down" });
    expect((await stored(id)).rating).toBe("down");

    await rate({ visitorId: VISITOR, conversationId: id, rating: null });
    expect(await stored(id)).toEqual({ rating: null, ratedAt: null });
  });

  it("only ever rates the chat of the visitor and shop that ask", async () => {
    const mine = await chat();
    const theirs = await chat(SHOP_A, "visitor-0002");
    const elsewhere = await chat(SHOP_B, VISITOR);
    const preview = await chat(SHOP_A, VISITOR, { isPreview: true });

    // Another visitor's chat, another shop's chat, the merchant's own test chat, or none.
    for (const conversationId of [theirs.id, elsewhere.id, preview.id, "nosuchconversation1"]) {
      const error = await refused(rate({ visitorId: VISITOR, conversationId, rating: "down" }));
      expect([error.code, error.status]).toEqual(["invalid_request", 404]);
    }
    // The shop comes from the signed request, never from the body.
    await refused(rate({ visitorId: VISITOR, conversationId: mine.id, rating: "down", shop: SHOP_A }, SHOP_B));
    for (const id of [mine.id, theirs.id, elsewhere.id, preview.id]) {
      expect((await stored(id)).rating).toBeNull();
    }
  });

  it("refuses anything that is not a rating", async () => {
    const { id } = await chat();
    for (const body of [
      { visitorId: VISITOR, conversationId: id, rating: "sideways" },
      { visitorId: VISITOR, conversationId: id },
      { visitorId: "x", conversationId: id, rating: "up" },
      { visitorId: VISITOR, conversationId: "../etc", rating: "up" },
      {},
    ]) {
      const error = await refused(rate(body));
      expect([error.code, error.status]).toEqual(["invalid_request", 400]);
    }
    expect((await stored(id)).rating).toBeNull();
  });

  it("is on unless the merchant switches it off, and stops with the chat", async () => {
    const { id } = await chat();
    expect((await getSettings(SHOP_A, db)).chatRatings).toBe(true);

    await saveSettings(SHOP_A, { chatRatings: false }, db);
    expect((await refused(rate({ visitorId: VISITOR, conversationId: id, rating: "up" }))).code).toBe("disabled");

    await saveSettings(SHOP_A, { chatRatings: true, enabled: false }, db);
    expect((await refused(rate({ visitorId: VISITOR, conversationId: id, rating: "up" }))).code).toBe("disabled");
    expect((await stored(id)).rating).toBeNull();
  });

  it("can be changed, but not hammered", async () => {
    const { id } = await chat();
    const rateLimiter = new RateLimiter();
    for (let press = 0; press < 30; press += 1) {
      await rate({ visitorId: VISITOR, conversationId: id, rating: press % 2 ? "up" : "down" }, SHOP_A, rateLimiter);
    }
    const error = await refused(rate({ visitorId: VISITOR, conversationId: id, rating: "up" }, SHOP_A, rateLimiter));
    expect([error.code, error.status]).toEqual(["rate_limited", 429]);
  });

  it("shows the merchant each chat's rating and the totals for their own shop", async () => {
    const good = await chat(SHOP_A, "visitor-0001");
    const bad = await chat(SHOP_A, "visitor-0002");
    await chat(SHOP_A, "visitor-0003");
    const other = await chat(SHOP_B, "visitor-0001");
    await rate({ visitorId: "visitor-0001", conversationId: good.id, rating: "up" });
    await rate({ visitorId: "visitor-0002", conversationId: bad.id, rating: "down" });
    await rate({ visitorId: "visitor-0001", conversationId: other.id, rating: "down" }, SHOP_B);

    expect(await ratingCounts(db, SHOP_A)).toEqual({ up: 1, down: 1 });
    expect(await ratingCounts(db, SHOP_B)).toEqual({ up: 0, down: 1 });
    const listed = await listConversations(db, SHOP_A);
    expect(listed.map((conversation) => conversation.rating).sort()).toEqual(["down", "up", null].sort());
    expect((await getConversationTranscript(db, SHOP_A, good.id))!.rating).toBe("up");
    // Another shop's chat is not there to be read, rated or not.
    expect(await getConversationTranscript(db, SHOP_A, other.id)).toBeNull();
  });
});

describe("chat analytics", () => {
  it("counts a shop's own storefront chats, and nothing else", async () => {
    const now = new Date("2026-11-24T15:00:00Z");
    const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    let visitor = 0;
    const started = async (
      when: Date,
      extra: { shop?: string; customerId?: string; rating?: string; isPreview?: boolean; audience?: string; messages?: number; order?: string } = {},
    ) => {
      visitor += 1;
      const row = await db.conversation.create({
        data: {
          shop: extra.shop ?? SHOP_A,
          audience: extra.audience ?? "shopper",
          visitorId: `visitor-${String(visitor).padStart(4, "0")}`,
          customerId: extra.customerId ?? null,
          rating: extra.rating ?? null,
          isPreview: extra.isPreview ?? false,
          createdAt: when,
        },
      });
      for (let index = 0; index < (extra.messages ?? 0); index += 1) {
        await db.message.create({ data: { conversationId: row.id, role: "user", content: "hi", createdAt: when } });
        await db.message.create({ data: { conversationId: row.id, role: "assistant", content: "hello", createdAt: when } });
      }
      if (extra.order) {
        await db.conversationOrder.create({
          data: {
            shop: row.shop,
            conversationId: row.id,
            orderId: `gid://shopify/Order/${visitor}`,
            orderName: `#${1000 + visitor}`,
            source: extra.order,
            createdAt: when,
          },
        });
      }
    };

    await started(now, { messages: 2, rating: "up", customerId: "7001", order: "placed" });
    await started(now, { messages: 1, rating: "down" });
    await started(daysAgo(1), { messages: 3, rating: "up", order: "verified" });
    await started(daysAgo(6), { messages: 1 });
    await started(daysAgo(10), { messages: 2, rating: "up", customerId: "7002", order: "placed" });
    // Not counted: too old, another shop, the merchant's own test chat, the merchant's assistant.
    await started(daysAgo(40), { messages: 5, rating: "down", order: "placed" });
    await started(now, { shop: SHOP_B, messages: 4, rating: "down", order: "placed" });
    await started(now, { isPreview: true, messages: 4, rating: "down" });
    await started(now, { audience: "merchant", messages: 4 });

    expect(await chatAnalytics(db, SHOP_A, now)).toEqual({
      conversations: { last7: 4, last30: 5 },
      // Only what shoppers wrote, in those five chats.
      shopperMessages: 9,
      signedIn: 2,
      ratings: { up: 3, down: 1 },
      // Placed through the chat, not just looked up in it.
      ordersPlaced: 2,
      perDay: [
        { date: "2026-11-18", count: 1 },
        { date: "2026-11-19", count: 0 },
        { date: "2026-11-20", count: 0 },
        { date: "2026-11-21", count: 0 },
        { date: "2026-11-22", count: 0 },
        { date: "2026-11-23", count: 1 },
        { date: "2026-11-24", count: 2 },
      ],
    });

    // A shop with nothing yet gets zeros and seven empty days.
    const empty = await chatAnalytics(db, "new-shop.myshopify.com", now);
    expect(empty.conversations).toEqual({ last7: 0, last30: 0 });
    expect(empty.perDay).toHaveLength(7);
    expect(empty.perDay.every((day) => day.count === 0)).toBe(true);
  });
});

describe("POST /proxy/rating", () => {
  it("takes the shop from Shopify's signature and answers in a shape the proxy passes on", async () => {
    vi.resetModules();
    const appProxy = vi.fn();
    const handle = vi.fn();
    vi.doMock("../app/shopify.server", () => ({
      authenticate: { public: { appProxy: (request: Request) => appProxy(request) } },
    }));
    vi.doMock("../app/assistant/rating.server", () => ({
      handleChatRating: (...args: unknown[]) => handle(...args),
    }));
    const { action, loader } = await import("../app/routes/proxy.rating");
    const { ChatError: RouteChatError } = await import("../app/assistant/chat.server");
    type Args = Parameters<typeof action>[0];
    const post = (body: unknown, method = "POST") =>
      action({
        request: new Request("https://app.example/proxy/rating?shop=real-shop.myshopify.com&signature=abc", {
          method,
          headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.7, 10.0.0.1" },
          body: method === "POST" ? JSON.stringify(body) : undefined,
        }),
        params: {},
        context: {},
      } as unknown as Args) as Promise<Response>;

    appProxy.mockResolvedValue({ session: { shop: "real-shop.myshopify.com" } });
    handle.mockResolvedValue({ ok: true, rating: "up" });
    const body = { visitorId: VISITOR, conversationId: "conv12345678", rating: "up", shop: "evil.myshopify.com" };
    const saved = await post(body);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ ok: true, rating: "up" });
    expect(handle.mock.calls[0][0]).toMatchObject({ shop: "real-shop.myshopify.com", body });

    // A refusal comes back as a 200 with ok false, which Shopify's proxy passes on unchanged.
    handle.mockRejectedValueOnce(new RouteChatError("disabled", 403, "Ratings are not available for this store."));
    const refusedByApp = await post(body);
    expect(refusedByApp.status).toBe(200);
    expect(await refusedByApp.json()).toMatchObject({ ok: false, error: { code: "disabled", status: 403 } });

    // Not installed, or not a POST: nothing is rated.
    handle.mockClear();
    appProxy.mockResolvedValue({ session: undefined });
    expect((await (await post(body)).json()).error.code).toBe("not_installed");
    expect((await (loader as unknown as () => Promise<Response>)()).status).toBe(405);
    expect(handle).not.toHaveBeenCalled();

    vi.doUnmock("../app/shopify.server");
    vi.doUnmock("../app/assistant/rating.server");
  });
});
