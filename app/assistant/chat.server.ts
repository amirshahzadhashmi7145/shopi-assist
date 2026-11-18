/**
 * One chat turn, end to end. Both entry points (the storefront app proxy and
 * the admin assistant page) authenticate the request with Shopify first and
 * then call `handleChatTurn` with the shop and audience they established.
 */
import type { PrismaClient } from "@prisma/client";

import prisma from "../db.server";
import { runAssistantTurn } from "./engine";
import { getLlmProvider } from "./llm/index.server";
import type { LlmProvider } from "./llm/provider";
import { buildSystemPrompt } from "./prompts";
import { rateLimiter as defaultRateLimiter, type RateLimiter } from "./rate-limit";
import { getSettings } from "./settings.server";
import { getShopName } from "./shopify-clients.server";
import {
  appendExchange,
  createConversation,
  findConversation,
  purgeExpiredConversations,
  recentMessages,
} from "./store.server";
import { allTools } from "./tools";
import { toolsFor, type ToolContext, type ToolDefinition } from "./tools/registry";
import type { Audience, ClientAction, GraphqlFn, ProductCard } from "./types";

export const MAX_MESSAGE_LENGTH = 2000;
const HISTORY_MESSAGES = 20;

export type ChatErrorCode =
  | "invalid_request"
  | "disabled"
  | "rate_limited"
  | "not_configured"
  | "assistant_failed";

