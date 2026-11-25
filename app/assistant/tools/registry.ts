import { z } from "zod";

import type { OrderActionGrant } from "../action-grant.server";
import type { LlmToolCall, LlmToolSpec } from "../llm/provider";
import type { RateLimiter } from "../rate-limit";
import type { ShippingPicks, ShippingRates } from "../shipping";
import type {
  Audience,
  CartLine,
  ClientAction,
  GraphqlFn,
  KnownOrder,
  ProductCard,
} from "../types";

/** Everything a tool may use. Built by the server for one chat turn. */
export interface ToolContext {
  /** The authenticated shop domain, e.g. "example.myshopify.com". */
  shop: string;
  audience: Audience;
  /** Storefront API (public catalog data). Present for shoppers. */
  storefront?: GraphqlFn;
  /**
   * Admin API (private store data). Always present for merchants. For
   * shoppers it is only provided when a merchant setting needs it (order
   * lookup), so a mistakenly tagged tool still has nothing to call.
   */
  admin?: GraphqlFn;
  /** What the merchant has switched on for shoppers. */
  settings: {
    orderLookupEnabled: boolean;
    /** Basic status from the order number alone. Off unless the merchant opts in. */
    orderLookupByNumber?: boolean;
    allowAddToCart: boolean;
    allowCheckout: boolean;
    allowReturns: boolean;
    /** Changes to an existing order. All off unless the merchant opts in. */
    allowOrderCancel?: boolean;
    allowAddressChange?: boolean;
    allowOrderEdit?: boolean;
    /**
     * Whether shoppers can pay when the order arrives, as the merchant
     * picked. It is chosen on the store's checkout page like any other way of
     * paying. Shopify does not tell apps whether a store offers it, so it is
     * the one payment fact that is a setting.
     */
    cashOnDelivery?: "yes" | "no" | "";
  };
  /**
   * Reads the store's shipping zones and rates from Shopify, now. The rates
   * are public (every visitor sees them at the checkout) but live in the
   * Admin API, so a shopper's tools are given this one question to ask
   * instead of an Admin client. Asked more than once in a turn, it gives the
   * same read.
   */
  shippingRates?: () => Promise<ShippingRates>;
  /**
   * The merchant's own picks about delivery, each in words. A pick is said
   * only for what Shopify does not answer: where the store delivers and what
   * that costs when its settings cannot be read, how soon orders leave and
   * how long they take when Shopify holds no figure for it.
   */
  shippingPicks?: ShippingPicks;
  /**
   * What the merchant wrote about shipping in their own words. It is said
   * only when Shopify's settings cannot be read. Given to the assistant
   * alongside them, a note that had fallen behind (other countries, other
   * prices) was repeated as fact next to the real ones.
   */
  shippingNote?: string;
  /**
   * What the page showing the chat has said it can draw, beyond text and
   * product cards. A shopper's browser can be running a widget older than
   * this server, so nothing is handed to it that it has not asked for.
   */
  clientSupports?: readonly string[];
  /**
   * Whether Shopify says this is a development store. Asked only when a
   * lookup limit is reached: such stores get more room for testing.
   */
  isTestStore?: () => Promise<boolean>;
  buyer: {
    /** ISO country code for localized prices, e.g. "US". */
    country?: string;
    /** ISO language code, e.g. "EN". */
    language?: string;
    /** Client IP as reported by Shopify's proxy; used only for throttling. */
    ip?: string;
  };
  /**
   * The shopper's cart as their browser reported it with this message.
   * Missing when it could not be read (and always in the admin preview).
   */
  cart?: CartLine[];
  /**
   * Orders already tied to this conversation by the server: proved to be
   * the shopper's earlier in the chat, or theirs because they are signed in.
   */
  knownOrders?: KnownOrder[];
  /**
   * Signs a grant for one change to one order, for the widget to bring back
   * when the shopper confirms. Missing when the server cannot sign.
   */
  grantOrderAction?: (
    grant: Pick<OrderActionGrant, "orderId" | "orderName" | "kind" | "reason" | "changes" | "countryCode">,
  ) => string;
  /** Ties an order the shopper has just proved is theirs to the conversation. */
  rememberOrder?: (order: { id: string; name: string }) => Promise<void>;
  rateLimiter: RateLimiter;
  /** Counters that live for one chat turn, shared by every tool call in it. */
  turn: {
    orderLookups: number;
    /** The different orders looked into this turn. */
    orderNames?: string[];
    /**
     * The shopper's orders that had something returnable when this turn
     * checked, by name ("#1008"). Unset when the turn did not check.
     */
    returnableOrders?: string[];
  };
  /** Injected clock for tests. */
  now: () => Date;
}

