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
import { describeTopics } from "./setting-options";
import {
  aboutBusiness,
  DEFAULT_SETTINGS,
  describeQuickPolicies,
  describeShippingPicks,
  shippingPicksText,
  getSettings,
} from "./settings.server";
import type { ShippingRates } from "./shipping";
import { loadShippingRates } from "./shipping.server";
import { NO_FACTS } from "./store-facts";
import { getStoredFacts, refreshStoreFactsIfStale } from "./store-facts.server";
import { GRANT_LIFETIME_MS, grantSecret, signGrant } from "./action-grant.server";
import { getShopName, isDevelopmentStore, ordersOfCustomer } from "./shopify-clients.server";
import {
  appendExchange,
  createConversation,
  findConversation,
  knownOrders,
  purgeAllExpiredConversations,
  recentMessages,
  rememberOrder,
} from "./store.server";
import { allTools } from "./tools";
import {
  asksForProof,
  asksReturnReason,
  asksWhichOrder,
  asksYesOrNo,
  liftChoices,
} from "./choices";
import { toolsFor, type ToolContext, type ToolDefinition } from "./tools/registry";
import { checkReturnable, RETURN_REASON_LABELS } from "./tools/shopper";
import type {
  Audience,
  CartLine,
  ClientAction,
  GraphqlFn,
  KnownOrder,
  ProductCard,
} from "./types";

export const MAX_MESSAGE_LENGTH = 2000;
/** How long a turn waits for the store's facts to be read again before going ahead. */
const FACTS_WAIT_MS = 2000;
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
  /** The storefront cart as the widget read it. Untrusted; see `readCart`. */
  cart?: unknown;
  /**
   * What the widget says it can draw beyond text and cards, such as
   * "choices". Untrusted, and only ever used to hold things back from a
   * widget that did not ask for them.
   */
  supports?: unknown;
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

const MAX_CART_LINES = 20;


/** The widget's list of what it can draw, kept only if it is a short list of plain names. */
function readSupports(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && /^[a-z_]{1,30}$/.test(entry))
    .slice(0, 10);
}

/**
 * The shopper's cart as their browser reported it, or undefined when it was
 * not sent or is not in the expected shape. It comes from the request body,
 * so it is only ever shown to the model as information about the shopper's
 * own cart: nothing is priced, ordered or authorised from it.
 */
