import { beforeEach, describe, expect, it, vi } from "vitest";

// As in the chat route's test, the route's collaborators are replaced so the
// test can see exactly what the route passes along.
const appProxy = vi.fn();
const openCheckout = vi.fn();
const handleOrderAction = vi.fn();
const listDeliveryCountries = vi.fn();

vi.mock("../app/shopify.server", () => ({
  authenticate: { public: { appProxy: (request: Request) => appProxy(request) } },
}));

vi.mock("../app/assistant/orders.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app/assistant/orders.server")>();
  return {
    ...original,
    openCheckout: (...args: unknown[]) => openCheckout(...args),
    listDeliveryCountries: (...args: unknown[]) => listDeliveryCountries(...args),
  };
});

vi.mock("../app/assistant/order-actions.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app/assistant/order-actions.server")>();
  return { ...original, handleOrderAction: (...args: unknown[]) => handleOrderAction(...args) };
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
  openCheckout.mockReset().mockResolvedValue({
    ok: true,
    step: "checkout",
    checkoutUrl: "https://real-shop.example/cart/c/abc?key=1",
  });
  // Reset here too, so no test depends on which ran before it.
  handleOrderAction.mockReset();
  listDeliveryCountries.mockReset().mockResolvedValue({
    countries: [{ code: "CA", name: "Canada", form: 0 }],
    forms: [[[{ name: "lastName", label: "Last name", required: true }]]],
  });
});

describe("POST /proxy/order", () => {
  const checkoutBody = { step: "checkout", items: [{ variantId: "101", quantity: 1 }] };

  it("authenticates first and takes the shop from the signed request, never the body", async () => {
    const response = await run(post({ ...checkoutBody, shop: "victim-shop.myshopify.com" }));

    expect(appProxy).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      ok: true,
      step: "checkout",
      checkoutUrl: "https://real-shop.example/cart/c/abc?key=1",
    });

    const input = openCheckout.mock.calls[0][0];
    expect(input.shop).toBe(SHOP);
    expect(input.ip).toBe("203.0.113.7");
    expect(input.body).toEqual({ ...checkoutBody, shop: "victim-shop.myshopify.com" });
    expect(typeof input.storefront).toBe("function");
    // A checkout is a cart on the storefront: it is given no Admin API access.
    expect(input).not.toHaveProperty("admin");
  });

  it("places no order: that is the checkout page's job, however the shopper pays", async () => {
    // What a widget from before this change, still open in a browser, would send.
    for (const step of ["quote", "place", "refund", undefined]) {
      const response = await run(post({ step, items: [{ variantId: "101", quantity: 1 }] }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: false,
        error: {
          code: "disabled",
          status: 403,
          message: "Orders are placed on the store's checkout page. Please use the checkout.",
        },
      });
    }
    expect(openCheckout).not.toHaveBeenCalled();
    expect(handleOrderAction).not.toHaveBeenCalled();
  });

  it("propagates Shopify's rejection of an unsigned request", async () => {
    appProxy.mockRejectedValue(new Response(undefined, { status: 400 }));

    const thrown = await run(post(checkoutBody)).catch((error: unknown) => error);

    expect((thrown as Response).status).toBe(400);
    expect(openCheckout).not.toHaveBeenCalled();
  });

  it("refuses requests another website could make a browser send", async () => {
    const form = await run(post("step=checkout", { "Content-Type": "text/plain" }));
    expect(form.status).toBe(415);

    const crossSite = await run(post(checkoutBody, { "Sec-Fetch-Site": "cross-site" }));
    expect(crossSite.status).toBe(403);

    expect(openCheckout).not.toHaveBeenCalled();
  });

  it("refuses other methods, oversized bodies and shops without the app", async () => {
    const put = await run(
      new Request(`https://app.example/proxy/order?shop=${SHOP}`, { method: "PUT" }),
    );
    expect(put.status).toBe(405);

    const huge = await run(post({ ...checkoutBody, note: "x".repeat(20_000) }));
    expect(huge.status).toBe(413);

    appProxy.mockResolvedValue({ session: undefined, admin: undefined, storefront: undefined });
    const notInstalled = await run(post(checkoutBody));
    expect(notInstalled.status).toBe(404);

    expect(openCheckout).not.toHaveBeenCalled();
  });

  it("returns errors in a form the widget can show", async () => {
    openCheckout.mockRejectedValueOnce(
      new OrderError("unavailable", 409, "These items are sold out, so they can't be bought right now."),
    );
    // Sent as a 200 so that Shopify's proxy lets the body through.
    const soldOut = await run(post(checkoutBody));
    expect(soldOut.status).toBe(200);
    expect(await soldOut.json()).toEqual({
      ok: false,
      error: {
        code: "unavailable",
        message: "These items are sold out, so they can't be bought right now.",
        status: 409,
      },
    });

    openCheckout.mockRejectedValueOnce(
      new OrderError("rate_limited", 429, "Too many requests.", { retryAfterSeconds: 90 }),
    );
    const limited = await run(post(checkoutBody));
    expect(limited.status).toBe(200);
    expect((await limited.json()).error).toMatchObject({ code: "rate_limited", status: 429 });

    openCheckout.mockRejectedValueOnce(new Error("12 Analytical Way"));
    const crashed = await (await run(post(checkoutBody))).json();
    expect(crashed.error.status).toBe(500);
    expect(JSON.stringify(crashed)).not.toContain("Analytical");
  });
});

