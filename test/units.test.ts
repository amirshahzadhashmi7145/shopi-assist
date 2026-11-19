import { describe, expect, it } from "vitest";

import { getLlmProvider, getLlmStatus } from "../app/assistant/llm/index.server";
import { createMockProvider } from "../app/assistant/llm/mock";
import { createOpenAiProvider, toOpenAiMessages } from "../app/assistant/llm/openai.server";
import { buildSystemPrompt } from "../app/assistant/prompts";
import { clientKey, DailyBudget, RateLimiter } from "../app/assistant/rate-limit";
import { parseInline, parseRichText, safeHref } from "../app/assistant/rich-text";
import { toGraphqlFn } from "../app/assistant/shopify-clients.server";

describe("RateLimiter", () => {
  it("allows up to the maximum per window, then blocks until the window resets", () => {
    const limiter = new RateLimiter();
    expect(limiter.hit("k", 2, 1000, 0).allowed).toBe(true);
    expect(limiter.hit("k", 2, 1000, 10).allowed).toBe(true);

    const blocked = limiter.hit("k", 2, 1000, 400);
    expect(blocked).toEqual({ allowed: false, retryAfterMs: 600 });

    expect(limiter.hit("k", 2, 1000, 1000).allowed).toBe(true);
  });

  it("tracks keys independently and forgets expired ones", () => {
    const limiter = new RateLimiter();
    limiter.hit("a", 1, 1000, 0);
    expect(limiter.hit("b", 1, 1000, 0).allowed).toBe(true);
    expect(limiter.size).toBe(2);

    limiter.hit("c", 1, 1000, 120_000);
    expect(limiter.size).toBe(1);
  });
});

describe("clientKey", () => {
  it("keeps IPv4 addresses and groups IPv6 by /64", () => {
    expect(clientKey("203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(clientKey(undefined)).toBe("unknown");
    expect(clientKey("")).toBe("unknown");

    const expected = "2001:db8:1:2::/64";
    expect(clientKey("2001:db8:1:2::1")).toBe(expected);
    expect(clientKey("2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd")).toBe(expected);
    expect(clientKey("2001:DB8:1:2:0:0:0:9%eth0")).toBe(expected);
    expect(clientKey("2001:db8:1:3::1")).not.toBe(expected);
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
    // IPv4-mapped addresses are left alone.
    expect(clientKey("::ffff:203.0.113.7")).toBe("::ffff:203.0.113.7");
  });
});

describe("DailyBudget", () => {
  it("accumulates within a UTC day and resets on the next", () => {
    const budget = new DailyBudget();
    budget.add(400, new Date("2026-11-18T01:00:00Z"));
    budget.add(250, new Date("2026-11-18T23:59:59Z"));
    budget.add(-999, new Date("2026-11-18T23:59:59Z"));
    expect(budget.spent(new Date("2026-11-18T23:59:59Z"))).toBe(650);
    expect(budget.spent(new Date("2026-11-19T00:00:00Z"))).toBe(0);
  });
});

describe("rich text", () => {
  it("parses paragraphs, lists, bold and links", () => {
    const blocks = parseRichText(
      "Here are **two** picks:\n\n- [Trail Mug](/products/trail-mug)\n- Camp Kettle\n\n1. First\n2. Second",
    );

    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "list", "list"]);
    expect(blocks[0]).toEqual({
      type: "paragraph",
      lines: [
        [
          { type: "text", text: "Here are " },
          { type: "bold", text: "two" },
          { type: "text", text: " picks:" },
        ],
      ],
    });
    expect(blocks[1]).toMatchObject({ ordered: false });
    expect((blocks[1] as { items: unknown[][] }).items[0]).toEqual([
      { type: "link", text: "Trail Mug", href: "/products/trail-mug" },
    ]);
    expect(blocks[2]).toMatchObject({ ordered: true });
  });

  it("never produces links for unsafe URLs", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>")).toBeNull();
    expect(safeHref("//evil.example")).toBeNull();
    expect(safeHref("https://shop.example/a")).toBe("https://shop.example/a");
    expect(safeHref("/cart")).toBe("/cart");

    expect(parseInline("[click](javascript:alert(1))")[0]).toEqual({ type: "text", text: "click" });
  });

  it("links bare URLs without swallowing trailing punctuation", () => {
    expect(parseInline("See https://shop.example/faq.")).toEqual([
      { type: "text", text: "See " },
      { type: "link", text: "https://shop.example/faq", href: "https://shop.example/faq" },
      { type: "text", text: "." },
    ]);
  });
});

