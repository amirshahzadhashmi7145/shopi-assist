import { z } from "zod";

import type { LlmToolCall, LlmToolSpec } from "../llm/provider";
import type { RateLimiter } from "../rate-limit";
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
    allowAddToCart: boolean;
    allowCheckout: boolean;
    allowReturns: boolean;
  };
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
   * Orders already tied to this conversation by the server: placed through
   * its order form, or proved to be the shopper's earlier in the chat.
   */
  knownOrders?: KnownOrder[];
  /** Ties an order the shopper has just proved is theirs to the conversation. */
  rememberOrder?: (order: { id: string; name: string }) => Promise<void>;
  rateLimiter: RateLimiter;
  /** Counters that live for one chat turn, shared by every tool call in it. */
  turn: {
    orderLookups: number;
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
