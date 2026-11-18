import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import type {
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmToolCall,
} from "./provider";

export interface OpenAiProviderOptions {
  apiKey: string;
  model: string;
  /** Point at any OpenAI-compatible endpoint (Azure, OpenRouter, a local server). */
  baseURL?: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Injected in tests. */
  client?: Pick<OpenAI, "chat">;
}

export function toOpenAiMessages(
  messages: LlmMessage[],
): ChatCompletionMessageParam[] {
  return messages.map((message): ChatCompletionMessageParam => {
    switch (message.role) {
      case "system":
        return { role: "system", content: message.content };
      case "user":
        return { role: "user", content: message.content };
      case "tool":
        return {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.content,
        };
      case "assistant":
        return {
          role: "assistant",
          content: message.content,
          ...(message.toolCalls?.length
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        };
    }
  });
}

/**
 * Chat Completions adapter. Works with GPT-4o and with any server that speaks
 * the same protocol. Deliberately sends no `temperature`: newer reasoning
 * models reject non-default values, and the default is fine for this use.
 */
export function createOpenAiProvider(
  options: OpenAiProviderOptions,
): LlmProvider {
  const client =
    options.client ??
    new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      timeout: options.timeoutMs ?? 30_000,
      maxRetries: 1,
    });

  return {
    name: `openai:${options.model}`,

    async complete(request: LlmRequest): Promise<LlmResponse> {
      const tools: ChatCompletionTool[] = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));

      const completion = await client.chat.completions.create(
        {
          model: options.model,
          messages: toOpenAiMessages(request.messages),
          ...(tools.length
            ? { tools, tool_choice: request.toolChoice ?? ("auto" as const) }
            : {}),
          max_completion_tokens: options.maxOutputTokens ?? 1200,
        },
        { signal: request.signal },
      );

      const message = completion.choices[0]?.message;
      const toolCalls: LlmToolCall[] = [];
      for (const call of message?.tool_calls ?? []) {
        // Only plain function calls are supported; skip anything else.
        if (call.type !== "function") continue;
        toolCalls.push({
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }

      return {
        content: message?.content ?? null,
        toolCalls,
        usage: completion.usage
          ? {
              inputTokens: completion.usage.prompt_tokens,
              outputTokens: completion.usage.completion_tokens,
            }
          : undefined,
      };
    },
  };
}
