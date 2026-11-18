import { beforeEach, describe, expect, it, vi } from "vitest";

// The route's two collaborators are replaced so the test can see exactly what
// the route passes along. Shopify's signature check itself is exercised in the
// live smoke test (see README), not here.
const appProxy = vi.fn();
const handleChatTurn = vi.fn();

vi.mock("../app/shopify.server", () => ({
  authenticate: { public: { appProxy: (request: Request) => appProxy(request) } },
}));

vi.mock("../app/assistant/chat.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app/assistant/chat.server")>();
  return { ...original, handleChatTurn: (...args: unknown[]) => handleChatTurn(...args) };
});

vi.mock("../app/assistant/settings.server", () => ({
  getSettings: async () => ({ enabled: true }),
}));

const { action, loader } = await import("../app/routes/proxy.chat");
const { ChatError } = await import("../app/assistant/chat.server");

const SHOP = "real-shop.myshopify.com";
const graphqlClient = { graphql: async () => Response.json({ data: {} }) };
const installed = { session: { shop: SHOP }, admin: graphqlClient, storefront: graphqlClient };

const post = (body: unknown, query = "", headers: Record<string, string> = {}) =>
  new Request(`https://app.example/proxy/chat?shop=${SHOP}&signature=abc${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const run = (request: Request) =>
  action({ request, params: {}, context: {} } as unknown as Parameters<typeof action>[0]) as Promise<Response>;

beforeEach(() => {
  appProxy.mockReset().mockResolvedValue(installed);
  handleChatTurn.mockReset().mockResolvedValue({
    conversationId: "c123456789",
    reply: "Hello",
    cards: [],
    actions: [],
  });
});

describe("POST /proxy/chat", () => {
  it("authenticates before doing anything else and returns the reply", async () => {
    const response = await run(post({ message: "hi", visitorId: "visitor-0001" }));

    expect(appProxy).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ reply: "Hello", conversationId: "c123456789" });
  });

  it("propagates Shopify's rejection of an unsigned request", async () => {
    appProxy.mockRejectedValue(new Response(undefined, { status: 400 }));

    const thrown = await run(post({ message: "hi" })).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(400);
    expect(handleChatTurn).not.toHaveBeenCalled();
  });

  it("takes the shop and audience from the signed request, never from the body", async () => {
    await run(
      post({
        message: "hi",
        visitorId: "visitor-0001",
        shop: "victim-shop.myshopify.com",
        audience: "merchant",
        customerId: "42",
      }),
    );

    const input = handleChatTurn.mock.calls[0][0];
    expect(input.shop).toBe(SHOP);
    expect(input.audience).toBe("shopper");
    expect(input.customerId).toBeNull();
  });

  it("uses the customer id Shopify signed into the query string", async () => {
    await run(post({ message: "hi", visitorId: "visitor-0001" }, "&logged_in_customer_id=987"));
    expect(handleChatTurn.mock.calls[0][0].customerId).toBe("987");
  });

  it("uses the first forwarded address for rate limiting", async () => {
    await run(
      post({ message: "hi", visitorId: "visitor-0001" }, "", {
        "X-Forwarded-For": "203.0.113.7, 10.0.0.1",
      }),
    );
    expect(handleChatTurn.mock.calls[0][0].ip).toBe("203.0.113.7");
  });

  it("returns 404 when the app is not installed on the shop", async () => {
    appProxy.mockResolvedValue({ session: undefined, admin: undefined, storefront: undefined });

    const response = await run(post({ message: "hi" }));

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_installed");
    expect(handleChatTurn).not.toHaveBeenCalled();
  });

  it("rejects malformed and oversized bodies", async () => {
    expect((await run(post("{not json"))).status).toBe(400);
    expect((await run(post("[1,2,3]"))).status).toBe(400);
    expect((await run(post({ message: "x".repeat(20_000) }))).status).toBe(413);
    expect(handleChatTurn).not.toHaveBeenCalled();
  });

  it("turns chat errors into JSON the widget can show", async () => {
    handleChatTurn.mockRejectedValue(new ChatError("rate_limited", 429, "Slow down.", 30));

    const response = await run(post({ message: "hi", visitorId: "visitor-0001" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(await response.json()).toEqual({
      error: { code: "rate_limited", message: "Slow down." },
    });
  });

  it("does not leak internal error details", async () => {
    handleChatTurn.mockRejectedValue(new Error("SQLITE_ERROR at /srv/app/db.ts:10"));

    const response = await run(post({ message: "hi", visitorId: "visitor-0001" }));

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("SQLITE");
  });
});

describe("GET /proxy/chat", () => {
  it("reports status for an installed shop", async () => {
    const response = (await loader({
      request: new Request(`https://app.example/proxy/chat?shop=${SHOP}`),
      params: {},
      context: {},
    } as unknown as Parameters<typeof loader>[0])) as Response;

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, enabled: true });
  });
});
