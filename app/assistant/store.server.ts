/**
 * Conversation storage.
 *
 * Tenant isolation rule: every function takes the authenticated `shop` and
 * puts it in the WHERE clause. A conversation id on its own is never enough
 * to read or extend a conversation.
 */
import type { PrismaClient } from "@prisma/client";

import type { Audience, KnownOrder, StoredMessage } from "./types";

export interface ConversationKey {
  shop: string;
  audience: Audience;
  visitorId: string;
  /** Merchant's "try it as a shopper" chat. Set by the server only. */
  isPreview?: boolean;
}

/**
 * Finds the caller's conversation, or returns null. The id must belong to the
 * same shop, audience and visitor, so one shopper cannot continue (or read the
 * context of) another shopper's chat by guessing an id.
 */
export async function findConversation(
  db: PrismaClient,
  key: ConversationKey,
  conversationId: string,
) {
  return db.conversation.findFirst({
    where: {
      id: conversationId,
      shop: key.shop,
      audience: key.audience,
      visitorId: key.visitorId,
      isPreview: key.isPreview ?? false,
    },
    select: { id: true },
  });
}

/**
 * Records, changes or takes back the shopper's rating of their own chat.
 * Like `findConversation`, the id must belong to the same shop, audience and
 * visitor: nobody rates a chat that is not theirs. False when there is none.
 * The chat's own "last activity" time is left alone.
 */
export async function rateConversation(
  db: PrismaClient,
  key: ConversationKey,
  conversationId: string,
  rating: "up" | "down" | null,
  now: Date = new Date(),
): Promise<boolean> {
  const mine = await findConversation(db, key, conversationId);
  if (!mine) return false;
  const current = await db.conversation.findFirst({
    where: { id: mine.id, shop: key.shop },
    select: { updatedAt: true },
  });
  const changed = await db.conversation.updateMany({
    where: { id: mine.id, shop: key.shop },
    data: { rating, ratedAt: rating ? now : null, updatedAt: current?.updatedAt },
  });
  return changed.count > 0;
}

/** How shoppers rated the chats still on record for a shop. */
export async function ratingCounts(
  db: PrismaClient,
  shop: string,
): Promise<{ up: number; down: number }> {
  const rows = await db.conversation.groupBy({
    by: ["rating"],
    where: { shop, audience: "shopper", isPreview: false, rating: { not: null } },
    _count: { _all: true },
  });
  const count = (rating: string) => rows.find((row) => row.rating === rating)?._count._all ?? 0;
  return { up: count("up"), down: count("down") };
}

export async function createConversation(
  db: PrismaClient,
  key: ConversationKey,
  customerId?: string | null,
) {
  return db.conversation.create({
    data: {
      shop: key.shop,
      audience: key.audience,
      visitorId: key.visitorId,
      customerId: customerId || null,
      isPreview: key.isPreview ?? false,
    },
    select: { id: true },
  });
}

