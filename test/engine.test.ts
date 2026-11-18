import { describe, expect, it } from "vitest";
import { z } from "zod";

import { EMPTY_REPLY_FALLBACK, runAssistantTurn, selectCards } from "../app/assistant/engine";
import { defineTool, toolsFor } from "../app/assistant/tools/registry";
import type { ProductCard } from "../app/assistant/types";
import { callTool, scriptedProvider, text, toolContext } from "./helpers/fakes";

const card = (title: string, handle: string): ProductCard => ({
  id: `gid://shopify/Product/${handle}`,
  title,
  handle,
  url: `https://shop.example/products/${handle}`,
  imageUrl: null,
  imageAlt: null,
  price: { amount: "10.0", currencyCode: "USD" },
  compareAtPrice: null,
  available: true,
  variantId: "1",
});

const bestSellers = defineTool({
  name: "get_best_sellers",
  description: "test tool",
  audiences: ["shopper"],
  schema: z.object({ limit: z.number().int().min(1).max(10).default(3) }),
  async run({ limit }) {
    return {
      output: { limit, products: [{ title: "Trail Mug" }, { title: "Camp Kettle" }] },
      cards: [card("Trail Mug", "trail-mug"), card("Camp Kettle", "camp-kettle")],
    };
  },
});

const base = () => {
  const context = toolContext();
  return { context, tools: toolsFor([bestSellers], context), systemPrompt: "system" };
};

describe("runAssistantTurn", () => {
  it("returns a plain answer when the model calls no tools", async () => {
    const provider = scriptedProvider([text("Hello there")]);
    const result = await runAssistantTurn({
      ...base(),
      provider,
      history: [{ role: "user", content: "hi" }],
    });

    expect(result.reply).toBe("Hello there");
    expect(result.steps).toBe(1);
    expect(result.toolsUsed).toEqual([]);
    expect(provider.requests[0].messages[0]).toEqual({ role: "system", content: "system" });
  });

  it("runs a requested tool and feeds its result back to the model", async () => {
    const provider = scriptedProvider([
      callTool("get_best_sellers", { limit: 2 }),
      text("Our top pick is the Trail Mug."),
    ]);
    const result = await runAssistantTurn({
      ...base(),
      provider,
      history: [{ role: "user", content: "best sellers?" }],
    });

    expect(result.toolsUsed).toEqual(["get_best_sellers"]);
    expect(result.steps).toBe(2);

    const second = provider.requests[1].messages;
    const toolMessage = second[second.length - 1];
    expect(toolMessage.role).toBe("tool");
    expect(JSON.parse((toolMessage as { content: string }).content)).toMatchObject({
      limit: 2,
      products: [{ title: "Trail Mug" }, { title: "Camp Kettle" }],
    });
  });

  it("only returns cards for products the reply actually names", async () => {
    const provider = scriptedProvider([
      callTool("get_best_sellers"),
      text("Our top pick is the **Trail Mug**."),
    ]);
    const result = await runAssistantTurn({
      ...base(),
      provider,
      history: [{ role: "user", content: "best sellers?" }],
    });

    expect(result.cards.map((c) => c.handle)).toEqual(["trail-mug"]);
  });

  it("reports unknown tools to the model instead of failing the turn", async () => {
    const provider = scriptedProvider([
      callTool("get_top_selling_products"),
      text("I can't access sales data."),
    ]);
    const result = await runAssistantTurn({
      ...base(),
      provider,
      history: [{ role: "user", content: "show me sales" }],
    });

    const toolMessage = provider.requests[1].messages.at(-1) as { content: string };
    expect(JSON.parse(toolMessage.content).error).toMatch(/Unknown tool/);
    expect(result.reply).toBe("I can't access sales data.");
  });

  it("rejects invalid tool arguments with a readable error", async () => {
    const provider = scriptedProvider([
      callTool("get_best_sellers", { limit: 500 }),
      text("Sorry."),
    ]);
    await runAssistantTurn({
      ...base(),
      provider,
      history: [{ role: "user", content: "x" }],
    });

    const toolMessage = provider.requests[1].messages.at(-1) as { content: string };
    expect(JSON.parse(toolMessage.content).error).toMatch(/Invalid arguments.*limit/);
  });

  it("handles tool arguments that are not valid JSON", async () => {
    const provider = scriptedProvider([
      { content: null, toolCalls: [{ id: "c1", name: "get_best_sellers", arguments: "{oops" }] },
      text("Sorry."),
    ]);
    await runAssistantTurn({ ...base(), provider, history: [{ role: "user", content: "x" }] });

    const toolMessage = provider.requests[1].messages.at(-1) as { content: string };
    expect(JSON.parse(toolMessage.content).error).toMatch(/not valid JSON/);
  });

  it("forbids tool calls on the final step so the turn always ends in text", async () => {
    // A model that would loop forever if allowed.
    const provider = scriptedProvider([callTool("get_best_sellers")]);
    const result = await runAssistantTurn({
      ...base(),
      provider,
      maxSteps: 3,
      history: [{ role: "user", content: "x" }],
    });

    expect(provider.requests).toHaveLength(3);
    expect(provider.requests.map((request) => request.toolChoice)).toEqual([
      "auto",
      "auto",
      "none",
    ]);
    // The scripted model still returned no text, so the fallback is used.
    expect(result.reply).toBe(EMPTY_REPLY_FALLBACK);
  });

  it("keeps every tool call in the transcript paired with a result", async () => {
    const manyCalls = {
      content: null,
      toolCalls: Array.from({ length: 6 }, (_, index) => ({
        id: `c${index}`,
        name: "get_best_sellers",
        arguments: "{}",
      })),
    };
    const provider = scriptedProvider([manyCalls, text("Done.")]);
    await runAssistantTurn({ ...base(), provider, history: [{ role: "user", content: "x" }] });

    const messages = provider.requests[1].messages;
    const assistant = messages.find((message) => message.role === "assistant") as {
      toolCalls: Array<{ id: string }>;
    };
    const toolResults = messages.filter((message) => message.role === "tool") as Array<{
      toolCallId: string;
    }>;
    expect(assistant.toolCalls).toHaveLength(4);
    expect(toolResults.map((message) => message.toolCallId)).toEqual(
      assistant.toolCalls.map((call) => call.id),
    );
  });

  it("adds up token usage across steps", async () => {
    const provider = scriptedProvider([
      { ...callTool("get_best_sellers"), usage: { inputTokens: 100, outputTokens: 10 } },
      { ...text("Done."), usage: { inputTokens: 150, outputTokens: 20 } },
    ]);
    const result = await runAssistantTurn({
      ...base(),
      provider,
      history: [{ role: "user", content: "x" }],
    });
    expect(result.usage).toEqual({ inputTokens: 250, outputTokens: 30 });
  });
});

describe("selectCards", () => {
  it("matches titles case-insensitively, de-duplicates and caps the list", () => {
    const cards = [
      card("Trail Mug", "trail-mug"),
      card("Trail Mug", "trail-mug"),
      card("Camp Kettle", "camp-kettle"),
      ...Array.from({ length: 8 }, (_, index) => card(`Item ${index}`, `item-${index}`)),
    ];
    const reply = `try the TRAIL  MUG, or ${Array.from({ length: 8 }, (_, i) => `Item ${i}`).join(", ")}`;

    const selected = selectCards(reply, cards);
    expect(selected).toHaveLength(6);
    expect(selected[0].handle).toBe("trail-mug");
    expect(selected.filter((c) => c.handle === "trail-mug")).toHaveLength(1);
    expect(selected.some((c) => c.handle === "camp-kettle")).toBe(false);
  });
});
