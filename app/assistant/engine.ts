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
import type { ClientAction, ProductCard, StoredMessage } from "./types";

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
const MAX_ACTIONS = 3;

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
    actions: dedupeActions(actions).slice(0, MAX_ACTIONS),
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

function dedupeActions(actions: ClientAction[]): ClientAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = `${action.type}:${action.variantId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