describe("LLM configuration", () => {
  it("defaults to OpenAI gpt-4o and requires a key", () => {
    expect(getLlmStatus({})).toMatchObject({ ready: false, provider: "openai", model: "gpt-4o" });
    expect(getLlmStatus({}).problem).toMatch(/OPENAI_API_KEY/);
    expect(getLlmProvider({})).toBeNull();

    expect(getLlmStatus({ OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-4o-mini" })).toEqual({
      ready: true,
      provider: "openai",
      model: "gpt-4o-mini",
    });
  });

  it("supports mock mode without a key and rejects unknown providers", () => {
    expect(getLlmStatus({ LLM_PROVIDER: "mock" }).ready).toBe(true);
    expect(getLlmProvider({ LLM_PROVIDER: "mock" })!.name).toBe("mock");
    expect(getLlmStatus({ LLM_PROVIDER: "nope" }).ready).toBe(false);
  });

  it("never includes the key in the status", () => {
    const status = getLlmStatus({ OPENAI_API_KEY: "fake-key-value-2" });
    expect(JSON.stringify(status)).not.toContain("fake-key-value-2");
  });
});

describe("OpenAI adapter", () => {
  const fakeClient = (message: Record<string, unknown>) => {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      client: {
        chat: {
          completions: {
            create: async (params: Record<string, unknown>) => {
              calls.push(params);
              return {
                choices: [{ message }],
                usage: { prompt_tokens: 12, completion_tokens: 5 },
              };
            },
          },
        },
      } as never,
    };
  };
  const tool = {
    name: "get_best_sellers",
    description: "List best sellers",
    parameters: { type: "object", properties: {} },
  };

  it("sends tools and maps a tool call back", async () => {
    const { client, calls } = fakeClient({
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "get_best_sellers", arguments: '{"limit":3}' } },
      ],
    });
    const provider = createOpenAiProvider({ apiKey: "k", model: "gpt-4o", client });

    const response = await provider.complete({
      messages: [{ role: "user", content: "top sellers?" }],
      tools: [tool],
    });

    expect(calls[0]).toMatchObject({
      model: "gpt-4o",
      tool_choice: "auto",
      tools: [{ type: "function", function: { name: "get_best_sellers" } }],
    });
    expect(calls[0]).not.toHaveProperty("temperature");
    expect(response.toolCalls).toEqual([
      { id: "call_1", name: "get_best_sellers", arguments: '{"limit":3}' },
    ]);
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
  });

  it("passes tool_choice none and omits tools when there are none", async () => {
    const forced = fakeClient({ content: "Done" });
    await createOpenAiProvider({ apiKey: "k", model: "m", client: forced.client }).complete({
      messages: [],
      tools: [tool],
      toolChoice: "none",
    });
    expect(forced.calls[0].tool_choice).toBe("none");

    const bare = fakeClient({ content: "Done" });
    await createOpenAiProvider({ apiKey: "k", model: "m", client: bare.client }).complete({
      messages: [],
      tools: [],
    });
    expect(bare.calls[0]).not.toHaveProperty("tools");
    expect(bare.calls[0]).not.toHaveProperty("tool_choice");
  });

  it("converts a tool-call transcript to the OpenAI wire format", () => {
    expect(
      toOpenAiMessages([
        { role: "system", content: "s" },
        { role: "user", content: "u" },
        { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "t", arguments: "{}" }] },
        { role: "tool", toolCallId: "c1", name: "t", content: '{"ok":true}' },
        { role: "assistant", content: "a" },
      ]),
    ).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: '{"ok":true}' },
      { role: "assistant", content: "a" },
    ]);
  });
});

describe("mock provider", () => {
  it("calls the best-seller tool when asked about popular products", async () => {
    const provider = createMockProvider();
    const response = await provider.complete({
      messages: [{ role: "user", content: "What are your top selling items?" }],
      tools: [{ name: "get_best_sellers", description: "", parameters: {} }],
    });
    expect(response.toolCalls[0].name).toBe("get_best_sellers");
  });
});