/** An error with a message that is safe to show to the person chatting. */
export class ChatError extends Error {
  constructor(
    public readonly code: ChatErrorCode,
    public readonly status: number,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

export interface ChatTurnInput {
  /** Shop domain from the authenticated request. Never from the request body. */
  shop: string;
  /** Set by the route that authenticated the request. Never from the request body. */
  audience: Audience;
  visitorId: unknown;
  conversationId?: unknown;
  message: unknown;
  /** Shopify customer id when the shopper is logged in (signed by Shopify). */
  customerId?: string | null;
  ip?: string;
  country?: unknown;
  language?: unknown;
  admin?: GraphqlFn;
  storefront?: GraphqlFn;
}

export interface ChatTurnResult {
  conversationId: string;
  reply: string;
  cards: ProductCard[];
  actions: ClientAction[];
}

export interface ChatDeps {
  db: PrismaClient;
  /** null means "not configured". */
  provider: LlmProvider | null;
  rateLimiter: RateLimiter;
  tools: ToolDefinition[];
  now: () => Date;
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const lastPurge = new Map<string, number>();
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

export async function handleChatTurn(
  input: ChatTurnInput,
  overrides: Partial<ChatDeps> = {},
): Promise<ChatTurnResult> {
  const deps: ChatDeps = {
    db: overrides.db ?? prisma,
    provider: "provider" in overrides ? overrides.provider! : getLlmProvider(),
    rateLimiter: overrides.rateLimiter ?? defaultRateLimiter,
    tools: overrides.tools ?? allTools,
    now: overrides.now ?? (() => new Date()),
  };
  const now = deps.now();
  const startedAt = Date.now();

  // 1. Validate what the browser sent.
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!message) {
    throw new ChatError("invalid_request", 400, "Type a message first.");
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new ChatError(
      "invalid_request",
      400,
      `Messages can be up to ${MAX_MESSAGE_LENGTH} characters. Please shorten yours.`,
    );
  }
  if (typeof input.visitorId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(input.visitorId)) {
    throw new ChatError("invalid_request", 400, "Something went wrong. Please reload the page.");
  }
  const visitorId = input.visitorId;
  const conversationId =
    typeof input.conversationId === "string" && /^[a-z0-9]{8,40}$/.test(input.conversationId)
      ? input.conversationId
      : null;
  const country =
    typeof input.country === "string" && /^[A-Za-z]{2}$/.test(input.country)
      ? input.country.toUpperCase()
      : undefined;
  const language =
    typeof input.language === "string" && /^[A-Za-z]{2}$/.test(input.language)
      ? input.language.toUpperCase()
      : undefined;

  // 2. Shop-level switches.
  const settings = await getSettings(input.shop, deps.db);
  if (input.audience === "shopper" && !settings.enabled) {
    throw new ChatError("disabled", 403, "Chat is currently turned off for this store.");
  }
  if (!deps.provider) {
    throw new ChatError(
      "not_configured",
      503,
      "The assistant is not set up yet. Please try again later.",
    );
  }

  // 3. Rate limits. The storefront endpoint is public, so it gets a per-IP
  //    limit plus a per-shop ceiling that bounds LLM spend.
  const limits =
    input.audience === "shopper"
      ? [
          {
            key: `chat:ip:${input.shop}:${input.ip ?? "unknown"}`,
            max: envNumber("CHAT_LIMIT_PER_IP_PER_MINUTE", 12),
            windowMs: 60_000,
          },
          {
            key: `chat:shop:${input.shop}`,
            max: envNumber("CHAT_LIMIT_PER_SHOP_PER_HOUR", 600),
            windowMs: 3_600_000,
          },
        ]
      : [
          {
            key: `chat:merchant:${input.shop}`,
            max: envNumber("CHAT_LIMIT_MERCHANT_PER_MINUTE", 30),
            windowMs: 60_000,
          },
        ];
  for (const limit of limits) {
    const result = deps.rateLimiter.hit(limit.key, limit.max, limit.windowMs, now.getTime());
    if (!result.allowed) {
      throw new ChatError(
        "rate_limited",
        429,
        "You're sending messages quickly. Please wait a moment and try again.",
        Math.ceil(result.retryAfterMs / 1000),
      );
    }
  }

  // 4. Find the caller's conversation, or start a new one. An unknown or
  //    foreign id silently starts a fresh conversation.
  const key = { shop: input.shop, audience: input.audience, visitorId };
  const existing = conversationId
    ? await findConversation(deps.db, key, conversationId)
    : null;
  const conversation =
    existing ?? (await createConversation(deps.db, key, input.customerId));
  const history = existing
    ? await recentMessages(deps.db, conversation.id, HISTORY_MESSAGES)
    : [];

  // 5. Run the model with the tools this audience is allowed to use.
  const context: ToolContext = {
    shop: input.shop,
    audience: input.audience,
    storefront: input.storefront,
    admin: input.admin,
    settings: { orderLookupEnabled: settings.orderLookupEnabled },
    buyer: { country, language, ip: input.ip },
    rateLimiter: deps.rateLimiter,
    now: deps.now,
  };
  const tools = toolsFor(deps.tools, context);
  const shopName = await getShopName(input.shop, input.admin, now.getTime());

  let turn;
  try {
    turn = await runAssistantTurn({
      provider: deps.provider,
      tools,
      context,
      systemPrompt: buildSystemPrompt({
        audience: input.audience,
        shopName,
        merchantInstructions: settings.instructions,
        orderLookupEnabled: tools.some((tool) => tool.name === "get_order_status"),
        today: now,
      }),
      history: [...history, { role: "user", content: message }],
    });
  } catch (error) {
    // Log the cause for the developer. Never log message text.
    console.error(
      `[shopi-assist] chat turn failed shop=${input.shop} audience=${input.audience}:`,
      error instanceof Error ? error.message : "unknown error",
    );
    throw new ChatError(
      "assistant_failed",
      502,
      "Sorry, I'm having trouble answering right now. Please try again in a moment.",
    );
  }

  // 6. Persist the exchange only once it has succeeded.
  await appendExchange(deps.db, conversation.id, message, turn.reply, {
    customerId: input.customerId,
    now,
  });

  console.info(
    `[shopi-assist] chat turn shop=${input.shop} audience=${input.audience} steps=${turn.steps} tools=${turn.toolsUsed.join(",") || "-"} tokens=${turn.usage.inputTokens}+${turn.usage.outputTokens} ms=${Date.now() - startedAt}`,
  );

  // 7. Housekeeping: enforce the retention period, at most hourly per shop.
  const purgedAt = lastPurge.get(input.shop) ?? 0;
  if (now.getTime() - purgedAt > PURGE_INTERVAL_MS) {
    lastPurge.set(input.shop, now.getTime());
    purgeExpiredConversations(deps.db, input.shop, settings.retentionDays, now).catch(
      (error) => {
        console.error(
          `[shopi-assist] retention purge failed shop=${input.shop}:`,
          error instanceof Error ? error.message : "unknown error",
        );
      },
    );
  }

  return {
    conversationId: conversation.id,
    reply: turn.reply,
    cards: turn.cards,
    actions: turn.actions,
  };
}

/** Turns any thrown value into a JSON error response for the chat clients. */
export function chatErrorResponse(error: unknown): Response {
  if (error instanceof ChatError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      {
        status: error.status,
        headers: {
          "Cache-Control": "no-store",
          ...(error.retryAfterSeconds
            ? { "Retry-After": String(error.retryAfterSeconds) }
            : {}),
        },
      },
    );
  }
  console.error(
    "[shopi-assist] unexpected chat error:",
    error instanceof Error ? error.message : "unknown error",
  );
  return Response.json(
    {
      error: {
        code: "assistant_failed",
        message: "Something went wrong. Please try again.",
      },
    },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}
