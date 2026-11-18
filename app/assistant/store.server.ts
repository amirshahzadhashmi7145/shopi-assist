/**
 * Conversation storage.
 *
 * Tenant isolation rule: every function takes the authenticated `shop` and
 * puts it in the WHERE clause. A conversation id on its own is never enough
 * to read or extend a conversation.
 */
import type { PrismaClient } from "@prisma/client";

import type { Audience, StoredMessage } from "./types";

export interface ConversationKey {
  shop: string;
  audience: Audience;
  visitorId: string;
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
    },
    select: { id: true },
  });
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
    },
    select: { id: true },
  });
}

/** The last `limit` messages, oldest first. */
export async function recentMessages(
  db: PrismaClient,
  conversationId: string,
  limit: number,
): Promise<StoredMessage[]> {
  const rows = await db.message.findMany({
    where: { conversationId },
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

/** Stores one completed exchange and bumps the conversation's activity time. */
export async function appendExchange(
  db: PrismaClient,
  conversationId: string,
  userMessage: string,
  assistantReply: string,
  options: { customerId?: string | null; now?: Date } = {},
): Promise<void> {
  const now = options.now ?? new Date();
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
    db.conversation.update({
      where: { id: conversationId },
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
    where: { shop, audience: options.audience ?? "shopper" },
    orderBy: { updatedAt: "desc" },
    take: options.take ?? 30,
    select: {
      id: true,
      updatedAt: true,
      createdAt: true,
      customerId: true,
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
      createdAt: true,
      updatedAt: true,
      messages: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, role: true, content: true, createdAt: true },
      },
    },
  });
}

export async function countConversationsSince(
  db: PrismaClient,
  shop: string,
  since: Date,
): Promise<number> {
  return db.conversation.count({
    where: { shop, audience: "shopper", updatedAt: { gte: since } },
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
