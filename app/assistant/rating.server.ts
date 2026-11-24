/**
 * A shopper's thumbs-up or thumbs-down for their chat.
 *
 * Reached from the widget through the app proxy, like the chat itself: the
 * shop comes from Shopify's signature on the request, and the rating is only
 * ever recorded on a conversation that belongs to that shop and to the
 * visitor who sends it. No model is involved.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

import prisma from "../db.server";
import { ChatError } from "./chat.server";
import { clientKey, rateLimiter as defaultRateLimiter, type RateLimiter } from "./rate-limit";
import { getSettings } from "./settings.server";
import { rateConversation } from "./store.server";

export const CHAT_RATINGS = ["up", "down"] as const;
export type ChatRating = (typeof CHAT_RATINGS)[number];

const ratingSchema = z.object({
  visitorId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  conversationId: z.string().regex(/^[a-z0-9]{8,40}$/),
  /** Null takes a rating back. */
  rating: z.enum(CHAT_RATINGS).nullable(),
});

export interface ChatRatingInput {
  /** Shop domain from the authenticated request. Never from the request body. */
  shop: string;
  /** The untrusted JSON the widget posted. */
  body: Record<string, unknown>;
  ip?: string;
}

export interface ChatRatingDeps {
  db: PrismaClient;
  rateLimiter: RateLimiter;
  now: () => Date;
}

const TEN_MINUTES_MS = 10 * 60 * 1000;

export async function handleChatRating(
  input: ChatRatingInput,
  overrides: Partial<ChatRatingDeps> = {},
): Promise<{ ok: true; rating: ChatRating | null }> {
  const deps: ChatRatingDeps = {
    db: overrides.db ?? prisma,
    rateLimiter: overrides.rateLimiter ?? defaultRateLimiter,
    now: overrides.now ?? (() => new Date()),
  };

  const settings = await getSettings(input.shop, deps.db);
  if (!settings.enabled || !settings.chatRatings) {
    throw new ChatError("disabled", 403, "Ratings are not available for this store.");
  }

  const parsed = ratingSchema.safeParse(input.body);
  if (!parsed.success) {
    throw new ChatError("invalid_request", 400, "That rating could not be saved.");
  }

  // A rating can be changed, but not hammered.
  const limit = deps.rateLimiter.hit(
    `rating:ip:${input.shop}:${clientKey(input.ip)}`,
    30,
    TEN_MINUTES_MS,
    deps.now().getTime(),
  );
  if (!limit.allowed) {
    throw new ChatError(
      "rate_limited",
      429,
      "Too many ratings for now. Please try again later.",
      Math.ceil(limit.retryAfterMs / 1000),
    );
  }

  const { visitorId, conversationId, rating } = parsed.data;
  const saved = await rateConversation(
    deps.db,
    { shop: input.shop, audience: "shopper", visitorId },
    conversationId,
    rating,
    deps.now(),
  );
  // Not theirs, not this shop's, or gone: the same answer for each.
  if (!saved) throw new ChatError("invalid_request", 404, "That rating could not be saved.");
  return { ok: true, rating };
}