describe("system prompts", () => {
  const input = {
    shopName: "Alpine Outfitters",
    orderLookupEnabled: false,
    today: new Date("2026-11-18T00:00:00Z"),
  };

  it("tells the shopper assistant it has no private store data", () => {
    const prompt = buildSystemPrompt({ ...input, audience: "shopper" });
    expect(prompt).toContain("Alpine Outfitters");
    expect(prompt).toContain("2026-11-18");
    expect(prompt).toMatch(/no access to the store's private data/);
    expect(prompt).toMatch(/cannot look up orders/);
  });

  it("caps merchant guidance and keeps it below the fixed rules", () => {
    const prompt = buildSystemPrompt({
      ...input,
      audience: "shopper",
      merchantInstructions: "x".repeat(5000),
    });
    expect(prompt.match(/x+/g)!.sort((a, b) => b.length - a.length)[0]).toHaveLength(2000);
    expect(prompt.indexOf("Rules:")).toBeLessThan(prompt.indexOf("Additional guidance"));
  });

  it("tells the shopper assistant not to add figures of its own and to share partial answers", () => {
    const prompt = buildSystemPrompt({ ...input, audience: "shopper" });
    expect(prompt).toMatch(/Do not add specific figures of your own/);
    expect(prompt).toMatch(/only when it comes from a tool result or the store owner's notes/);
    expect(prompt).toMatch(/answer only part of a question, share that part/);
  });

  it("adds no owner section when the merchant wrote nothing", () => {
    const prompt = buildSystemPrompt({ ...input, audience: "shopper" });
    expect(prompt).not.toContain("Notes from the store owner");
    expect(prompt).toContain("Warm, friendly and brief");
    expect(prompt).toContain("You are the shopping assistant for Alpine Outfitters");
  });

  it("caps each owner note so a long answer cannot crowd out the rules", () => {
    const prompt = buildSystemPrompt({
      ...input,
      audience: "shopper",
      knowledge: { faq: "q".repeat(9000), returnPolicy: "r".repeat(9000) },
    });
    expect(prompt.match(/q+/g)!.sort((a, b) => b.length - a.length)[0]).toHaveLength(3000);
    expect(prompt.match(/r{100,}/g)![0]).toHaveLength(1500);
  });

  it("explains ordering in chat only when the assistant can do it", () => {
    const abilities = { addToCart: true, checkout: true, returns: false };
    const noPayment = /never ask for an address, phone number or card details in chat/;

    const full = buildSystemPrompt({
      ...input,
      audience: "shopper",
      abilities: { ...abilities, placeOrder: true },
    });
    expect(full).toMatch(/start the order once with every item/);
    expect(full).toMatch(/do not add the same items to the cart separately/);
    expect(full).toMatch(noPayment);
    expect(full).toMatch(/never say an order has been placed/);

    // Checkout on, cart off: the assistant can only show what is in the cart.
    const checkoutOnly = buildSystemPrompt({
      ...input,
      audience: "shopper",
      abilities: { ...abilities, addToCart: false },
    });
    expect(checkoutOnly).not.toMatch(/start the order/);
    expect(checkoutOnly).toMatch(/show them the checkout summary/);
    expect(checkoutOnly).toMatch(noPayment);

    const none = buildSystemPrompt({
      ...input,
      audience: "shopper",
      abilities: { ...abilities, checkout: false },
    });
    expect(none).toMatch(/You cannot start a checkout/);
    expect(none).not.toMatch(/start the order/);
  });

  it("keeps owner notes out of the merchant assistant's prompt", () => {
    const prompt = buildSystemPrompt({
      ...input,
      audience: "merchant",
      assistantName: "Ava",
      knowledge: { businessDescription: "Snowboards" },
    });
    expect(prompt).not.toContain("Snowboards");
    expect(prompt).not.toContain("Ava");
  });

  it("tells the merchant assistant it is read-only", () => {
    expect(buildSystemPrompt({ ...input, audience: "merchant" })).toMatch(/read-only/);
  });
});

describe("toGraphqlFn", () => {
  const client = (body: unknown) => ({ graphql: async () => Response.json(body) });

  it("returns data and throws on GraphQL errors", async () => {
    expect(await toGraphqlFn(client({ data: { ok: 1 } }), "Admin")("q")).toEqual({ ok: 1 });
    await expect(
      toGraphqlFn(client({ errors: [{ message: "Access denied" }] }), "Admin")("q"),
    ).rejects.toThrow("Admin GraphQL error: Access denied");
    await expect(toGraphqlFn(client({}), "Storefront")("q")).rejects.toThrow(/no data/);
  });
});
