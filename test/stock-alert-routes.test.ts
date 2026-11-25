import { beforeEach, describe, expect, it, vi } from "vitest";

// The routes' collaborators are replaced so the tests can see exactly what
// each route passes along.
const appProxy = vi.fn();
const webhook = vi.fn();
const handleStockAlert = vi.fn();
const hasWaitingAlerts = vi.fn();
const notifyBackInStock = vi.fn();

vi.mock("../app/shopify.server", () => ({
  authenticate: {
    public: { appProxy: (request: Request) => appProxy(request) },
    webhook: (request: Request) => webhook(request),
  },
}));
vi.mock("../app/db.server", () => ({ default: { marker: "db" } }));
vi.mock("../app/assistant/stock-alerts.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app/assistant/stock-alerts.server")>();
  return {
    ...original,
    handleStockAlert: (...args: unknown[]) => handleStockAlert(...args),
    hasWaitingAlerts: (...args: unknown[]) => hasWaitingAlerts(...args),
    notifyBackInStock: (...args: unknown[]) => notifyBackInStock(...args),
  };
});

const proxyRoute = await import("../app/routes/proxy.stock-alert");
const webhookRoute = await import("../app/routes/webhooks.products.update");
const { ChatError } = await import("../app/assistant/chat.server");

const SHOP = "real-shop.myshopify.com";
const graphqlClient = { graphql: async () => Response.json({ data: {} }) };

const post = (path: string, body: unknown) =>
  new Request(`https://app.example${path}?shop=${SHOP}&signature=abc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.7, 10.0.0.1" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const args = (request: Request) => ({ request, params: {}, context: {} }) as never;
const ask = (body: unknown) => proxyRoute.action(args(post("/proxy/stock-alert", body))) as Promise<Response>;
const changed = (payload: unknown) =>
  webhookRoute.action(args(post("/webhooks/products/update", payload))) as Promise<Response>;

beforeEach(() => {
  appProxy.mockReset().mockResolvedValue({ session: { shop: SHOP }, storefront: graphqlClient });
  webhook.mockReset();
  handleStockAlert.mockReset().mockResolvedValue({ ok: true, status: "subscribed" });
  hasWaitingAlerts.mockReset().mockResolvedValue(true);
  notifyBackInStock.mockReset().mockResolvedValue(1);
});

describe("POST /proxy/stock-alert", () => {
  it("authenticates first and takes the shop from the signed request, never the body", async () => {
    const body = { productId: "500", email: "ada@example.com", shop: "victim-shop.myshopify.com" };
    const response = await ask(body);

    expect(appProxy).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, status: "subscribed" });

    const input = handleStockAlert.mock.calls[0][0];
    expect(input.shop).toBe(SHOP);
    expect(input.ip).toBe("203.0.113.7");
    expect(input.body).toEqual(body);
    expect(typeof input.storefront).toBe("function");
  });

  it("propagates Shopify's rejection of an unsigned request", async () => {
    appProxy.mockRejectedValue(new Response(undefined, { status: 400 }));

    const thrown = await ask({ productId: "500", email: "ada@example.com" }).catch((error: unknown) => error);

    expect((thrown as Response).status).toBe(400);
    expect(handleStockAlert).not.toHaveBeenCalled();
  });

  it("answers a store without the app, a bad body and a refusal in a way the proxy passes on", async () => {
    appProxy.mockResolvedValueOnce({ session: null, storefront: null });
    expect((await ask({})).status).toBe(404);
    expect((await ask("{not json")).status).toBe(400);
    expect(handleStockAlert).not.toHaveBeenCalled();

    // Shopify replaces the body of an error status, so a refusal goes out as a 200.
    handleStockAlert.mockRejectedValue(new ChatError("invalid_request", 400, "Enter a valid email address."));
    const refused = await ask({ productId: "500", email: "nope" });
    expect(refused.status).toBe(200);
    expect(await refused.json()).toEqual({
      ok: false,
      error: { code: "invalid_request", message: "Enter a valid email address.", status: 400 },
    });

    const loaded = (await proxyRoute.loader()) as Response;
    expect(loaded.status).toBe(405);
  });
});

describe("POST /webhooks/products/update", () => {
  const signed = (extra: Record<string, unknown> = {}) => ({
    shop: SHOP,
    admin: graphqlClient,
    payload: { id: 500, title: "Ski Wax" },
    ...extra,
  });

  it("checks the changed product for the shop Shopify signed for, after answering", async () => {
    webhook.mockResolvedValue(signed());
    const response = await changed({ id: 500 });

    expect(response.status).toBe(200);
    expect(hasWaitingAlerts).toHaveBeenCalledWith({ marker: "db" }, SHOP, "500");
    expect(notifyBackInStock).toHaveBeenCalledTimes(1);
    const input = notifyBackInStock.mock.calls[0][0];
    expect([input.shop, input.productId, typeof input.admin]).toEqual([SHOP, "500", "function"]);
  });

  it("does nothing when nobody is waiting, the app is gone or the product id is not one", async () => {
    webhook.mockResolvedValue(signed());
    hasWaitingAlerts.mockResolvedValue(false);
    expect((await changed({})).status).toBe(200);

    hasWaitingAlerts.mockResolvedValue(true);
    webhook.mockResolvedValue(signed({ admin: undefined }));
    expect((await changed({})).status).toBe(200);
    webhook.mockResolvedValue(signed({ payload: { id: "500 OR 1=1" } }));
    expect((await changed({})).status).toBe(200);
    webhook.mockResolvedValue(signed({ payload: null }));
    expect((await changed({})).status).toBe(200);

    expect(notifyBackInStock).not.toHaveBeenCalled();
  });

  it("still answers Shopify when the emails fail, and logs no payload or address", async () => {
    webhook.mockResolvedValue(signed());
    notifyBackInStock.mockRejectedValue(new Error("ada@example.com could not be reached"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await changed({})).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0][0])).not.toContain("ada@");
    logged.mockRestore();
  });

  it("rejects a request Shopify did not sign", async () => {
    webhook.mockRejectedValue(new Response(undefined, { status: 401 }));
    const thrown = await changed({ id: 500 }).catch((error: unknown) => error);
    expect((thrown as Response).status).toBe(401);
    expect(notifyBackInStock).not.toHaveBeenCalled();
  });
});
