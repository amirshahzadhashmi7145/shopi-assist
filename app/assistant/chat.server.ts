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
import {
  clientKey,
  rateLimiter as defaultRateLimiter,
  tokenBudget as defaultTokenBudget,
  type DailyBudget,
  type RateLimiter,
} from "./rate-limit";
import { DEFAULT_SETTINGS, describeQuickPolicies, getSettings } from "./settings.server";
import { getShopName } from "./shopify-clients.server";
import {
  appendExchange,
  createConversation,
  findConversation,
  purgeAllExpiredConversations,
  recentMessages,
} from "./store.server";
import { allTools } from "./tools";
import { toolsFor, type ToolContext, type ToolDefinition } from "./tools/registry";
import type { Audience, ClientAction, GraphqlFn, ProductCard } from "./types";

export const MAX_MESSAGE_LENGTH = 2000;
const HISTORY_MESSAGES = 20;
/** A turn that has not finished by now is abandoned; the widget gives up at 60s. */
const TURN_DEADLINE_MS = 50_000;

export type ChatErrorCode =
  | "invalid_request"
  | "disabled"
  | "rate_limited"
  | "over_capacity"
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
  /**
   * True when store staff are trying the shopper assistant from the admin.
   * The turn runs exactly as a shopper's would (same tools, same prompt) but
   * uses the staff rate limit and is kept out of the conversation log.
   * Only the authenticated admin route may set this.
   */
  preview?: boolean;
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
  tokenBudget: DailyBudget;
  tools: ToolDefinition[];
  now: () => Date;
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/**
 * Transcripts are kept for the merchant to read, not as a customer record, so
 * email addresses are masked before anything is written to the database. The
 * model still sees the original text for the turn in which it was typed.
 */
