import { beforeEach, describe, expect, it, vi } from "vitest";

// As in the chat route's test, the route's collaborators are replaced so the
// test can see exactly what the route passes along.
const appProxy = vi.fn();
const handleChatOrder = vi.fn();
const listDeliveryCountries = vi.fn();

vi.mock("../app/shopify.server", () => ({
  authenticate: { public: { appProxy: (request: Request) => appProxy(request) } },
}));

vi.mock("../app/assistant/orders.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app/assistant/orders.server")>();
  return {
    ...original,
    handleChatOrder: (...args: unknown[]) => handleChatOrder(...args),
    listDeliveryCountries: (...args: unknown[]) => listDeliveryCountries(...args),
  };
});

const { action, loader } = await import("../app/routes/proxy.order");
const { OrderError } = await import("../app/assistant/orders.server");

const SHOP = "real-shop.myshopify.com";
const graphqlClient = { graphql: async () => Response.json({ data: {} }) };
const installed = { session: { shop: SHOP }, admin: graphqlClient, storefront: graphqlClient };

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://app.example/proxy/order?shop=${SHOP}&signature=abc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.7, 10.0.0.1", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

type RouteArgs = Parameters<typeof action>[0];
const run = (request: Request) =>
  action({ request, params: {}, context: {} } as unknown as RouteArgs) as Promise<Response>;
const get = (query = "") =>
  loader({
    request: new Request(`https://app.example/proxy/order?shop=${SHOP}&signature=abc${query}`),
    params: {},
    context: {},
  } as unknown as Parameters<typeof loader>[0]) as Promise<Response>;

beforeEach(() => {
  appProxy.mockReset().mockResolvedValue(installed);
  handleChatOrder.mockReset().mockResolvedValue({
    ok: true,
    step: "place",
    order: { name: "#1001", total: { amount: "44.6", currencyCode: "USD" } },
  });
  listDeliveryCountries.mockReset().mockResolvedValue([{ code: "CA", name: "Canada" }]);
});

describe("POST /proxy/order", () => {
  it("authenticates first and takes the shop from the signed request, never the body", async () => {
    const response = await run(post({ step: "place", shop: "victim-shop.myshopify.com" }));

    expect(appProxy).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ ok: true, order: { name: "#1001" } });

    const input = handleChatOrder.mock.calls[0][0];
    expect(input.shop).toBe(SHOP);
    expect(input.ip).toBe("203.0.113.7");
    expect(input.body).toEqual({ step: "place", shop: "victim-shop.myshopify.com" });
    expect(typeof input.admin).toBe("function");
    expect(typeof input.storefront).toBe("function");
  });

  it("propagates Shopify's rejection of an unsigned request", async () => {
    appProxy.mockRejectedValue(new Response(undefined, { status: 400 }));

    const thrown = await run(post({ step: "place" })).catch((error: unknown) => error);

    expect((thrown as Response).status).toBe(400);
    expect(handleChatOrder).not.toHaveBeenCalled();
  });

  it("refuses requests another website could make a browser send", async () => {
    const form = await run(post("step=place", { "Content-Type": "text/plain" }));
    expect(form.status).toBe(415);

    const crossSite = await run(post({ step: "place" }, { "Sec-Fetch-Site": "cross-site" }));
    expect(crossSite.status).toBe(403);

    expect(handleChatOrder).not.toHaveBeenCalled();
  });

  it("refuses other methods, oversized bodies and shops without the app", async () => {
    const put = await run(
      new Request(`https://app.example/proxy/order?shop=${SHOP}`, { method: "PUT" }),
    );
    expect(put.status).toBe(405);

    const huge = await run(post({ step: "place", note: "x".repeat(20_000) }));
    expect(huge.status).toBe(413);

    appProxy.mockResolvedValue({ session: undefined, admin: undefined, storefront: undefined });
    const notInstalled = await run(post({ step: "place" }));
    expect(notInstalled.status).toBe(404);

    expect(handleChatOrder).not.toHaveBeenCalled();
  });

  it("returns field errors and a changed quote in a form the widget can show", async () => {
    handleChatOrder.mockRejectedValueOnce(
      new OrderError("invalid_order", 422, "Please check the highlighted details.", {
        fields: { phone: "Enter a phone number with 7 to 15 digits." },
      }),
    );
    // Sent as a 200 so that Shopify's proxy lets the body through.
    const invalid = await run(post({ step: "quote" }));
    expect(invalid.status).toBe(200);
    expect(await invalid.json()).toEqual({
      ok: false,
      error: {
        code: "invalid_order",
        message: "Please check the highlighted details.",
        fields: { phone: "Enter a phone number with 7 to 15 digits." },
        status: 422,
      },
    });

    handleChatOrder.mockRejectedValueOnce(
      new OrderError("rate_limited", 429, "Too many orders.", { retryAfterSeconds: 90 }),
    );
    const limited = await run(post({ step: "place" }));
    expect(limited.status).toBe(200);
    expect((await limited.json()).error).toMatchObject({ code: "rate_limited", status: 429 });

    const quote = { total: { amount: "54.6", currencyCode: "USD" } };
    handleChatOrder.mockRejectedValueOnce(
      new OrderError("quote_changed", 409, "The total has changed.", { quote: quote as never }),
    );
    const changed = await (await run(post({ step: "place" }))).json();
    expect(changed).toMatchObject({ ok: false, error: { code: "quote_changed" }, quote });

    handleChatOrder.mockRejectedValueOnce(new Error("12 Analytical Way"));
    const crashed = await (await run(post({ step: "place" }))).json();
    expect(crashed.error.status).toBe(500);
    expect(JSON.stringify(crashed)).not.toContain("Analytical");
  });
});

describe("GET /proxy/order", () => {
  it("returns the delivery countries for the signed shop", async () => {
    const response = await get("&language=fr");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, countries: [{ code: "CA", name: "Canada" }] });
    expect(listDeliveryCountries.mock.calls[0][0]).toMatchObject({ shop: SHOP, language: "fr" });
  });

  it("says when ordering in the chat is switched off", async () => {
    listDeliveryCountries.mockRejectedValue(
      new OrderError("disabled", 403, "Ordering in the chat is not available for this store."),
    );
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "disabled", status: 403 },
    });
  });
});