describe("POST /proxy/order with a confirmed order change", () => {
  it("hands the grant to the order-change handler, with the shop from the signed request", async () => {
    handleOrderAction.mockReset().mockResolvedValue({
      ok: true,
      step: "cancel",
      order: { name: "#1005" },
      message: "Order #1005 is cancelled.",
    });

    for (const step of ["cancel", "cancel_request", "address", "edit"]) {
      const response = await run(post({ step, token: "signed-grant", shop: "victim-shop.myshopify.com" }));
      expect(await response.json()).toMatchObject({ ok: true, message: "Order #1005 is cancelled." });
    }

    expect(handleOrderAction).toHaveBeenCalledTimes(4);
    expect(openCheckout).not.toHaveBeenCalled();
    const input = handleOrderAction.mock.calls[0][0];
    expect(input.shop).toBe(SHOP);
    expect(input.body.token).toBe("signed-grant");
    expect(typeof input.admin).toBe("function");
  });

  it("returns the address form's field errors in a form the widget can show", async () => {
    handleOrderAction.mockReset().mockRejectedValue(
      new OrderError("invalid_order", 422, "Please check the highlighted details.", {
        fields: { phone: "Enter a phone number with 7 to 15 digits." },
      }),
    );
    const invalid = await run(post({ step: "address", token: "signed-grant" }));
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
  });

  it("sends an expired grant's message through as readable JSON", async () => {
    handleOrderAction
      .mockReset()
      .mockRejectedValue(new OrderError("invalid_request", 410, "This has expired. Please ask the assistant again."));
    const response = await run(post({ step: "cancel", token: "old" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "invalid_request", status: 410, message: "This has expired. Please ask the assistant again." },
    });
  });
});

describe("GET /proxy/order", () => {
  it("returns what the address form asks for, for the signed shop", async () => {
    const response = await get("&language=fr");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      countries: [{ code: "CA", name: "Canada", form: 0 }],
      forms: [[[{ name: "lastName", label: "Last name", required: true }]]],
    });
    expect(listDeliveryCountries.mock.calls[0][0]).toMatchObject({ shop: SHOP, language: "fr" });
  });

  it("says when address changes in the chat are switched off", async () => {
    listDeliveryCountries.mockRejectedValue(
      new OrderError("disabled", 403, "Address changes in the chat are not available for this store."),
    );
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "disabled", status: 403 },
    });
  });
});
