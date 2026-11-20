import type {
  LlmMessage,
  LlmProvider,
  LlmUsage,
} from "./llm/provider";
import {
  executeToolCall,
  toLlmToolSpecs,
  type ToolContext,
  type ToolDefinition,
} from "./tools/registry";
import type { ClientAction, OrderItem, ProductCard, StoredMessage } from "./types";

export interface AssistantTurnInput {
  provider: LlmProvider;
  /** Tools already filtered for this audience with `toolsFor`. */
  tools: ToolDefinition[];
  context: ToolContext;
  systemPrompt: string;
  /** Prior turns followed by the new user message. */
  history: StoredMessage[];
  /** Maximum number of model calls in this turn. */
  maxSteps?: number;
  signal?: AbortSignal;
}

export interface AssistantTurnResult {
  reply: string;
  cards: ProductCard[];
  actions: ClientAction[];
  toolsUsed: string[];
  steps: number;
  usage: LlmUsage;
}

const DEFAULT_MAX_STEPS = 5;
const MAX_TOOL_CALLS_PER_STEP = 4;
const MAX_CARDS = 6;
const MAX_ACTIONS = 4;

export const EMPTY_REPLY_FALLBACK =
  "Sorry, I couldn't put an answer together for that. Could you rephrase it?";

/**
 * Runs one assistant turn: ask the model, run any tools it requests, feed the
 * results back, and repeat until it answers in text or the step budget runs
 * out. On the final step the model is told not to call tools, so a turn always
 * ends with a text reply.
 */
export async function runAssistantTurn(
  input: AssistantTurnInput,
): Promise<AssistantTurnResult> {
  const maxSteps = Math.max(1, input.maxSteps ?? DEFAULT_MAX_STEPS);
  const toolSpecs = toLlmToolSpecs(input.tools);

  const messages: LlmMessage[] = [
    { role: "system", content: input.systemPrompt },
    ...input.history.map(
      (message): LlmMessage => ({ role: message.role, content: message.content }),
    ),
  ];

  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  const seenCards: ProductCard[] = [];
  const actions: ClientAction[] = [];
  const toolsUsed: string[] = [];
  let reply = "";
  let steps = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    const isLastStep = step === maxSteps - 1;
    // Stop spending tokens once the turn's deadline has passed.
    input.signal?.throwIfAborted();
    steps += 1;

    const response = await input.provider.complete({
      messages,
      tools: toolSpecs,
      toolChoice: isLastStep ? "none" : "auto",
      signal: input.signal,
    });
    usage.inputTokens += response.usage?.inputTokens ?? 0;
    usage.outputTokens += response.usage?.outputTokens ?? 0;

    if (isLastStep || response.toolCalls.length === 0) {
      reply = (response.content ?? "").trim();
      break;
    }

    // Every tool call kept in the transcript must get a matching result, so
    // calls beyond the per-step cap are dropped from the assistant message.
    const calls = response.toolCalls.slice(0, MAX_TOOL_CALLS_PER_STEP);
    messages.push({ role: "assistant", content: response.content, toolCalls: calls });

    for (const call of calls) {
      const execution = await executeToolCall(input.tools, call, input.context);
      toolsUsed.push(execution.name);
      seenCards.push(...execution.cards);
      actions.push(...execution.actions);
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: execution.content,
      });
    }
  }

  if (!reply) reply = EMPTY_REPLY_FALLBACK;

  return {
    reply,
    cards: selectCards(reply, seenCards),
    actions: dedupeActions(actions),
    toolsUsed,
    steps,
    usage,
  };
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Keeps only the products the reply actually names, in the order they were
 * fetched. Tools often fetch more products than the model ends up
 * recommending; showing all of them would contradict the text.
 */
export function selectCards(reply: string, cards: ProductCard[]): ProductCard[] {
  const haystack = normalise(reply);
  const seen = new Set<string>();
  const selected: ProductCard[] = [];

  for (const card of cards) {
    if (seen.has(card.handle)) continue;
    const title = normalise(card.title);
    if (!title || !haystack.includes(title)) continue;
    seen.add(card.handle);
    selected.push(card);
    if (selected.length === MAX_CARDS) break;
  }
  return selected;
}

const MAX_ORDER_ITEMS = 10;

/**
 * Turns what the tools asked for into the short list the widget runs, in the
 * order it runs them: empty the cart, take items out, add items, then at most
 * one order summary.
 *
 * Several orders in one turn become one order. An order already ends with the
 * checkout button, so a separate "checkout" is dropped when there is one. The
 * summary goes last so it shows the cart after every change has landed.
 */
export function dedupeActions(actions: ClientAction[]): ClientAction[] {
  const adds = new Map<string, ClientAction>();
  const removes = new Map<string, ClientAction>();
  const orderItems = new Map<string, OrderItem>();
  const cards = new Map<string, ClientAction>();
  let wantsCheckout = false;
  let clear = false;
  let replace = false;

  for (const action of actions) {
    if (action.type === "add_to_cart") {
      if (!adds.has(action.variantId)) adds.set(action.variantId, action);
    } else if (action.type === "remove_from_cart") {
      if (!removes.has(action.variantId)) removes.set(action.variantId, action);
    } else if (action.type === "order_action") {
      // The latest card for an order replaces an earlier one in the same turn.
      cards.set(action.order, action);
    } else if (action.type === "clear_cart") {
      clear = true;
    } else if (action.type === "order") {
      replace = replace || action.replace === true;
      for (const item of action.items) {
        const known = orderItems.get(item.variantId);
        // The same item asked for twice means the larger quantity, not both.
        if (!known || item.quantity > known.quantity) orderItems.set(item.variantId, item);
      }
    } else {
      wantsCheckout = true;
    }
  }

  const summary: ClientAction | null = orderItems.size
    ? {
        type: "order",
        items: [...orderItems.values()].slice(0, MAX_ORDER_ITEMS),
        // Emptying the cart and then ordering is one thing: an order of only these items.
        ...(replace || clear ? { replace: true } : {}),
      }
    : wantsCheckout
      ? { type: "checkout" }
      : null;

  const emptiesCart = clear || (summary?.type === "order" && summary.replace === true);
  const changes: ClientAction[] = [
    ...(clear && summary?.type !== "order" ? [{ type: "clear_cart" } as const] : []),
    // Nothing is left to take out of a cart that is being emptied.
    ...(emptiesCart ? [] : removes.values()),
    ...adds.values(),
  ];
  const cart = summary
    ? [...changes.slice(0, MAX_ACTIONS - 1), summary]
    : changes.slice(0, MAX_ACTIONS);
  // Cards for changes to existing orders stand apart from the cart, and come last.
  return [...cart, ...[...cards.values()].slice(0, 2)];
}