/** The last `limit` messages, oldest first. */
export async function recentMessages(
  db: PrismaClient,
  shop: string,
  conversationId: string,
  limit: number,
): Promise<StoredMessage[]> {
  const rows = await db.message.findMany({
    where: { conversationId, conversation: { shop } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    select: { role: true, content: true },
  });
  return rows
    .reverse()
    .map((row) => ({
      role: row.role === "assistant" ? "assistant" : "user",
      content: row.content,
    }));
}

const MAX_KNOWN_ORDERS = 10;

/**
 * Ties an order to a conversation, so later questions about it need no proof
 * again. Only the server calls this, and only after it placed the order or
 * checked the shopper's order number and email against Shopify.
 */
export async function rememberOrder(
  db: PrismaClient,
  shop: string,
  conversationId: string,
  order: KnownOrder,
): Promise<void> {
  // The conversation must be this shop's; an id alone is never enough.
  const owned = await db.conversation.findFirst({
    where: { id: conversationId, shop },
    select: { id: true },
  });
  if (!owned) throw new Error("Conversation does not belong to this shop");

  await db.conversationOrder.upsert({
    where: { conversationId_orderId: { conversationId, orderId: order.id } },
    create: {
      shop,
      conversationId,
      orderId: order.id,
      orderName: order.name,
      source: order.source,
    },
    // An order placed here stays "placed" even if it is looked up later.
    update: {},
  });
}

/** The orders tied to this conversation, newest first. */
export async function knownOrders(
  db: PrismaClient,
  shop: string,
  conversationId: string,
): Promise<KnownOrder[]> {
  const rows = await db.conversationOrder.findMany({
    where: { conversationId, shop, conversation: { shop } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_KNOWN_ORDERS,
    select: { orderId: true, orderName: true, source: true },
  });
  return rows.map((row) => ({
    id: row.orderId,
    name: row.orderName,
    source: row.source === "placed" ? "placed" : "verified",
  }));
}

/** Stores one completed exchange and bumps the conversation's activity time. */
export async function appendExchange(
  db: PrismaClient,
  shop: string,
  conversationId: string,
  userMessage: string,
  assistantReply: string,
  options: { customerId?: string | null; now?: Date } = {},
): Promise<void> {
  const now = options.now ?? new Date();

  // Re-check ownership here rather than trusting the caller's earlier lookup.
  const owned = await db.conversation.findFirst({
    where: { id: conversationId, shop },
    select: { id: true },
  });
  if (!owned) throw new Error("Conversation does not belong to this shop");

  await db.$transaction([
    db.message.create({
      data: { conversationId, role: "user", content: userMessage, createdAt: now },
    }),
    db.message.create({
      data: {
        conversationId,
        role: "assistant",
        content: assistantReply,
        // One millisecond later so ordering by time is stable.
        createdAt: new Date(now.getTime() + 1),
      },
    }),
    db.conversation.updateMany({
      where: { id: conversationId, shop },
      data: {
        updatedAt: now,
        // Remember the customer once they log in mid-conversation.
        ...(options.customerId ? { customerId: options.customerId } : {}),
      },
    }),
  ]);
}

export async function listConversations(
  db: PrismaClient,
  shop: string,
  options: { audience?: Audience; take?: number } = {},
) {
  const rows = await db.conversation.findMany({
    // The merchant's own test chats are not shopper conversations.
    where: { shop, audience: options.audience ?? "shopper", isPreview: false },
    orderBy: { updatedAt: "desc" },
    take: options.take ?? 30,
    select: {
      id: true,
      updatedAt: true,
      createdAt: true,
      customerId: true,
      rating: true,
      _count: { select: { messages: true } },
      messages: {
        where: { role: "user" },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { content: true },
      },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    startedAt: row.createdAt,
    updatedAt: row.updatedAt,
    loggedIn: Boolean(row.customerId),
    rating: row.rating === "up" || row.rating === "down" ? row.rating : null,
    messageCount: row._count.messages,
    firstMessage: row.messages[0]?.content ?? "",
  }));
}

export async function getConversationTranscript(
  db: PrismaClient,
  shop: string,
  conversationId: string,
) {
  return db.conversation.findFirst({
    where: { id: conversationId, shop },
    select: {
      id: true,
      audience: true,
      isPreview: true,
      rating: true,
      createdAt: true,
      updatedAt: true,
      messages: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, role: true, content: true, createdAt: true },
      },
    },
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ChatAnalytics {
  /** Shopper chats started in the last 7 and the last 30 days. */
  conversations: { last7: number; last30: number };
  /** Messages shoppers wrote in the last 30 days. */
  shopperMessages: number;
  /** Chats of the last 30 days by a customer signed in to their account. */
  signedIn: number;
  /** How the chats of the last 30 days were rated. */
  ratings: { up: number; down: number };
  /** Pay-on-delivery orders placed through the chat in the last 30 days. */
  ordersPlaced: number;
  /** Chats started on each of the last 7 days, oldest first. Days are in UTC. */
  perDay: Array<{ date: string; count: number }>;
}

/**
 * A few numbers about a shop's storefront chats for the merchant's home page.
 * They cover only what is still on record: chats are deleted after the shop's
 * retention period, and their messages and orders go with them. The
 * merchant's own test chats are left out.
 */
export async function chatAnalytics(
  db: PrismaClient,
  shop: string,
  now: Date = new Date(),
): Promise<ChatAnalytics> {
  const since30 = new Date(now.getTime() - 30 * DAY_MS);
  // Seven calendar days ending today, so the chart has whole days.
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const since7 = new Date(today - 6 * DAY_MS);
  const chats = { shop, audience: "shopper", isPreview: false } as const;

  const [last30, signedIn, rated, shopperMessages, ordersPlaced, week] = await Promise.all([
    db.conversation.count({ where: { ...chats, createdAt: { gte: since30 } } }),
    db.conversation.count({
      where: { ...chats, createdAt: { gte: since30 }, customerId: { not: null } },
    }),
    db.conversation.groupBy({
      by: ["rating"],
      where: { ...chats, createdAt: { gte: since30 }, rating: { not: null } },
      _count: { _all: true },
    }),
    db.message.count({
      where: { role: "user", createdAt: { gte: since30 }, conversation: chats },
    }),
    db.conversationOrder.count({
      where: { shop, source: "placed", createdAt: { gte: since30 }, conversation: chats },
    }),
    db.conversation.findMany({
      where: { ...chats, createdAt: { gte: since7 } },
      select: { createdAt: true },
    }),
  ]);

  const perDay = Array.from({ length: 7 }, (_, index) => ({
    date: new Date(since7.getTime() + index * DAY_MS).toISOString().slice(0, 10),
    count: 0,
  }));
  for (const chat of week) {
    const day = perDay.find((entry) => entry.date === chat.createdAt.toISOString().slice(0, 10));
    if (day) day.count += 1;
  }
  const ratedAs = (rating: string) => rated.find((row) => row.rating === rating)?._count._all ?? 0;

  return {
    conversations: { last7: week.length, last30 },
    shopperMessages,
    signedIn,
    ratings: { up: ratedAs("up"), down: ratedAs("down") },
    ordersPlaced,
    perDay,
  };
}

export async function countConversationsSince(
  db: PrismaClient,
  shop: string,
  since: Date,
): Promise<number> {
  return db.conversation.count({
    where: { shop, audience: "shopper", isPreview: false, updatedAt: { gte: since } },
  });
}

/** Deletes conversations with no activity for `retentionDays`. Returns how many. */
export async function purgeExpiredConversations(
  db: PrismaClient,
  shop: string,
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await db.conversation.deleteMany({
    where: { shop, updatedAt: { lt: cutoff } },
  });
  return result.count;
}

/**
 * Applies every shop's retention period. Runs on a timer so that a shop with
 * no chat traffic still has its old transcripts removed on schedule.
 */
export async function purgeAllExpiredConversations(
  db: PrismaClient,
  defaultRetentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  const shops = await db.conversation.findMany({
    distinct: ["shop"],
    select: { shop: true },
  });
  let removed = 0;
  for (const { shop } of shops) {
    const settings = await db.shopSettings.findUnique({
      where: { shop },
      select: { retentionDays: true },
    });
    removed += await purgeExpiredConversations(
      db,
      shop,
      settings?.retentionDays ?? defaultRetentionDays,
      now,
    );
  }
  return removed;
}

/** customers/data_request: how many transcripts are linked to this customer. */
export async function countCustomerConversations(
  db: PrismaClient,
  shop: string,
  customerId: string,
): Promise<number> {
  return db.conversation.count({ where: { shop, customerId } });
}

/** customers/redact: remove everything tied to one customer of one shop. */
export async function deleteCustomerConversations(
  db: PrismaClient,
  shop: string,
  customerId: string,
): Promise<number> {
  const result = await db.conversation.deleteMany({ where: { shop, customerId } });
  return result.count;
}

/** shop/redact: remove everything the app stores for a shop. */
export async function deleteShopData(db: PrismaClient, shop: string): Promise<void> {
  await db.$transaction([
    db.conversation.deleteMany({ where: { shop } }),
    db.shopSettings.deleteMany({ where: { shop } }),
    db.session.deleteMany({ where: { shop } }),
  ]);
}