export interface ToolResult {
  /** Sent back to the model as JSON. Keep it compact. */
  output: unknown;
  /** Products the widget may show as cards. */
  cards?: ProductCard[];
  /** Things the widget should do in the browser. */
  actions?: ClientAction[];
}

export interface ToolDefinition<Schema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  /**
   * Which audiences may ever call this tool. This is the security boundary
   * between the public storefront widget and the merchant-only assistant.
   */
  audiences: readonly Audience[];
  schema: Schema;
  /** Optional runtime gate, e.g. a merchant setting or a missing API client. */
  isAvailable?(context: ToolContext): boolean;
  run(args: z.infer<Schema>, context: ToolContext): Promise<ToolResult>;
}

export function defineTool<Schema extends z.ZodType>(
  definition: ToolDefinition<Schema>,
): ToolDefinition<Schema> {
  return definition;
}

/**
 * An error whose message is safe to show to the model (and so, indirectly, to
 * the person chatting). Anything else thrown by a tool is logged and replaced
 * with a generic message.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** The tools this audience may use right now. */
export function toolsFor(
  allTools: readonly ToolDefinition[],
  context: ToolContext,
): ToolDefinition[] {
  return allTools.filter(
    (tool) =>
      tool.audiences.includes(context.audience) &&
      (tool.isAvailable ? tool.isAvailable(context) : true),
  );
}

export function toLlmToolSpecs(tools: readonly ToolDefinition[]): LlmToolSpec[] {
  return tools.map((tool) => {
    // "input" mode: fields with defaults are optional for the model.
    const parameters = z.toJSONSchema(tool.schema, { io: "input" }) as Record<
      string,
      unknown
    >;
    // The "$schema" URL is noise to the model.
    delete parameters.$schema;
    return { name: tool.name, description: tool.description, parameters };
  });
}

export interface ToolExecution {
  name: string;
  ok: boolean;
  /** JSON string handed back to the model. */
  content: string;
  cards: ProductCard[];
  actions: ClientAction[];
}

const MAX_TOOL_OUTPUT_CHARS = 12_000;

/**
 * Runs one tool call requested by the model.
 *
 * `allowedTools` must already be filtered with `toolsFor`; a call to any other
 * name is rejected, so a model that is tricked into requesting a merchant tool
 * from the storefront widget gets an error instead of data.
 */
export async function executeToolCall(
  allowedTools: readonly ToolDefinition[],
  call: LlmToolCall,
  context: ToolContext,
): Promise<ToolExecution> {
  const fail = (message: string): ToolExecution => ({
    name: call.name,
    ok: false,
    content: JSON.stringify({ error: message }),
    cards: [],
    actions: [],
  });

  const tool = allowedTools.find((candidate) => candidate.name === call.name);
  if (!tool) return fail(`Unknown tool "${call.name}".`);

  let rawArgs: unknown;
  try {
    rawArgs = call.arguments.trim() ? JSON.parse(call.arguments) : {};
  } catch {
    return fail("Tool arguments were not valid JSON.");
  }

  const parsed = tool.schema.safeParse(rawArgs);
  if (!parsed.success) {
    const details = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return fail(`Invalid arguments. ${details}`);
  }

  try {
    const result = await tool.run(parsed.data, context);
    let content = JSON.stringify(result.output ?? null);
    if (content.length > MAX_TOOL_OUTPUT_CHARS) {
      content = JSON.stringify({
        truncated: true,
        note: "Result was too large and was cut off. Ask for fewer items.",
        preview: content.slice(0, MAX_TOOL_OUTPUT_CHARS),
      });
    }
    return {
      name: tool.name,
      ok: true,
      content,
      cards: result.cards ?? [],
      actions: result.actions ?? [],
    };
  } catch (error) {
    if (error instanceof ToolError) return fail(error.message);
    // Log the failure for the developer, without arguments (they may hold
    // an email address or other personal data).
    console.error(
      `[shopi-assist] tool "${tool.name}" failed for ${context.shop}:`,
      error instanceof Error ? error.message : "unknown error",
    );
    return fail("The tool failed to run. Tell the user this information is unavailable right now.");
  }
}