export function readCart(value: unknown): CartLine[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const lines: CartLine[] = [];
  for (const entry of value.slice(0, MAX_CART_LINES)) {
    if (!entry || typeof entry !== "object") return undefined;
    const { variantId, title, quantity } = entry as Record<string, unknown>;
    if (typeof variantId !== "string" || !/^\d{1,20}$/.test(variantId)) return undefined;
    if (typeof title !== "string" || typeof quantity !== "number") return undefined;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) return undefined;
    lines.push({ variantId, title: title.slice(0, 120), quantity });
  }
  return lines;
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

  // Orders the server has already tied to this conversation. Remembering them
  // is a convenience: if it fails, the shopper is simply asked for proof again.
  let orders: KnownOrder[] = [];
  if (existing && input.audience === "shopper") {
    try {
      orders = await knownOrders(deps.db, input.shop, conversation.id);
    } catch (error) {
      console.error(
        `[shopi-assist] known orders unavailable shop=${input.shop} error=${error instanceof Error ? error.name : "unknown"}`,
      );
    }
  }

  // A shopper signed in to their store account: their own recent orders are
  // known without proof. The id is the one Shopify signed onto the request.
  const signedIn =
    input.audience === "shopper" &&
    !input.preview &&
    Boolean(input.customerId) &&
    settings.recogniseCustomers &&
    settings.orderLookupEnabled;
  if (signedIn && input.admin) {
    // The admin client is the signed shop's own, so only its orders can come back.
    const theirs = await ordersOfCustomer(input.customerId!, input.admin);
    for (const order of theirs) {
      if (!orders.some((known) => known.id === order.id)) orders.push(order);
    }
  }
  const secret = grantSecret();

  // What Shopify says about the store itself (its description, its contact
  // address), as stored. When that is more than a few minutes old it is read
  // again first, briefly: if Shopify is slow the turn goes ahead with what it
  // has and the fresh answer is there for the next one.
  let facts = NO_FACTS;
  if (input.audience === "shopper") {
    facts = await getStoredFacts(input.shop, deps.db);
    const refresh = refreshStoreFactsIfStale(
      input.shop,
      facts,
      { admin: input.admin, storefront: input.storefront },
      { db: deps.db, now },
    );
    if (refresh) {
      await Promise.race([refresh, new Promise((resolve) => setTimeout(resolve, FACTS_WAIT_MS))]);
      facts = await getStoredFacts(input.shop, deps.db);
    }
  }
  // The merchant's own picks about delivery: what the shipping tool falls
  // back on for anything Shopify does not answer.
  const shippingPicks = describeShippingPicks(settings, facts);
  // One read of the store's shipping settings serves the whole turn, however
  // often the assistant asks within it. The next turn reads them again.
  let shippingRead: Promise<ShippingRates> | undefined;

  // 5. Run the model with the tools this audience is allowed to use.
  const context: ToolContext = {
    shop: input.shop,
    audience: input.audience,
    storefront: input.storefront,
    // Shoppers get no Admin API access at all unless the merchant switched
    // on a feature that needs it (order status, returns or order changes).
    admin:
      input.audience === "merchant" ||
      settings.orderLookupEnabled ||
      settings.allowReturns ||
      settings.allowOrderCancel ||
      settings.allowAddressChange ||
      settings.allowOrderEdit
        ? input.admin
        : undefined,
    settings: {
      orderLookupEnabled: settings.orderLookupEnabled,
      orderLookupByNumber: settings.orderLookupEnabled && settings.orderLookupByNumber,
      allowReturns: settings.allowReturns,
      allowOrderCancel: settings.allowOrderCancel,
      allowAddressChange: settings.allowAddressChange,
      allowOrderEdit: settings.allowOrderEdit,
    },
    // Shipping rates are asked of Shopify in the turn the assistant needs them.
    shippingRates:
      input.audience === "shopper" && input.admin
        ? () => (shippingRead ??= loadShippingRates(input.admin))
        : undefined,
    shippingPicks,
    shippingNote: settings.shippingInfo.trim().slice(0, 1500) || undefined,
    isTestStore: () => isDevelopmentStore(input.shop, input.admin),
    // A grant names this shop and this chat, and stops working after a while.
    grantOrderAction:
      input.audience === "shopper" && !input.preview && secret
        ? (grant) =>
            signGrant(
              {
                ...grant,
                shop: input.shop,
                conversationId: conversation.id,
                exp: now.getTime() + GRANT_LIFETIME_MS,
              },
              secret,
            )
        : undefined,
    buyer: { country, language, ip: input.ip },
    cart: input.audience === "shopper" ? readCart(input.cart) : undefined,
    clientSupports: readSupports(input.supports),
    knownOrders: orders,
    rememberOrder: async (order) => {
      if (orders.some((known) => known.id === order.id)) return;
      const verified: KnownOrder = { ...order, source: "verified" };
      // Known for the rest of this turn even if it cannot be saved.
      orders.push(verified);
      try {
        await rememberOrder(deps.db, input.shop, conversation.id, verified);
      } catch (error) {
        console.error(
          `[shopi-assist] could not remember a verified order shop=${input.shop} error=${error instanceof Error ? error.name : "unknown"}`,
        );
      }
    },
    rateLimiter: deps.rateLimiter,
    turn: { orderLookups: 0 },
    now: deps.now,
  };
  const tools = toolsFor(deps.tools, context);
  const hasShippingTool = tools.some((tool) => tool.name === "get_shipping_info");
  const shopName = await getShopName(input.shop, input.admin, now.getTime());

  const systemPrompt = buildSystemPrompt({
    audience: input.audience,
    shopName,
    assistantName: settings.assistantName,
    abilities: {
      returns: tools.some((tool) => tool.name === "request_return"),
      cancelOrder: tools.some((tool) => tool.name === "cancel_order"),
      changeAddress: tools.some((tool) => tool.name === "change_delivery_address"),
      changeItems: tools.some((tool) => tool.name === "change_order_items"),
      shipping: hasShippingTool,
      payment: tools.some((tool) => tool.name === "get_payment_methods"),
    },
    signedIn,
    // With the shipping tool, everything about delivery comes from it: the
    // owner's picks and note are its fallback and stay out of the prompt.
    quickPolicies: [
      describeQuickPolicies(settings),
      hasShippingTool ? "" : shippingPicksText(shippingPicks),
    ]
      .filter(Boolean)
      .join("\n"),
    topicNotes: describeTopics(settings.topics, facts.contactEmail),
    knowledge: {
      businessDescription: aboutBusiness(settings, facts),
      returnPolicy: settings.returnPolicy,
      shippingInfo: hasShippingTool ? "" : settings.shippingInfo,
      faq: settings.faq,
    },
    merchantInstructions: settings.instructions,
    orderLookupEnabled: tools.some((tool) => tool.name === "get_order_status"),
    orderLookupByNumber:
      settings.orderLookupByNumber && tools.some((tool) => tool.name === "get_order_status"),
    cart: context.cart,
    knownOrders: orders,
    latestMessage: message,
    today: now,
  });
  const signal = AbortSignal.timeout(TURN_DEADLINE_MS);
  const provider = deps.provider;
  const run = (correction = "") =>
    runAssistantTurn({
      provider,
      tools,
      context,
      systemPrompt: systemPrompt + correction,
      history: [...history, { role: "user", content: message }],
      signal,
    });

  let turn;
  try {
    turn = await run();
    // The orders this chat already knows are the shopper's need no proof, and
    // the tools know it. A model that asks for an email or phone number
    // anyway, without having tried a tool, is told so and answers again.
    const namesUnknownOrder =
      /\d{3,}/.test(message) &&
      !orders.some((order) => message.includes(order.name.replace(/^#/, "")));
    if (
      input.audience === "shopper" &&
      orders.length > 0 &&
      !namesUnknownOrder &&
      turn.toolsUsed.length === 0 &&
      asksForProof(turn.reply)
    ) {
      const first = turn.usage;
      turn = await run(
        `\n\nCorrection: your draft reply asked the shopper for an email address or phone number. Do not ask for either. The orders named above are already known to be theirs${signedIn ? " because they are signed in" : ""}. Use your tool now with the order number of the order this conversation is about, and ask only for what the tool's answer says is missing.`,
      );
      turn.usage.inputTokens += first.inputTokens;
      turn.usage.outputTokens += first.outputTokens;
    }
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
    `[shopi-assist] chat turn shop=${input.shop} audience=${input.audience} steps=${turn.steps} tools=${turn.toolsUsed.join(",") || "-"} tokens=${turn.usage.inputTokens}+${turn.usage.outputTokens} cart=${context.cart ? context.cart.length : "-"} ms=${Date.now() - startedAt}`,
  );

  startRetentionSweeper(deps.db);

  // A question whose answers the model wrote out as a list reaches the
  // shopper as that question with buttons. The saved transcript keeps the
  // list, so the model still knows what it offered. Not when products are
  // shown (their cards are the things to pick) or buttons were offered already.
  // Only for a widget that said it can draw them: one loaded before this
  // server was deployed would drop the buttons and show a question with its
  // answers missing.
  const mayOffer =
    input.audience === "shopper" &&
    Boolean(context.clientSupports?.includes("choices")) &&
    turn.cards.length === 0 &&
    !turn.actions.some((action) => action.type === "choices");
  const lifted = mayOffer ? liftChoices(turn.reply) : null;
  // Questions with answers the server already knows, in the order they are
  // asked: which of the shopper's own orders (their numbers), why something
  // is being returned (the store's reason categories), and a plain yes or
  // no. Not while a card with its own button is on its way, which is the
  // answer to give.
  const canReturn = tools.some((tool) => tool.name === "request_return");
  const asksOrder = mayOffer && turn.actions.length === 0 && asksWhichOrder(turn.reply);
  // For a return, only the orders that can be returned right now are worth
  // a button: what the turn already found out, or asked of Shopify here.
  let orderChoices = orders.slice(0, 5).map((order) => order.name);
  if (asksOrder && canReturn && context.admin && /\breturn/i.test(turn.reply)) {
    const returnable =
      context.turn.returnableOrders ??
      (await checkReturnable(context.admin, orders))
        .filter((check) => check.items.length > 0)
        .map((check) => check.name);
    orderChoices = orderChoices.filter((name) => returnable.includes(name));
  }
  const quick =
    !mayOffer || turn.actions.length > 0
      ? null
      : asksOrder && orderChoices.length > 1
        ? orderChoices
        : asksReturnReason(turn.reply) && canReturn
          ? [...RETURN_REASON_LABELS]
          : !lifted && asksYesOrNo(turn.reply)
            ? ["Yes", "No"]
            : null;

  return {
    conversationId: conversation.id,
    reply: lifted ? lifted.text : turn.reply,
    cards: turn.cards,
    // The server's own answers win over ones read out of the reply.
    actions: quick
      ? [{ type: "choices", options: quick, other: true }]
      : lifted
        ? [...turn.actions, { type: "choices", options: lifted.choices, other: true }]
        : turn.actions,
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
