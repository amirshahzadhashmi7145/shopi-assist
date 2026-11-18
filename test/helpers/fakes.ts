import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
} from "../../app/assistant/llm/provider";
import { RateLimiter } from "../../app/assistant/rate-limit";
import type { ToolContext } from "../../app/assistant/tools/registry";
import type { Audience, GraphqlFn } from "../../app/assistant/types";

/** A provider that replays a fixed list of responses and records every request. */
export function scriptedProvider(responses: LlmResponse[]): LlmProvider & {
  requests: LlmRequest[];
} {
  const requests: LlmRequest[] = [];
  let index = 0;
  return {
    name: "scripted",
    requests,
    async complete(request) {
      // Snapshot: the engine keeps appending to the same messages array.
      requests.push({ ...request, messages: [...request.messages] });
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return response;
    },
  };
}

export const text = (content: string): LlmResponse => ({ content, toolCalls: [] });

export const callTool = (
  name: string,
  args: Record<string, unknown> = {},
  id = `call_${name}`,
): LlmResponse => ({
  content: null,
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
});

/** A GraphQL function that answers from a queue and records what it was asked. */
export function fakeGraphql(...results: Array<unknown | Error>): GraphqlFn & {
  calls: Array<{ query: string; variables?: Record<string, unknown> }>;
} {
  const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  let index = 0;
  const fn = (async (query: string, variables?: Record<string, unknown>) => {
    calls.push({ query, variables });
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    if (result instanceof Error) throw result;
    return result;
  }) as GraphqlFn & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

export function toolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const audience: Audience = overrides.audience ?? "shopper";
  return {
    shop: "test-shop.myshopify.com",
    audience,
    settings: { orderLookupEnabled: false },
    buyer: {},
    rateLimiter: new RateLimiter(),
    now: () => new Date("2026-11-18T12:00:00Z"),
    ...overrides,
  };
}

export function storefrontProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "gid://shopify/Product/1",
    title: "Trail Mug",
    handle: "trail-mug",
    vendor: "Acme",
    productType: "Mugs",
    availableForSale: true,
    onlineStoreUrl: "https://test-shop.example/products/trail-mug",
    description: "An enamel mug.",
    featuredImage: { url: "https://cdn.example/mug.jpg", altText: "A mug" },
    priceRange: {
      minVariantPrice: { amount: "18.0", currencyCode: "USD" },
      maxVariantPrice: { amount: "18.0", currencyCode: "USD" },
    },
    compareAtPriceRange: { maxVariantPrice: { amount: "0.0", currencyCode: "USD" } },
    variants: { nodes: [{ id: "gid://shopify/ProductVariant/101", availableForSale: true }] },
    ...overrides,
  };
}
