// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// The widget is a classic script: importing it once registers
// `window.ShopiAssist.mount`, which each test then calls on a fresh mount point.
// @ts-expect-error -- a classic browser script with no exports, not a module
await import("../extensions/chat-widget/assets/shopi-assist.js");

const WIDGET_SOURCE = readFileSync(
  join(process.cwd(), "extensions/chat-widget/assets/shopi-assist.js"),
  "utf8",
);

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
type FetchMock = ReturnType<typeof vi.fn<FetchHandler>>;

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );

const reply = (text: string, extra: Record<string, unknown> = {}) =>
  jsonResponse({ conversationId: "conv12345678", reply: text, cards: [], actions: [], ...extra });

const card = (overrides: Record<string, unknown> = {}) => ({
  id: "gid://shopify/Product/1",
  title: "Trail Mug",
  handle: "trail-mug",
  url: "https://shop.example/products/trail-mug",
  imageUrl: "https://cdn.example/mug.jpg",
  imageAlt: "A mug",
  price: { amount: "18.0", currencyCode: "USD" },
  compareAtPrice: null,
  available: true,
  variantId: "101",
  ...overrides,
});

/** Builds the mount point the Liquid block renders, then mounts the widget on it. */
function mountWidget(dataset: Record<string, string> = {}) {
  document.body.replaceChildren();
  const host = document.createElement("div");
  host.id = "shopi-assist-root";
  Object.assign(host.dataset, {
    endpoint: "/apps/shopi-assist/chat",
    title: "Shop helper",
    greeting: "Welcome! Ask me anything.",
    accent: "#1F3D2F",
    position: "right",
    suggestion1: "What are your best sellers?",
    suggestion2: "",
    country: "US",
    locale: "en",
    cartUrl: "/cart",
    cartAddUrl: "/cart/add",
    ...dataset,
  });
  document.body.appendChild(host);
  (
    window as unknown as { ShopiAssist: { mount: (host: Element) => unknown } }
  ).ShopiAssist.mount(host);

  const root = host.shadowRoot!;
  const $ = <T extends Element = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const all = (selector: string) => Array.from(root.querySelectorAll<HTMLElement>(selector));
  return {
    host,
    root,
    $,
    all,
    launcher: $<HTMLButtonElement>(".sa-launcher"),
    panel: $<HTMLElement>(".sa-panel"),
    input: $<HTMLTextAreaElement>(".sa-input"),
    form: $<HTMLFormElement>(".sa-form"),
    bubbles: () => all(".sa-bubble").map((bubble) => bubble.textContent),
    send(text: string) {
      this.input.value = text;
      this.form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const lastBody = (fetchMock: FetchMock, index = -1) => {
  const call = fetchMock.mock.calls.at(index)!;
  return JSON.parse((call[1] as RequestInit).body as string);
};

/** POST requests: chat messages and cart adds. */
let fetchMock: FetchMock;
/** GET requests for the widget's settings. */
let configMock: FetchMock;
/** GET /cart.js: the storefront cart. Unreadable unless a test sets one up. */
let cartMock: FetchMock;
/** The app's order endpoint: GET for countries, POST to quote or place. */
let orderMock: FetchMock;

/** A storefront cart as /cart.js returns it; prices are in cents. */
const cartLine = (variantId: number, quantity: number, title: string, price: number) => ({
  variant_id: variantId,
  quantity,
  title,
  final_line_price: price * quantity,
});
const cartJson = (...items: Array<ReturnType<typeof cartLine>>) => ({
  currency: "USD",
  items,
  total_price: items.reduce((sum, item) => sum + item.final_line_price, 0),
});

/**
 * A cart that behaves like the storefront's: /cart/add.js adds to it and
 * /cart.js reads it back. `catalog` maps variant id to [title, price in cents].
 */
function liveCart(
  catalog: Record<number, [string, number]>,
  chat: () => Promise<Response>,
  initial: Record<number, number> = {},
) {
  const quantities = new Map<number, number>(
    Object.entries(initial).map(([id, quantity]) => [Number(id), quantity]),
  );
  const adds: Array<Array<{ id: number; quantity: number }>> = [];
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url !== "/cart/add.js") return chat();
    const items = JSON.parse(init!.body as string).items as Array<{ id: number; quantity: number }>;
    adds.push(items);
    for (const item of items) {
      quantities.set(item.id, (quantities.get(item.id) ?? 0) + item.quantity);
    }
    return jsonResponse({ items: [] });
  });
  cartMock.mockImplementation(() =>
    jsonResponse(
      cartJson(
        ...[...quantities].map(([id, quantity]) =>
          cartLine(id, quantity, catalog[id][0], catalog[id][1]),
        ),
      ),
    ),
  );
  return { adds };
}