export function maskForStorage(text: string): string {
  return text.replace(EMAIL_PATTERN, "[email removed]");
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export async function handleChatTurn(
  input: ChatTurnInput,
  overrides: Partial<ChatDeps> = {},
): Promise<ChatTurnResult> {
  const deps: ChatDeps = {
    db: overrides.db ?? prisma,
    provider: "provider" in overrides ? overrides.provider! : getLlmProvider(),
    rateLimiter: overrides.rateLimiter ?? defaultRateLimiter,
    tokenBudget: overrides.tokenBudget ?? defaultTokenBudget,
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
  // Staff can still try the assistant in the admin while chat is paused.
  if (input.audience === "shopper" && !settings.enabled && !input.preview) {
    throw new ChatError("disabled", 403, "Chat is currently turned off for this store.");
  }
  if (!deps.provider) {
    throw new ChatError(
      "not_configured",
      503,
      "The assistant is not set up yet. Please try again later.",
    );
  }

  // 3. Limits. The storefront endpoint is public and every turn costs LLM
  //    tokens, so there are several independent ceilings. Per-address limits
  //    come first: a blocked address stops here and never eats into the
  //    shop-wide budget that other shoppers depend on.
  const address = clientKey(input.ip);
  const limits =
    input.audience === "shopper" && !input.preview
      ? [
          {
            key: `chat:ip-minute:${input.shop}:${address}`,
            max: envNumber("CHAT_LIMIT_PER_IP_PER_MINUTE", 12),
            windowMs: MINUTE_MS,
          },
          {
            key: `chat:ip-hour:${input.shop}:${address}`,
            max: envNumber("CHAT_LIMIT_PER_IP_PER_HOUR", 60),
            windowMs: HOUR_MS,
          },
          {
            key: `chat:shop-hour:${input.shop}`,
            max: envNumber("CHAT_LIMIT_PER_SHOP_PER_HOUR", 600),
            windowMs: HOUR_MS,
          },
          {
            key: `chat:shop-day:${input.shop}`,
            max: envNumber("CHAT_LIMIT_PER_SHOP_PER_DAY", 3000),
            windowMs: DAY_MS,
          },
        ]
      : [
          {
            key: `chat:merchant:${input.shop}`,
            max: envNumber("CHAT_LIMIT_MERCHANT_PER_MINUTE", 30),
            windowMs: MINUTE_MS,
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

  // The last line of defence on spend: a daily token ceiling for the whole
  // process, across every shop.
  const dailyTokenBudget = envNumber("LLM_DAILY_TOKEN_BUDGET", 2_000_000);
  if (deps.tokenBudget.spent(now) >= dailyTokenBudget) {
    console.warn("[shopi-assist] daily LLM token budget reached; refusing chat turns");
    throw new ChatError(
      "over_capacity",
      503,
      "The assistant has reached its limit for today. Please try again tomorrow.",
    );
  }

  // 4. Find the caller's conversation, or start a new one. An unknown or
  //    foreign id silently starts a fresh conversation.
  const key = {
    shop: input.shop,
    audience: input.audience,
    visitorId,
    isPreview: Boolean(input.preview),
  };
  const existing = conversationId
    ? await findConversation(deps.db, key, conversationId)
    : null;
  const conversation =
    existing ?? (await createConversation(deps.db, key, input.customerId));
  const history = existing
    ? await recentMessages(deps.db, input.shop, conversation.id, HISTORY_MESSAGES)
    : [];

  // 5. Run the model with the tools this audience is allowed to use.
  const context: ToolContext = {
    shop: input.shop,
    audience: input.audience,
    storefront: input.storefront,
    // Shoppers get no Admin API access at all unless the merchant switched
    // on a feature that needs it (order status or return requests).
    admin:
      input.audience === "merchant" || settings.orderLookupEnabled || settings.allowReturns
        ? input.admin
        : undefined,
    settings: {
      orderLookupEnabled: settings.orderLookupEnabled,
      allowAddToCart: settings.allowAddToCart,
      allowCheckout: settings.allowCheckout,
      allowReturns: settings.allowReturns,
    },
    buyer: { country, language, ip: input.ip },
    rateLimiter: deps.rateLimiter,
    turn: { orderLookups: 0 },
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
        assistantName: settings.assistantName,
        tone: settings.tone,
        abilities: {
          addToCart: tools.some((tool) => tool.name === "add_to_cart"),
          checkout: tools.some((tool) => tool.name === "start_checkout"),
          placeOrder: tools.some((tool) => tool.name === "place_order"),
          chatOrders:
            settings.allowChatOrders && tools.some((tool) => tool.name === "start_checkout"),
          returns: tools.some((tool) => tool.name === "request_return"),
        },
        quickPolicies: describeQuickPolicies(settings),
        knowledge: {
          businessDescription: settings.businessDescription,
          returnPolicy: settings.returnPolicy,
          shippingInfo: settings.shippingInfo,
          faq: settings.faq,
        },
        merchantInstructions: settings.instructions,
        orderLookupEnabled: tools.some((tool) => tool.name === "get_order_status"),
        today: now,
      }),
      history: [...history, { role: "user", content: message }],
      signal: AbortSignal.timeout(TURN_DEADLINE_MS),
    });
  } catch (error) {
    // Log the kind of failure only. Provider error messages can echo request
    // content or configuration, so the message itself is not logged.
    const name = error instanceof Error ? error.name : "unknown";
    const status = (error as { status?: unknown } | null)?.status;
    console.error(
      `[shopi-assist] chat turn failed shop=${input.shop} audience=${input.audience} error=${name}${typeof status === "number" ? ` status=${status}` : ""}`,
    );
    throw new ChatError(
      "assistant_failed",
      502,
      "Sorry, I'm having trouble answering right now. Please try again in a moment.",
    );
  }

  deps.tokenBudget.add(turn.usage.inputTokens + turn.usage.outputTokens, now);

  // 6. Persist the exchange only once it has succeeded.
  await appendExchange(
    deps.db,
    input.shop,
    conversation.id,
    maskForStorage(message),
    maskForStorage(turn.reply),
    { customerId: input.customerId, now },
  );

  console.info(
    `[shopi-assist] chat turn shop=${input.shop} audience=${input.audience} steps=${turn.steps} tools=${turn.toolsUsed.join(",") || "-"} tokens=${turn.usage.inputTokens}+${turn.usage.outputTokens} ms=${Date.now() - startedAt}`,
  );

  startRetentionSweeper(deps.db);

  return {
    conversationId: conversation.id,
    reply: turn.reply,
    // With add to cart switched off, cards link to the product but offer no
    // one-click add.
    cards: settings.allowAddToCart
      ? turn.cards
      : turn.cards.map((card) => ({ ...card, variantId: null })),
    actions: turn.actions,
  };
}

declare global {
  // eslint-disable-next-line no-var
  var shopiAssistRetentionSweeper: ReturnType<typeof setInterval> | undefined;
}

/**
 * Starts the hourly job that deletes transcripts past each shop's retention
 * period. It runs on a timer, not only when someone chats, so a quiet shop
 * still has old transcripts removed on schedule. Safe to call repeatedly.
 */
export function startRetentionSweeper(db: PrismaClient = prisma): void {
  if (globalThis.shopiAssistRetentionSweeper) return;

  const sweep = () => {
    purgeAllExpiredConversations(db, DEFAULT_SETTINGS.retentionDays).catch((error) => {
      console.error(
        "[shopi-assist] retention sweep failed:",
        error instanceof Error ? error.name : "unknown error",
      );
    });
  };
  globalThis.shopiAssistRetentionSweeper = setInterval(sweep, HOUR_MS);
  // Do not keep the process alive just for housekeeping.
  globalThis.shopiAssistRetentionSweeper.unref?.();
  sweep();
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
    error instanceof Error ? error.name : "unknown error",
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
