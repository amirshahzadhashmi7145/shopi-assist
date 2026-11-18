/**
 * Provider-neutral LLM contract. The engine only knows about this interface,
 * so swapping GPT-4o for another model means writing one adapter file.
 */

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface LlmToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments object. */
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw JSON string exactly as the model produced it. Validated before use. */
  arguments: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  tools: LlmToolSpec[];
  /**
   * "auto" (default) lets the model decide. "none" forces a plain-text answer
   * while still describing the tools, which keeps earlier tool calls in the
   * transcript valid.
   */
  toolChoice?: "auto" | "none";
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  content: string | null;
  toolCalls: LlmToolCall[];
  usage?: LlmUsage;
}

export interface LlmProvider {
  readonly name: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}
