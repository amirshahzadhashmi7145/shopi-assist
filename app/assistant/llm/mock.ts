import type { LlmProvider, LlmRequest, LlmResponse } from "./provider";

/**
 * Offline stand-in for a real model, selected with LLM_PROVIDER=mock.
 *
 * It lets you exercise the whole pipeline (widget -> app proxy -> tool call ->
 * Shopify API -> reply) on a dev store without an API key or any spend. It is
 * rule based and not smart: it calls a "best sellers" style tool when asked
 * about popular products and otherwise echoes the question back.
 */
export function createMockProvider(): LlmProvider {
  return {
    name: "mock",

    async complete(request: LlmRequest): Promise<LlmResponse> {
      const last = request.messages[request.messages.length - 1];

      // A tool just ran: summarise what came back.
      if (last?.role === "tool") {
        return {
          content: `[mock model] ${last.name} returned: ${summarise(last.content)}`,
          toolCalls: [],
        };
      }

      const text = last?.role === "user" ? last.content : "";
      const wantsTopProducts = /best|top|popular|selling/i.test(text);
      const topTool = request.tools.find(
        (tool) =>
          tool.name === "get_best_sellers" ||
          tool.name === "get_top_selling_products",
      );

      if (wantsTopProducts && topTool) {
        return {
          content: null,
          toolCalls: [{ id: "mock_call_1", name: topTool.name, arguments: "{}" }],
        };
      }

      return {
        content: `[mock model] You said: "${text.slice(0, 200)}". Set OPENAI_API_KEY and remove LLM_PROVIDER=mock for real answers.`,
        toolCalls: [],
      };
    },
  };
}

function summarise(toolOutput: string): string {
  try {
    const parsed = JSON.parse(toolOutput) as {
      products?: Array<{ title?: string }>;
      error?: string;
    };
    if (parsed.error) return `error "${parsed.error}"`;
    if (Array.isArray(parsed.products)) {
      const titles = parsed.products.map((product) => product.title).filter(Boolean);
      return titles.length ? titles.join(", ") : "no products";
    }
  } catch {
    // Not JSON; fall through to the raw preview.
  }
  return toolOutput.slice(0, 300);
}