const appConfig = (overrides: Record<string, unknown> = {}) =>
  jsonResponse({ ok: true, enabled: true, ready: true, title: "", greeting: "", ...overrides });

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  fetchMock = vi.fn<FetchHandler>(() => reply("Hello!"));
  configMock = vi.fn<FetchHandler>(() => appConfig());
  cartMock = vi.fn<FetchHandler>(() => jsonResponse({ error: "not found" }, 404));
  orderMock = vi.fn<FetchHandler>(() => jsonResponse({ ok: true, countries: [] }));
  window.fetch = ((url: string, init?: RequestInit) => {
    if (url.startsWith("/apps/shopi-assist/order")) return orderMock(url, init);
    if ((init?.method ?? "GET") !== "GET") return fetchMock(url, init);
    return url.endsWith("/cart.js") ? cartMock(url, init) : configMock(url, init);
  }) as unknown as typeof window.fetch;
});

describe("chat widget", () => {
  it("starts closed and opens from the launcher with the merchant's greeting", () => {
    const widget = mountWidget();

    expect(widget.panel.hidden).toBe(true);
    expect(widget.launcher.getAttribute("aria-expanded")).toBe("false");

    widget.launcher.click();

    expect(widget.panel.hidden).toBe(false);
    expect(widget.launcher.getAttribute("aria-expanded")).toBe("true");
    expect(widget.panel.getAttribute("role")).toBe("dialog");
    expect(widget.$(".sa-title").textContent).toBe("Shop helper");
    expect(widget.bubbles()).toEqual(["Welcome! Ask me anything."]);
    expect(widget.all(".sa-chip").map((chip) => chip.textContent)).toEqual([
      "What are your best sellers?",
    ]);
  });

  it("applies the accent color and a readable text color", () => {
    const dark = mountWidget({ accent: "#1F3D2F" });
    expect(dark.$(".sa").style.getPropertyValue("--sa-on-accent")).toBe("#ffffff");

    const light = mountWidget({ accent: "#FFE680" });
    expect(light.$(".sa").style.getPropertyValue("--sa-accent")).toBe("#FFE680");
    expect(light.$(".sa").style.getPropertyValue("--sa-on-accent")).toBe("#111111");

    const invalid = mountWidget({ accent: "red; background:url(x)" });
    expect(invalid.$(".sa").style.getPropertyValue("--sa-accent")).toBe("#1F3D2F");
  });

  it("stays hidden until its stylesheet has loaded", () => {
    const widget = mountWidget({ stylesheet: "https://cdn.example/shopi-assist.css" });
    const wrapper = widget.$(".sa");
    expect(wrapper.hidden).toBe(true);

    widget.root.querySelector("link")!.dispatchEvent(new Event("load"));
    expect(wrapper.hidden).toBe(false);
  });

  it("posts the message to the app proxy and shows the reply", async () => {
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("Do you have mugs?");
    await flush();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/apps/shopi-assist/chat");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(lastBody(fetchMock)).toMatchObject({
      message: "Do you have mugs?",
      conversationId: null,
      country: "US",
      language: "en",
    });
    expect(lastBody(fetchMock).visitorId).toMatch(/^[a-f0-9]{32}$/);

    expect(widget.bubbles()).toEqual(["Welcome! Ask me anything.", "Do you have mugs?", "Hello!"]);
    expect(widget.input.value).toBe("");
    expect(widget.all(".sa-chip")).toHaveLength(0);
  });

  it("sends on Enter but not on Shift+Enter", async () => {
    const widget = mountWidget();
    widget.launcher.click();
    widget.input.value = "line one";

    widget.input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    widget.input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders assistant text safely: no injected markup, no unsafe links", async () => {
    fetchMock.mockImplementation(() =>
      reply(
        '<img src=x onerror="window.hacked=1"> **Bold pick** [bad](javascript:alert(1)) [Trail Mug](/products/trail-mug)\n- one\n- two',
      ),
    );
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("hi");
    await flush();

    const bubble = widget.all(".sa-row-assistant .sa-bubble").at(-1)!;
    expect(bubble.querySelector("img")).toBeNull();
    expect(bubble.querySelector("script")).toBeNull();
    expect(bubble.textContent).toContain('<img src=x onerror="window.hacked=1">');
    expect(bubble.querySelector("strong")!.textContent).toBe("Bold pick");
    expect(bubble.querySelectorAll("li")).toHaveLength(2);

    const links = Array.from(bubble.querySelectorAll("a"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/products/trail-mug"]);
    expect((window as unknown as { hacked?: number }).hacked).toBeUndefined();
  });

  it("shows the shopper's own message as plain text", async () => {
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("<b>hi</b> **not bold**");
    await flush();

    const userBubble = widget.$(".sa-row-user .sa-bubble");
    expect(userBubble.children).toHaveLength(0);
    expect(userBubble.textContent).toBe("<b>hi</b> **not bold**");
  });

  it("renders product cards and adds a single-variant product to the cart", async () => {
    fetchMock.mockImplementation((url: string) =>
      url === "/cart/add.js"
        ? jsonResponse({ items: [] })
        : reply("Try the Trail Mug.", {
            cards: [
              card({ compareAtPrice: { amount: "24.0", currencyCode: "USD" } }),
              card({ title: "Camp Kettle", handle: "camp-kettle", variantId: null, url: "https://shop.example/products/camp-kettle" }),
              card({ title: "Sold Out Lamp", handle: "lamp", available: false }),
              card({ title: "Bad Link", handle: "bad", url: "javascript:alert(1)", imageUrl: "javascript:alert(1)" }),
            ],
          }),
    );
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("mugs?");
    await flush();

    const cards = widget.all(".sa-card");
    expect(cards).toHaveLength(4);
    expect(cards[0].querySelector(".sa-card-title")!.getAttribute("href")).toBe(
      "https://shop.example/products/trail-mug",
    );
    expect(cards[0].querySelector(".sa-card-price")!.textContent).toContain("$18.00");
    expect(cards[0].querySelector("s")!.textContent).toBe("$24.00");
    expect(cards[0].querySelector("img")!.getAttribute("alt")).toBe("A mug");

    // Several variants: the shopper has to choose on the product page.
    expect(cards[1].querySelector("button")).toBeNull();
    expect(cards[1].textContent).toContain("Choose options");
    // Sold out: no way to add.
    expect(cards[2].querySelector("button")).toBeNull();
    expect(cards[2].textContent).toContain("Sold out");
    // Unsafe URLs are never turned into links or images.
    expect(cards[3].querySelector("a")).toBeNull();
    expect(cards[3].querySelector("img")).toBeNull();

    const addButton = cards[0].querySelector("button")!;
    expect(addButton.textContent).toBe("Add to cart");
    addButton.click();
    await flush();

    const cartCall = fetchMock.mock.calls.find((call) => call[0] === "/cart/add.js")!;
    expect(JSON.parse((cartCall[1] as RequestInit).body as string)).toEqual({
      items: [{ id: 101, quantity: 1 }],
    });
    expect(addButton.textContent).toBe("Added");
  });

  it("runs an add_to_cart action from the assistant and confirms it", async () => {
    fetchMock.mockImplementation((url: string) =>
      url === "/cart/add.js"
        ? jsonResponse({ items: [] })
        : reply("Added it for you.", {
            actions: [
              { type: "add_to_cart", variantId: "101", quantity: 2 },
              { type: "add_to_cart", variantId: "1 OR 1=1", quantity: 1 },
              { type: "navigate", url: "https://evil.example" },
            ],
          }),
    );
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("add the mug");
    await flush();

    const cartCalls = fetchMock.mock.calls.filter((call) => call[0] === "/cart/add.js");
    expect(cartCalls).toHaveLength(1);
    expect(JSON.parse((cartCalls[0][1] as RequestInit).body as string)).toEqual({
      items: [{ id: 101, quantity: 2 }],
    });

    const notice = widget.$(".sa-notice");
    expect(notice.textContent).toContain("Added to your cart.");
    expect(notice.querySelector("a")!.getAttribute("href")).toBe("/cart");
  });

  it("puts an order in the cart and shows a summary with a checkout button", async () => {
    const cart = liveCart({ 101: ["Trail Mug", 1800], 103: ["Camp Blanket - Large", 8950] }, () =>
      reply("Here's your order.", {
        actions: [
          {
            type: "order",
            items: [
              { variantId: "101", quantity: 2, title: "Trail Mug" },
              { variantId: "103", quantity: 1, title: "Camp Blanket (Large)" },
              { variantId: "1 OR 1=1", quantity: 1, title: "Bad" },
            ],
          },
        ],
      }),
    );
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("I want two mugs and a blanket");
    await flush();

    // One request adds every item; the malformed line is dropped.
    expect(cart.adds).toEqual([
      [
        { id: 101, quantity: 2 },
        { id: 103, quantity: 1 },
      ],
    ]);

    const order = widget.$(".sa-order");
    expect(order.getAttribute("aria-label")).toBe("Order summary");
    expect(widget.all(".sa-order-line").map((line) => line.textContent)).toEqual([
      "2 \u00d7Trail Mug$36.00",
      "1 \u00d7Camp Blanket - Large$89.50",
    ]);
    expect(widget.$(".sa-order-total").textContent).toBe("Subtotal$125.50");
    expect(order.textContent).toContain("Shipping and taxes are added at checkout.");

    const links = Array.from(order.querySelectorAll("a"));
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Go to checkout", "/checkout"],
      ["Edit cart", "/cart"],
    ]);
  });

  it("tops an order up instead of doubling what is already in the cart", async () => {
    const cart = liveCart(
      { 101: ["Trail Mug", 1800], 103: ["Camp Blanket", 8950] },
      () =>
        reply("Here's your order.", {
          actions: [
            {
              type: "order",
              items: [
                { variantId: "101", quantity: 3 },
                { variantId: "103", quantity: 1 },
              ],
            },
          ],
        }),
      // The shopper already has one mug and the blanket.
      { 101: 1, 103: 1 },
    );
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("order three mugs and the blanket");
    await flush();

    expect(cart.adds).toEqual([[{ id: 101, quantity: 2 }]]);
    expect(widget.all(".sa-order-line").map((line) => line.textContent)).toEqual([
      "3 \u00d7Trail Mug$54.00",
      "1 \u00d7Camp Blanket$89.50",
    ]);

    // Asking again changes nothing in the cart and leaves a single summary.
    widget.send("order three mugs and the blanket");
    await flush();
    expect(cart.adds).toHaveLength(1);
    expect(widget.all(".sa-order")).toHaveLength(1);
  });

  it("adds the item first when one reply both adds to the cart and orders", async () => {
    const cart = liveCart({ 101: ["Trail Mug", 1800] }, () =>
      reply("Done.", {
        actions: [
          { type: "add_to_cart", variantId: "101", quantity: 1 },
          { type: "order", items: [{ variantId: "101", quantity: 1 }] },
        ],
      }),
    );
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("add the mug and order it");
    await flush();

    expect(cart.adds).toEqual([[{ id: 101, quantity: 1 }]]);
    expect(widget.all(".sa-order-line").map((line) => line.textContent)).toEqual([
      "1 \u00d7Trail Mug$18.00",
    ]);
  });

  it("shows no summary when the cart rejects part of an order", async () => {
    fetchMock.mockImplementation((url: string) =>
      url === "/cart/add.js"
        ? jsonResponse({ status: 422, description: "The product 'Trail Mug' is already sold out." }, 422)
        : reply("Here's your order.", {
            actions: [{ type: "order", items: [{ variantId: "101", quantity: 1 }] }],
          }),
    );
    cartMock.mockImplementation(() => jsonResponse(cartJson()));
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("order the mug");
    await flush();

    expect(widget.$(".sa-notice-error").textContent).toBe(
      "The product 'Trail Mug' is already sold out.",
    );
    expect(widget.root.querySelector(".sa-order")).toBeNull();
    // The assistant's reply is still shown as a reply, not as a failed message.
    expect(widget.root.querySelector(".sa-retry")).toBeNull();
  });

  it("shows the cart as an order summary when the assistant offers checkout", async () => {
    fetchMock.mockImplementation(() =>
      reply("Great, you're all set.", { actions: [{ type: "checkout" }] }),
    );
    cartMock.mockImplementation(() =>
      jsonResponse(cartJson(cartLine(101, 2, '<img src=x onerror="window.hacked=1">', 1800))),
    );
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("I want to buy it");
    await flush();

    const order = widget.$(".sa-order");
    // Cart text is shown as text, never as markup.
    expect(order.querySelector("img")).toBeNull();
    expect(widget.$(".sa-order-item").textContent).toBe('<img src=x onerror="window.hacked=1">');
    expect(widget.$(".sa-order-total").textContent).toBe("Subtotal$36.00");
    expect(widget.$(".sa-order-checkout").getAttribute("href")).toBe("/checkout");
    // Only the chat message was posted: checking out adds nothing and places no order.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The summary is still there on the next page.
    const nextPage = mountWidget();
    expect(nextPage.$(".sa-order-total").textContent).toBe("Subtotal$36.00");
  });

  it("lets the shopper remove a line from the summary", async () => {
    const lines = [
      { ...cartLine(101, 1, "Trail Mug", 1800), key: "101:abc" },
      { ...cartLine(103, 1, "Camp Blanket", 8950), key: "103:def" },
    ];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url !== "/cart/change.js") return reply("Here.", { actions: [{ type: "checkout" }] });
      const change = JSON.parse(init!.body as string);
      const index = lines.findIndex((line) => line.key === change.id);
      if (index >= 0 && change.quantity === 0) lines.splice(index, 1);
      return jsonResponse(cartJson(...lines));
    });
    cartMock.mockImplementation(() => jsonResponse(cartJson(...lines)));
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("checkout");
    await flush();

    const remove = widget.all(".sa-order-remove");
    expect(remove.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Remove Trail Mug",
      "Remove Camp Blanket",
    ]);
    remove[1].click();
    await flush();

    const change = fetchMock.mock.calls.find((call) => call[0] === "/cart/change.js")!;
    expect(JSON.parse((change[1] as RequestInit).body as string)).toEqual({ id: "103:def", quantity: 0 });
    expect(widget.all(".sa-order")).toHaveLength(1);
    expect(widget.all(".sa-order-item").map((item) => item.textContent)).toEqual(["Trail Mug"]);
    expect(widget.$(".sa-order-total").textContent).toBe("Subtotal$18.00");

    // Removing the last line leaves no summary, only a note.
    widget.$<HTMLButtonElement>(".sa-order-remove").click();
    await flush();
    expect(widget.root.querySelector(".sa-order")).toBeNull();
    expect(widget.all(".sa-notice").at(-1)!.textContent).toBe(
      "Your cart is empty. Tell me what you'd like to order.",
    );
  });

  it("shows the app's message when an order step is refused, even as a 200", async () => {
    configMock.mockImplementation(() => appConfig({ chatOrders: true }));
    liveCart({ 101: ["Trail Mug", 1800] }, () => reply("Here.", { actions: [{ type: "checkout" }] }), {
      101: 1,
    });
    // How errors arrive through Shopify's proxy: HTTP 200, ok false.
    orderMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? jsonResponse({
            ok: false,
            error: { code: "order_failed", status: 502, message: "We couldn't place this order right now." },
          })
        : jsonResponse({ ok: true, countries: [{ code: "US", name: "United States" }] }),
    );
    const widget = mountWidget();
    await flush();
    widget.launcher.click();
    widget.send("checkout");
    await flush();
    widget.$<HTMLButtonElement>(".sa-order-here").click();
    await flush();
    widget
      .$<HTMLFormElement>(".sa-order-form")
      .dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await flush();

    expect(widget.$(".sa-order-status-error").textContent).toBe(
      "We couldn't place this order right now.",
    );
    // One country to deliver to: the choice is hidden.
    expect(widget.$('.sa-order-form [name="countryCode"]').parentElement!.hidden).toBe(true);
  });

  it("says so when there is nothing in the cart to check out", async () => {
    fetchMock.mockImplementation(() => reply("Sure.", { actions: [{ type: "checkout" }] }));
    cartMock.mockImplementation(() => jsonResponse(cartJson()));
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("checkout");
    await flush();

    expect(widget.$(".sa-notice").textContent).toBe(
      "Your cart is empty. Tell me what you'd like to order.",
    );
    expect(widget.root.querySelector(".sa-order")).toBeNull();
    expect(widget.root.querySelector(".sa-notice a")).toBeNull();
  });

  it("falls back to a plain checkout link when the cart cannot be read", async () => {
    fetchMock.mockImplementation(() =>
      reply("Great, you're all set.", { actions: [{ type: "checkout" }] }),
    );
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("I want to buy it");
    await flush();

    const link = widget.$(".sa-notice a");
    expect(link.textContent).toBe("Go to checkout");
    expect(link.getAttribute("href")).toBe("/checkout");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads the cart from the store's locale-aware cart path", async () => {
    fetchMock.mockImplementation(() => reply("Sure.", { actions: [{ type: "checkout" }] }));
    cartMock.mockImplementation(() => jsonResponse(cartJson(cartLine(101, 1, "Tasse", 1800))));
    const widget = mountWidget({ cartUrl: "/fr/cart", cartAddUrl: "/fr/cart/add" });
    widget.launcher.click();
    widget.send("commander");
    await flush();

    expect(cartMock.mock.calls[0][0]).toBe("/fr/cart.js");
    expect(widget.$(".sa-order a:last-child").getAttribute("href")).toBe("/fr/cart");
  });

  describe("pay-on-delivery order form", () => {
    const usd = (amount: string) => ({ amount, currencyCode: "USD" });
    const RATES = [
      { handle: "standard", title: "Standard", price: usd("5.0") },
      { handle: "express", title: "Express", price: usd("15.0") },
    ];
    const quote = (handle = "standard") => ({
      lines: [{ title: "Trail Mug", quantity: 2, total: usd("36.0") }],
      subtotal: usd("36.0"),
      shipping: handle === "express" ? usd("15.0") : usd("5.0"),
      tax: usd("3.6"),
      total: handle === "express" ? usd("54.6") : usd("44.6"),
      shippingRates: RATES,
      shippingRateHandle: handle,
    });
    const orderPosts = () =>
      orderMock.mock.calls
        .filter((call) => (call[1] as RequestInit | undefined)?.method === "POST")
        .map((call) => JSON.parse((call[1] as RequestInit).body as string));

    /** A store that takes chat orders, with two mugs in the cart and the summary on screen. */
    async function openForm(
      respond: (body: Record<string, unknown>) => Promise<Response>,
      config: Record<string, unknown> = {},
    ) {
      configMock.mockImplementation(() => appConfig({ chatOrders: true, ...config }));
      const cart = liveCart(
        { 101: ["Trail Mug", 1800] },
        () => reply("Here's your cart.", { actions: [{ type: "checkout" }] }),
        { 101: 2 },
      );
      orderMock.mockImplementation((_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? respond(JSON.parse(init.body as string))
          : jsonResponse({
              ok: true,
              countries: [
                { code: "CA", name: "Canada" },
                { code: "US", name: "United States" },
              ],
            }),
      );
      const widget = mountWidget();
      await flush();
      widget.launcher.click();
      widget.send("checkout");
      await flush();
      widget.$<HTMLButtonElement>(".sa-order-here").click();
      await flush();

      const field = (name: string) =>
        widget.$<HTMLInputElement | HTMLSelectElement>(`.sa-order-form [name="${name}"]`);
      const fill = (values: Record<string, string>) => {
        for (const [name, value] of Object.entries(values)) field(name).value = value;
      };
      const submit = async () => {
        widget
          .$<HTMLFormElement>(".sa-order-form")
          .dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
        await flush();
      };
      return { widget, cart, field, fill, submit };
    }

    const DETAILS = {
      name: " Ada Lovelace ",
      phone: "+1 613 555 0111",
      email: "ada@example.com",
      address1: "12 Analytical Way",
      city: "Ottawa",
      province: "ON",
      zip: "K1A 0B1",
      countryCode: "CA",
    };

    it("is offered only when the merchant takes orders in the chat", async () => {
      liveCart({ 101: ["Trail Mug", 1800] }, () => reply("Here.", { actions: [{ type: "checkout" }] }), {
        101: 1,
      });
      const widget = mountWidget();
      await flush();
      widget.launcher.click();
      widget.send("checkout");
      await flush();

      expect(widget.root.querySelector(".sa-order")).not.toBeNull();
      expect(widget.root.querySelector(".sa-order-here")).toBeNull();
    });

    it("takes the details, shows the total and places the order", async () => {
      const { widget, field, fill, submit } = await openForm((body) =>
        body.step === "quote"
          ? jsonResponse({ ok: true, step: "quote", quote: quote(body.shippingRateHandle as string) })
          : jsonResponse({ ok: true, step: "place", order: { name: "#1001", total: usd("54.6") } }),
      );

      // The form asks for what a delivery needs, with the browsing country chosen.
      expect(widget.all(".sa-order-form label").map((label) => label.textContent)).toEqual([
        "Full name",
        "Phone",
        "Email (optional)",
        "Address",
        "Apartment, suite (optional)",
        "City",
        "State / province",
        "Postal code",
        "Country",
      ]);
      expect(field("countryCode").value).toBe("US");
      expect(field("phone").getAttribute("autocomplete")).toBe("tel");

      fill(DETAILS);
      await submit();

      expect(orderPosts()[0]).toEqual({
        step: "quote",
        items: [{ variantId: "101", quantity: 2 }],
        contact: { name: "Ada Lovelace", phone: "+1 613 555 0111", email: "ada@example.com" },
        address: {
          address1: "12 Analytical Way",
          address2: "",
          city: "Ottawa",
          province: "ON",
          zip: "K1A 0B1",
          countryCode: "CA",
        },
      });

      // Review: lines, delivery options and what will be paid on delivery.
      expect(widget.$(".sa-order-form .sa-order-title").textContent).toBe("Review your order");
      expect(widget.$(".sa-order-totals").textContent).toBe(
        "Subtotal$36.00Delivery$5.00Tax$3.60Total$44.60",
      );
      expect(widget.$(".sa-order-form").textContent).toContain(
        "You pay $44.60 when your order arrives.",
      );
      expect(widget.$(".sa-order-form").textContent).toContain(
        "Deliver to Ada Lovelace, 12 Analytical Way, Ottawa, ON, K1A 0B1. Phone +1 613 555 0111.",
      );

      // Picking faster delivery asks for a new total.
      const express = widget.all(".sa-order-rate input")[1] as HTMLInputElement;
      express.checked = true;
      express.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
      expect(orderPosts()[1]).toMatchObject({ step: "quote", shippingRateHandle: "express" });
      expect(widget.$(".sa-order-totals").textContent).toContain("Total$54.60");

      await submit();

      const placed = orderPosts()[2];
      expect(placed).toMatchObject({
        step: "place",
        items: [{ variantId: "101", quantity: 2 }],
        shippingRateHandle: "express",
        expectedTotal: usd("54.6"),
      });
      expect(placed.idempotencyKey).toMatch(/^[a-f0-9]{32}$/);

      // Confirmed with the order number; the form and the old summary are gone.
      expect(widget.all(".sa-notice").at(-1)!.textContent).toBe(
        "Order #1001 is placed. You pay $54.60 on delivery.",
      );
      expect(widget.root.querySelector(".sa-order")).toBeNull();
      expect(fetchMock.mock.calls.some((call) => call[0] === "/cart/clear.js")).toBe(true);

      // Nothing the shopper typed is kept in the browser's storage.
      const stored = JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage });
      expect(stored).not.toMatch(/Lovelace|Analytical|613/);
      expect(stored).toContain("Order #1001 is placed");
    });

    it("shows the store's field errors next to the fields and keeps what was typed", async () => {
      const { widget, field, fill, submit } = await openForm(() =>
        jsonResponse(
          {
            error: {
              code: "invalid_order",
              message: "Please check the highlighted details.",
              fields: { phone: "Enter a phone number with 7 to 15 digits." },
            },
          },
          422,
        ),
      );
      fill({ ...DETAILS, phone: "12" });
      await submit();

      expect(widget.$(".sa-order-form .sa-order-title").textContent).toBe("Delivery details");
      expect(field("phone").getAttribute("aria-invalid")).toBe("true");
      expect(widget.$(".sa-field-error").textContent).toBe("Enter a phone number with 7 to 15 digits.");
      expect(field("phone").getAttribute("aria-describedby")).toBe(widget.$(".sa-field-error").id);
      expect(widget.$(".sa-order-status-error").textContent).toBe(
        "Please check the highlighted details.",
      );
      expect(field("name").value).toBe("Ada Lovelace");
      expect(field("countryCode").value).toBe("CA");
      expect(widget.root.activeElement).toBe(field("phone"));
    });

    it("asks the shopper to confirm again when the total has changed", async () => {
      let places = 0;
      const { widget, fill, submit } = await openForm((body) => {
        if (body.step === "quote") return jsonResponse({ ok: true, step: "quote", quote: quote() });
        places += 1;
        return places === 1
          ? jsonResponse(
              {
                error: { code: "quote_changed", message: "The total has changed. Please check the new total and confirm again." },
                quote: quote("express"),
              },
              409,
            )
          : jsonResponse({ ok: true, step: "place", order: { name: "#1002", total: usd("54.6") } });
      });
      fill(DETAILS);
      await submit();
      await submit();

      // Nothing was confirmed: the new total is on screen with the reason.
      expect(widget.$(".sa-order-totals").textContent).toContain("Total$54.60");
      expect(widget.$(".sa-order-status-error").textContent).toMatch(/total has changed/);
      expect(widget.all(".sa-notice")).toHaveLength(0);

      await submit();
      const [first, second] = orderPosts().filter((body) => body.step === "place");
      expect(first.expectedTotal).toEqual(usd("44.6"));
      expect(second.expectedTotal).toEqual(usd("54.6"));
      // A different total is a different order as far as retries go.
      expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
      expect(widget.all(".sa-notice").at(-1)!.textContent).toContain("Order #1002 is placed");
    });

    it("keeps the order on screen when the store cannot be reached", async () => {
      const { widget, fill, submit } = await openForm((body) =>
        body.step === "quote"
          ? jsonResponse({ ok: true, step: "quote", quote: quote() })
          : Promise.reject(new TypeError("Failed to fetch")),
      );
      fill(DETAILS);
      await submit();
      await submit();

      expect(widget.$(".sa-order-status-error").textContent).toMatch(/couldn't reach the store/);
      expect(widget.$<HTMLButtonElement>(".sa-order-form button[type=submit]").disabled).toBe(false);
      expect(fetchMock.mock.calls.some((call) => call[0] === "/cart/clear.js")).toBe(false);
    });

    it("sends subscriptions and customised items to the checkout instead", async () => {
      const { widget, fill, submit } = await openForm(() => jsonResponse({ ok: true }));
      cartMock.mockImplementation(() =>
        jsonResponse(
          cartJson({ ...cartLine(101, 1, "Trail Mug", 1800), properties: { Engraving: "Ada" } } as never),
        ),
      );
      fill(DETAILS);
      await submit();

      expect(widget.$(".sa-order-status-error").textContent).toBe(
        "This order can't be placed here. Please use the checkout instead.",
      );
      expect(orderPosts()).toHaveLength(0);
    });

    it("offers to fill in test details on a development store only", async () => {
      const real = await openForm(() => jsonResponse({ ok: true }));
      expect(real.widget.root.querySelector(".sa-order-test")).toBeNull();

      window.sessionStorage.clear();
      window.localStorage.clear();
      const { widget, field } = await openForm(() => jsonResponse({ ok: true }), { testMode: true });
      const fill = widget.$<HTMLButtonElement>(".sa-order-test");
      expect(fill.textContent).toBe("Fill test details");

      fill.click();
      expect(field("name").value).toBe("Test Buyer");
      expect(field("email").value).toBe("test.buyer@example.com");
      expect(field("address1").value).toBe("742 Evergreen Terrace");
      expect(field("province").value).toBe("IL");
      expect(field("zip").value).toBe("62704");

      // The details follow the country chosen.
      field("countryCode").value = "CA";
      fill.click();
      expect(field("city").value).toBe("Ottawa");
      expect(field("zip").value).toBe("K2P 2L8");
    });

    it("closes from Cancel and opens only one form at a time", async () => {
      const { widget } = await openForm(() => jsonResponse({ ok: true }));

      widget.$<HTMLButtonElement>(".sa-order-here").click();
      await flush();
      expect(widget.all(".sa-order-form")).toHaveLength(1);

      const cancel = widget.all(".sa-order-form button").find((button) => button.textContent === "Cancel")!;
      cancel.click();
      expect(widget.root.querySelector(".sa-order-form")).toBeNull();
      // The summary with its checkout button is still there.
      expect(widget.$(".sa-order-checkout").getAttribute("href")).toBe("/checkout");
    });
  });

  it("tells the shopper when the cart rejects an item", async () => {
    fetchMock.mockImplementation((url: string) =>
      url === "/cart/add.js"
        ? jsonResponse({ status: 422, description: "All 3 Trail Mug are in your cart." }, 422)
        : reply("Adding.", { actions: [{ type: "add_to_cart", variantId: "101", quantity: 1 }] }),
    );
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("add it");
    await flush();

    expect(widget.$(".sa-notice-error").textContent).toBe("All 3 Trail Mug are in your cart.");
  });

  it("shows the server's error message and retries without repeating the question", async () => {
    fetchMock
      .mockImplementationOnce(() =>
        jsonResponse({ error: { code: "rate_limited", message: "Please wait a moment." } }, 429),
      )
      .mockImplementationOnce(() => reply("Here you go."));
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("best sellers?");
    await flush();

    const notice = widget.$(".sa-notice-error");
    expect(notice.textContent).toContain("Please wait a moment.");

    widget.$<HTMLButtonElement>(".sa-retry").click();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastBody(fetchMock).message).toBe("best sellers?");
    expect(widget.root.querySelector(".sa-notice-error")).toBeNull();
    expect(widget.bubbles()).toEqual([
      "Welcome! Ask me anything.",
      "best sellers?",
      "Here you go.",
    ]);
  });

  it("recovers from a network failure", async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")));
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("hello");
    await flush();

    expect(widget.$(".sa-notice-error").textContent).toContain("Couldn't reach the assistant");
    expect(widget.$<HTMLButtonElement>(".sa-send").disabled).toBe(false);
    expect(widget.root.querySelector(".sa-typing")).toBeNull();
  });

  it("ignores a second send while a reply is pending", async () => {
    let release: (value: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("first");
    widget.send("second");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(widget.root.querySelector(".sa-typing")).not.toBeNull();
    expect(widget.$<HTMLButtonElement>(".sa-send").disabled).toBe(true);

    release(await reply("Done."));
    await flush();
    expect(widget.root.querySelector(".sa-typing")).toBeNull();
  });

  it("restores the conversation on the next page and continues it", async () => {
    const first = mountWidget();
    first.launcher.click();
    first.send("Do you have mugs?");
    await flush();
    const visitorId = lastBody(fetchMock).visitorId;

    // Simulate navigating to another storefront page.
    const second = mountWidget();
    expect(second.bubbles()).toEqual(["Welcome! Ask me anything.", "Do you have mugs?", "Hello!"]);
    expect(second.all(".sa-chip")).toHaveLength(0);

    second.launcher.click();
    second.send("and kettles?");
    await flush();

    expect(lastBody(fetchMock)).toMatchObject({
      conversationId: "conv12345678",
      visitorId,
      message: "and kettles?",
    });
  });

  it("starts a new chat from the reset button", async () => {
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("hello");
    await flush();

    widget.$<HTMLButtonElement>('[aria-label="Start a new chat"]').click();

    expect(widget.bubbles()).toEqual(["Welcome! Ask me anything."]);
    expect(widget.all(".sa-chip")).toHaveLength(1);
    widget.send("again");
    await flush();
    expect(lastBody(fetchMock).conversationId).toBeNull();
  });

  it("closes with Escape and returns focus to the launcher", () => {
    const widget = mountWidget();
    widget.launcher.click();

    widget.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(widget.panel.hidden).toBe(true);
    expect(widget.launcher.getAttribute("aria-expanded")).toBe("false");
    expect(widget.root.activeElement).toBe(widget.launcher);
  });

  it("uses the name and welcome message set in the app", async () => {
    configMock.mockImplementation(() =>
      appConfig({ title: "Ava", greeting: "Hi, I'm Ava! <b>Ask</b> me anything." }),
    );
    const widget = mountWidget();

    // Theme editor values show first, so nothing waits on the network.
    expect(widget.$(".sa-title").textContent).toBe("Shop helper");
    await flush();

    expect(configMock.mock.calls[0][0]).toBe("/apps/shopi-assist/chat");
    expect(widget.$(".sa-title").textContent).toBe("Ava");
    expect(widget.panel.getAttribute("aria-label")).toBe("Ava");
    expect(widget.launcher.getAttribute("aria-label")).toBe("Open chat: Ava");
    // Rendered as text, never as markup.
    expect(widget.bubbles()).toEqual(["Hi, I'm Ava! <b>Ask</b> me anything."]);
    expect(widget.root.querySelector(".sa-bubble b")).toBeNull();

    // The next page applies the cached values immediately.
    configMock.mockImplementation(() => new Promise(() => {}));
    const nextPage = mountWidget();
    expect(nextPage.$(".sa-title").textContent).toBe("Ava");
  });

  it("keeps the theme editor's values when the app has none or cannot be reached", async () => {
    configMock.mockImplementation(() => Promise.reject(new TypeError("offline")));
    const widget = mountWidget();
    await flush();

    expect(widget.$(".sa-title").textContent).toBe("Shop helper");
    expect(widget.bubbles()).toEqual(["Welcome! Ask me anything."]);
    expect(widget.$(".sa").hidden).toBe(false);
  });

  it("hides itself when the merchant has paused chat", async () => {
    configMock.mockImplementation(() => appConfig({ enabled: false }));
    const widget = mountWidget({ stylesheet: "https://cdn.example/shopi-assist.css" });
    await flush();

    // Still hidden once the stylesheet arrives.
    widget.root.querySelector("link")!.dispatchEvent(new Event("load"));
    expect(widget.$(".sa").hidden).toBe(true);
  });

  it("stays visible in themes that hide empty divs (Dawn's div:empty rule)", () => {
    const style = document.createElement("style");
    style.textContent = "div:empty { display: none; }";
    document.head.appendChild(style);
    try {
      const widget = mountWidget();
      // The host has no light-DOM children, so the theme rule matches it...
      expect(widget.host.matches("div:empty")).toBe(true);
      // ...and only an !important inline style keeps it rendered.
      expect(widget.host.style.getPropertyValue("display")).toBe("block");
      expect(widget.host.style.getPropertyPriority("display")).toBe("important");
      expect(getComputedStyle(widget.host).display).toBe("block");
    } finally {
      style.remove();
    }
  });

  it("never writes HTML strings into the page", () => {
    const code = WIDGET_SOURCE.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(code).not.toMatch(/\beval\(|new Function\(/);
  });

  it("survives blocked storage and does not mount twice", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    const widget = mountWidget();
    widget.launcher.click();
    expect(widget.panel.hidden).toBe(false);

    const api = (window as unknown as { ShopiAssist: { mount: (host: Element) => unknown } }).ShopiAssist;
    expect(api.mount(widget.host)).toBeNull();
    expect(widget.root.querySelectorAll(".sa-launcher")).toHaveLength(1);

    getItem.mockRestore();
    setItem.mockRestore();
  });
});
