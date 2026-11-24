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

  it("lets the shopper set a quantity for each version on the card, then buy them", async () => {
    const variants = [
      { id: "201", title: "Regular", price: { amount: "24.95", currencyCode: "USD" }, available: true },
      { id: "202", title: "Special", price: { amount: "49.95", currencyCode: "USD" }, available: false },
      { id: "203", title: "Sample", price: { amount: "9.95", currencyCode: "USD" }, available: true },
    ];
    configMock.mockImplementation(() => appConfig({ buyNow: true }));
    const { adds } = liveCart(
      { 201: ["Ski Wax - Regular", 2495], 203: ["Ski Wax - Sample", 995] },
      () =>
        reply("Ski Wax comes in three versions.", {
          cards: [
            card({
              title: "Ski Wax",
              price: { amount: "9.95", currencyCode: "USD" },
              variantId: null,
              variants,
            }),
          ],
        }),
    );
    const widget = mountWidget();
    await flush();
    widget.launcher.click();
    widget.send("ski wax?");
    await flush();

    const item = widget.$(".sa-card");
    const rows = Array.from(item.querySelectorAll<HTMLElement>(".sa-variant"));
    expect(rows.map((row) => row.querySelector(".sa-variant-name")!.textContent)).toEqual([
      "1.Regular",
      "2.Special",
      "3.Sample",
    ]);
    expect(rows.map((row) => row.querySelector(".sa-variant-note")!.textContent)).toEqual([
      "$24.95",
      "Sold out",
      "$9.95",
    ]);
    // A sold-out version has no quantity to set.
    expect(rows.map((row) => row.querySelectorAll(".sa-stepper-button").length)).toEqual([2, 0, 2]);
    expect(item.querySelector(".sa-card-price")!.textContent).toBe("From $9.95");
    expect(item.textContent).not.toContain("Choose options");

    // Nothing can be added until something has a quantity.
    const [add, buy] = Array.from(item.querySelectorAll<HTMLButtonElement>(".sa-card-actions button"));
    expect([add.textContent, buy.textContent]).toEqual(["Add to cart", "Buy now"]);
    expect([add.disabled, buy.disabled]).toEqual([true, true]);
    expect(item.querySelector(".sa-card-total")!.textContent).toBe("Set how many you want of each.");

    const step = (row: HTMLElement, label: "+" | "−") =>
      Array.from(row.querySelectorAll<HTMLButtonElement>(".sa-stepper-button"))
        .find((button) => button.textContent === label)!
        .click();
    step(rows[0], "+");
    step(rows[2], "+");
    step(rows[2], "+");
    step(rows[2], "+");
    step(rows[2], "−");
    expect(rows.map((row) => row.querySelector(".sa-stepper-count")?.textContent)).toEqual(["1", undefined, "2"]);
    expect(item.querySelector(".sa-card-total")!.textContent).toBe("3 items · $44.85");
    expect([add.disabled, buy.disabled]).toEqual([false, false]);

    buy.click();
    await flush();
    expect(adds).toEqual([
      [
        { id: 201, quantity: 1 },
        { id: 203, quantity: 2 },
      ],
    ]);
    const summary = widget.$(".sa-order").textContent;
    expect(summary).toContain("Ski Wax - Regular");
    expect(summary).toContain("Ski Wax - Sample");

    // Back to none: the buttons switch off again.
    step(rows[0], "−");
    step(rows[2], "−");
    step(rows[2], "−");
    expect([add.disabled, buy.disabled]).toEqual([true, true]);
  });

  it("adds the picked versions to the cart, starts the only one in stock at one, and offers Buy now only when allowed", async () => {
    fetchMock.mockImplementation((url: string) =>
      url === "/cart/add.js"
        ? jsonResponse({ items: [] })
        : reply("Ski Wax.", {
            cards: [
              card({
                title: "Ski Wax",
                variantId: null,
                variants: [
                  { id: "201", title: "Regular", price: { amount: "18.0", currencyCode: "USD" }, available: false },
                  { id: "202", title: "Sample", price: { amount: "18.0", currencyCode: "USD" }, available: true },
                  { id: "javascript:alert(1)", title: "Bad", price: null, available: true },
                ],
              }),
            ],
          }),
    );
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("ski wax?");
    await flush();

    const item = widget.$(".sa-card");
    const rows = Array.from(item.querySelectorAll<HTMLElement>(".sa-variant"));
    // The malformed version is dropped. Same price for both: no "From".
    expect(rows.map((row) => row.querySelector(".sa-variant-name")!.textContent)).toEqual(["1.Regular", "2.Sample"]);
    expect(item.querySelector(".sa-card-price")!.textContent).toBe("$18.00");
    expect(rows[1].querySelector(".sa-stepper-count")!.textContent).toBe("1");
    expect(item.querySelector(".sa-card-total")!.textContent).toBe("1 item · $18.00");

    const buttons = Array.from(item.querySelectorAll<HTMLButtonElement>(".sa-card-actions button"));
    expect(buttons.map((button) => button.textContent)).toEqual(["Add to cart"]);
    expect(buttons[0].disabled).toBe(false);
    buttons[0].click();
    await flush();

    const cartCall = fetchMock.mock.calls.find((call) => call[0] === "/cart/add.js")!;
    expect(JSON.parse((cartCall[1] as RequestInit).body as string)).toEqual({
      items: [{ id: 202, quantity: 1 }],
    });
    expect(buttons[0].textContent).toBe("Added");
  });

  it("folds the picker away in a list of products, with one pair of buttons for the whole list", async () => {
    const variants = ["Ice", "Dawn", "Powder"].map((title, index) => ({
      id: String(301 + index),
      title,
      price: { amount: "699.95", currencyCode: "USD" },
      available: true,
    }));
    const { adds } = liveCart(
      { 101: ["Trail Mug", 1800], 303: ["The Complete Snowboard - Powder", 69995] },
      () =>
        reply("Trail Mug and The Complete Snowboard.", {
          cards: [
            card(),
            card({ title: "The Complete Snowboard", handle: "complete", variantId: null, variants }),
          ],
        }),
    );
    configMock.mockImplementation(() => appConfig({ buyNow: true }));
    const widget = mountWidget();
    await flush();
    widget.launcher.click();
    widget.send("cheapest?");
    await flush();

    const board = widget.all(".sa-card")[1];
    const picker = board.querySelector<HTMLElement>(".sa-card-pick")!;
    expect(picker.hidden).toBe(true);
    const unfold = board.querySelector<HTMLButtonElement>(".sa-card-body button")!;
    expect(unfold.textContent).toBe("Choose from 3 options");
    expect(board.querySelector(".sa-card-body")!.textContent).toContain("View");

    unfold.click();
    expect(picker.hidden).toBe(false);
    expect(board.querySelector(".sa-card-body button")).toBeNull();
    // Every version costs the same, so the price stays on the card only.
    expect(picker.querySelector(".sa-variant-note")).toBeNull();
    expect(Array.from(picker.querySelectorAll(".sa-variant-name")).map((name) => name.textContent)).toEqual([
      "1.Ice",
      "2.Dawn",
      "3.Powder",
    ]);

    // No card has buttons of its own: the list shares one pair, under it.
    expect(widget.all(".sa-card").map((item) => item.textContent)).not.toContain("Add to cart");
    expect(widget.all(".sa-card .sa-card-total")).toHaveLength(0);
    const bar = widget.$(".sa-cards-bar");
    const [add, buy] = Array.from(bar.querySelectorAll<HTMLButtonElement>("button"));
    expect([add.textContent, buy.textContent]).toEqual(["Add to cart", "Buy now"]);
    expect([add.disabled, buy.disabled]).toEqual([true, true]);
    expect(bar.querySelector(".sa-card-total")!.textContent).toBe("Set how many you want of each product above.");

    // A product with one version has its quantity on the card.
    const mug = widget.all(".sa-card")[0];
    const press = (scope: Element, label: "+" | "−") =>
      Array.from(scope.querySelectorAll<HTMLButtonElement>(".sa-stepper-button"))
        .find((button) => button.textContent === label)!
        .click();
    expect(mug.querySelector(".sa-stepper-count")!.textContent).toBe("0");
    press(mug, "+");
    press(mug, "+");
    press(picker.querySelectorAll(".sa-variant")[2], "+");
    expect(bar.querySelector(".sa-card-total")!.textContent).toBe("3 items · $735.95");
    expect([add.disabled, buy.disabled]).toEqual([false, false]);
    expect([mug.classList.contains("sa-card-on"), board.classList.contains("sa-card-on")]).toEqual([true, true]);

    buy.click();
    await flush();
    expect(adds).toEqual([
      [
        { id: 101, quantity: 2 },
        { id: 303, quantity: 1 },
      ],
    ]);
    expect(widget.all(".sa-order")).toHaveLength(1);

    press(mug, "−");
    press(mug, "−");
    press(picker.querySelectorAll(".sa-variant")[2], "−");
    expect([add.disabled, buy.disabled]).toEqual([true, true]);
  });

  it("asks for the app's settings again after a reply when the page loaded without them", async () => {
    // The app could not be reached when the page loaded.
    configMock.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    configMock.mockImplementation(() => appConfig({ buyNow: true }));
    const widget = mountWidget();
    await flush();
    widget.launcher.click();
    widget.send("mugs?");
    await flush();
    expect(widget.all(".sa-card")).toHaveLength(0);

    fetchMock.mockImplementation(() => reply("Try the Trail Mug.", { cards: [card()] }));
    widget.send("mugs?");
    await flush();

    expect(configMock).toHaveBeenCalledTimes(2);
    expect(widget.$(".sa-card .sa-card-actions").textContent).toBe("Add to cartBuy nowView");
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

    // In a list the quantity is set on the card and added from under the list.
    const more = Array.from(cards[0].querySelectorAll("button")).find((button) => button.textContent === "+")!;
    more.click();
    const addButton = widget.$(".sa-cards-bar button");
    expect(addButton.textContent).toBe("Add to cart");
    addButton.click();
    await flush();

    const cartCall = fetchMock.mock.calls.find((call) => call[0] === "/cart/add.js")!;
    expect(JSON.parse((cartCall[1] as RequestInit).body as string)).toEqual({
      items: [{ id: 101, quantity: 1 }],
    });
    expect(addButton.textContent).toBe("Added");
  });

  it("shows the answers to the assistant's question as buttons, with Other for typing", async () => {
    const choices = {
      type: "choices",
      options: ["Changed my mind", "Damaged or defective", " damaged or defective ", "<b>Too big</b>", ""],
      other: true,
    };
    fetchMock.mockImplementation(() => reply("What is the reason for the return?", { actions: [choices] }));
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("i want to return order 1012");
    await flush();

    const buttons = () => widget.all(".sa-choices button");
    // Each answer once, as text; then the way out for anything else.
    expect(buttons().map((button) => button.textContent)).toEqual([
      "Changed my mind",
      "Damaged or defective",
      "<b>Too big</b>",
      "Other…",
    ]);
    expect(widget.root.querySelector(".sa-choices b")).toBeNull();

    // Pressing an answer sends it as the shopper's message and clears the buttons.
    fetchMock.mockImplementation(() => reply("Thanks.", { actions: [choices] }));
    buttons()[1].click();
    expect(buttons()).toHaveLength(0);
    await flush();
    expect(lastBody(fetchMock).message).toBe("Damaged or defective");
    expect(widget.bubbles().slice(-2)).toEqual(["Damaged or defective", "Thanks."]);

    // Other hands over the text box instead of sending anything.
    const sent = fetchMock.mock.calls.length;
    buttons().at(-1)!.click();
    expect(buttons()).toHaveLength(0);
    expect(fetchMock.mock.calls).toHaveLength(sent);
    expect(widget.root.activeElement).toBe(widget.input);
    expect(widget.input.placeholder).toBe("Type your answer…");
    fetchMock.mockImplementation(() => reply("Noted.", { actions: [choices] }));
    widget.send("the strap snapped");
    expect(widget.input.placeholder).toBe("Ask a question…");
    await flush();

    // Typing an answer instead of pressing one clears the buttons too, and
    // fewer than two answers are not worth buttons.
    expect(buttons()).toHaveLength(4);
    fetchMock.mockImplementation(() =>
      reply("Okay.", { actions: [{ type: "choices", options: ["Only one"] }] }),
    );
    widget.send("something else");
    expect(buttons()).toHaveLength(0);
    await flush();
    expect(widget.root.querySelector(".sa-choices")).toBeNull();
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

  it("tells the assistant what is in the cart with each message", async () => {
    cartMock.mockImplementation(() =>
      jsonResponse(
        cartJson(
          cartLine(101, 2, "Trail Mug", 1800),
          cartLine(103, 1, "Camp Blanket - Large", 8950),
          // The same variant on a second line (say, with a gift note) counts once.
          cartLine(101, 1, "Trail Mug", 1800),
        ),
      ),
    );
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("what's in my cart?");
    await flush();

    expect(lastBody(fetchMock).cart).toEqual([
      { variantId: "101", title: "Trail Mug", quantity: 3 },
      { variantId: "103", title: "Camp Blanket - Large", quantity: 1 },
    ]);

    // An empty cart is said to be empty; an unreadable one is left out.
    cartMock.mockImplementation(() => jsonResponse(cartJson()));
    widget.send("and now?");
    await flush();
    expect(lastBody(fetchMock).cart).toEqual([]);

    cartMock.mockImplementation(() => jsonResponse({ error: "nope" }, 500));
    widget.send("and now?");
    await flush();
    expect(lastBody(fetchMock)).not.toHaveProperty("cart");
    expect(widget.bubbles().at(-1)).toBe("Hello!");
  });

  it("orders only the named items when asked to, emptying the cart first", async () => {
    const calls: string[] = [];
    const quantities = new Map<number, number>([[101, 2], [103, 1]]);
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/cart/clear.js") {
        calls.push("clear");
        quantities.clear();
        return jsonResponse(cartJson());
      }
      if (url === "/cart/add.js") {
        const items = JSON.parse(init!.body as string).items as Array<{ id: number; quantity: number }>;
        calls.push(`add ${items.map((item) => `${item.id}x${item.quantity}`).join(",")}`);
        for (const item of items) quantities.set(item.id, item.quantity);
        return jsonResponse({ items: [] });
      }
      return reply("Only the blanket, then.", {
        actions: [{ type: "order", replace: true, items: [{ variantId: "103", quantity: 1 }] }],
      });
    });
    cartMock.mockImplementation(() =>
      jsonResponse(
        cartJson(
          ...[...quantities].map(([id, quantity]) =>
            cartLine(id, quantity, id === 101 ? "Trail Mug" : "Camp Blanket", id === 101 ? 1800 : 8950),
          ),
        ),
      ),
    );
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("only the blanket");
    await flush();
    await flush();

    expect(calls).toEqual(["clear", "add 103x1"]);
    expect(widget.all(".sa-order-line").map((line) => line.textContent)).toEqual([
      "1 \u00d7Camp Blanket$89.50",
    ]);
  });

  it("empties the cart or takes one item out when the assistant asks", async () => {
    const lines = [
      { ...cartLine(101, 1, "Trail Mug", 1800), key: "101:abc" },
      { ...cartLine(103, 1, "Camp Blanket", 8950), key: "103:def" },
    ];
    let actions: unknown[] = [{ type: "checkout" }];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/cart/change.js") {
        const change = JSON.parse(init!.body as string);
        const index = lines.findIndex((line) => line.key === change.id);
        if (index >= 0) lines.splice(index, 1);
        return jsonResponse(cartJson(...lines));
      }
      if (url === "/cart/clear.js") {
        lines.length = 0;
        return jsonResponse(cartJson());
      }
      return reply("Done.", { actions });
    });
    cartMock.mockImplementation(() => jsonResponse(cartJson(...lines)));
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("checkout");
    await flush();
    expect(widget.all(".sa-order-item")).toHaveLength(2);

    // Removing an item updates the summary that is on screen.
    actions = [
      { type: "remove_from_cart", variantId: "103" },
      { type: "remove_from_cart", variantId: "1 OR 1=1" },
    ];
    widget.send("remove the blanket");
    await flush();
    await flush();
    expect(widget.all(".sa-notice").at(-1)!.textContent).toBe("Removed from your cart.");
    expect(widget.all(".sa-order-item").map((item) => item.textContent)).toEqual(["Trail Mug"]);

    actions = [{ type: "remove_from_cart", variantId: "999" }];
    widget.send("remove the kettle");
    await flush();
    expect(widget.all(".sa-notice").at(-1)!.textContent).toBe("That item isn't in your cart.");

    // Emptying the cart takes the summary away with it.
    actions = [{ type: "clear_cart" }];
    widget.send("clear the cart");
    await flush();
    expect(widget.all(".sa-notice").at(-1)!.textContent).toBe("Your cart is empty now.");
    expect(widget.root.querySelector(".sa-order")).toBeNull();
    expect(lines).toHaveLength(0);
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

  it("changes how many of a line the order holds, without leaving the chat", async () => {
    const lines = [{ ...cartLine(101, 2, "Trail Mug", 1800), key: "101:abc" }];
    let refuse = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url !== "/cart/change.js") return reply("Here.", { actions: [{ type: "checkout" }] });
      if (refuse) return jsonResponse({ status: 422, description: "Sold out" }, 422);
      const change = JSON.parse(init!.body as string);
      lines[0] = { ...cartLine(101, change.quantity, "Trail Mug", 1800), key: "101:abc" };
      return jsonResponse(cartJson(...lines));
    });
    cartMock.mockImplementation(() => jsonResponse(cartJson(...lines)));
    const widget = mountWidget();
    widget.launcher.click();
    widget.send("checkout");
    await flush();

    const step = (label: string) =>
      widget.all(".sa-order .sa-stepper-button").find((button) => button.textContent === label) as HTMLButtonElement;
    expect(widget.$(".sa-order .sa-stepper-count").textContent).toBe("2");
    expect(step("+").getAttribute("aria-label")).toBe("One more: Trail Mug");
    // No link out to the cart page.
    expect(widget.$(".sa-order").textContent).not.toContain("Edit cart");

    step("+").click();
    await flush();
    const changes = () =>
      fetchMock.mock.calls
        .filter((call) => call[0] === "/cart/change.js")
        .map((call) => JSON.parse((call[1] as RequestInit).body as string));
    expect(changes()).toEqual([{ id: "101:abc", quantity: 3 }]);
    expect(widget.all(".sa-order")).toHaveLength(1);
    expect(widget.$(".sa-order .sa-stepper-count").textContent).toBe("3");
    expect(widget.$(".sa-order-total").textContent).toBe("Subtotal$54.00");

    step("\u2212").click();
    step("\u2212").click();
    await flush();
    // The second press landed on a disabled button: one change at a time.
    expect(changes().at(-1)).toEqual({ id: "101:abc", quantity: 2 });
    expect(changes()).toHaveLength(2);

    step("\u2212").click();
    await flush();
    // At one, less is off: Remove is the way to take the line out.
    expect(widget.$(".sa-order .sa-stepper-count").textContent).toBe("1");
    expect(step("\u2212").disabled).toBe(true);

    refuse = true;
    step("+").click();
    await flush();
    expect(widget.$(".sa-order .sa-stepper-count").textContent).toBe("1");
    expect(widget.all(".sa-notice").at(-1)!.textContent).toBe(
      "That quantity couldn't be set. Your order is as shown above.",
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
    expect(widget.$(".sa-order-item").textContent).toBe("Tasse");
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

    /** A form layout as the app sends it: fields in rows, named for the country. */
    const formFor = (province: string | null, zip: string, extra: string[] = []) => [
      [
        { name: "firstName", label: "First name (optional)", required: false },
        { name: "lastName", label: "Last name", required: true },
      ],
      ...extra.map((name) => [{ name, label: "Company", required: true }]),
      [{ name: "address1", label: "Address", required: true }],
      [{ name: "address2", label: "Apartment, suite, etc (optional)", required: false }],
      [
        { name: "city", label: "City", required: true },
        ...(province ? [{ name: "province", label: province, required: true }] : []),
        { name: "zip", label: zip, required: true },
      ],
      [{ name: "phone", label: "Phone", required: true }],
    ];

    /** A store that takes chat orders, with two mugs in the cart and the summary on screen. */
    async function openForm(
      respond: (body: Record<string, unknown>) => Promise<Response>,
      config: Record<string, unknown> = {},
      /** Runs once the widget is on the page, before the order form is opened. */
      setup: () => void = () => {},
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
                { code: "CA", name: "Canada", form: 0 },
                { code: "US", name: "United States", form: 1 },
              ],
              forms: [formFor("Province", "Postal code"), formFor("State", "ZIP code")],
              payment: {
                name: "COD (cash or card at the door)",
                note: "Have the exact amount ready.",
                online: ["Visa", "Mastercard", "Shop Pay"],
              },
            }),
      );
      const widget = mountWidget();
      setup();
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
      firstName: " Ada ",
      lastName: "Lovelace",
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

    it("sends only the ticked lines to the store's checkout, wherever orders are taken", async () => {
      const opened = vi.spyOn(window, "open");
      try {
        for (const chatOrders of [false, true]) {
          document.body.textContent = "";
          window.localStorage.clear();
          configMock.mockImplementation(() => appConfig({ chatOrders, buyNow: true }));
          const lines = [
            { ...cartLine(101, 2, "Trail Mug", 1800), key: "101:k", properties: { Engraving: "Ada" } },
            {
              ...cartLine(103, 1, "Camp Blanket", 8950),
              key: "103:k",
              selling_plan_allocation: { selling_plan: { id: 77 } },
            },
          ];
          cartMock.mockImplementation(() =>
            jsonResponse({ ...cartJson(...lines), discount_codes: [{ code: "WELCOME", applicable: true }] }),
          );
          fetchMock.mockImplementation(() => reply("Here.", { actions: [{ type: "checkout" }] }));
          orderMock.mockReset().mockImplementation((_url: string, init?: RequestInit) =>
            init?.method === "POST"
              ? jsonResponse({ ok: true, step: "checkout", checkoutUrl: "https://shop.example/cart/c/abc?key=1" })
              : jsonResponse({ ok: true, countries: [] }),
          );
          const tab = { opener: {} as unknown, close: vi.fn(), location: { replace: vi.fn() } };
          opened.mockReset().mockImplementation(() => tab as unknown as Window);

          const widget = mountWidget();
          await flush();
          widget.launcher.click();
          widget.send("checkout");
          await flush();

          const control = () => widget.$(chatOrders ? ".sa-order-online" : ".sa-order-checkout");
          // The whole cart is ticked: a plain link to the checkout, and both lines can be unticked.
          expect(control().getAttribute("href")).toBe("/checkout");
          const ticks = widget.all(".sa-order-pick") as HTMLInputElement[];
          expect(ticks.map((tick) => tick.checked)).toEqual([true, true]);

          ticks[1].checked = false;
          ticks[1].dispatchEvent(new Event("change", { bubbles: true }));
          expect(widget.$(".sa-order-total").textContent).toBe("Subtotal$36.00");
          expect(control().tagName).toBe("BUTTON");
          expect(control().textContent).toBe(chatOrders ? "Pay online at checkout instead" : "Go to checkout");

          control().click();
          await flush();
          expect(orderPosts()).toEqual([
            {
              step: "checkout",
              items: [{ variantId: "101", quantity: 2, properties: { Engraving: "Ada" } }],
              country: "US",
              discountCodes: ["WELCOME"],
            },
          ]);
          if (chatOrders) {
            // A new tab, opened with the press and then sent to the checkout.
            expect(opened.mock.calls).toEqual([["", "_blank"]]);
            expect(tab.opener).toBeNull();
            expect(tab.location.replace).toHaveBeenCalledWith("https://shop.example/cart/c/abc?key=1");
          } else {
            expect(opened.mock.calls).toEqual([["https://shop.example/cart/c/abc?key=1", "_self"]]);
          }
          // The cart on the storefront is not touched.
          expect(fetchMock.mock.calls.some((call) => String(call[0]).startsWith("/cart/"))).toBe(false);

          // Refused, or an address that is not a checkout: say so and go nowhere.
          opened.mockClear();
          tab.close.mockClear();
          orderMock.mockImplementation(() =>
            jsonResponse({ ok: false, error: { code: "unavailable", message: "These items are sold out." } }),
          );
          control().click();
          await flush();
          expect(widget.all(".sa-notice").at(-1)!.textContent).toBe("These items are sold out.");
          if (chatOrders) expect(tab.close).toHaveBeenCalled();
          else expect(opened).not.toHaveBeenCalled();
          orderMock.mockImplementation(() =>
            jsonResponse({ ok: true, step: "checkout", checkoutUrl: "javascript:alert(1)" }),
          );
          control().click();
          await flush();
          expect(widget.all(".sa-notice").at(-1)!.textContent).toBe(
            "The checkout couldn't be opened. Please try again.",
          );
          expect(opened.mock.calls.every((call) => call[0] === "")).toBe(true);
        }
      } finally {
        opened.mockRestore();
      }
    });

    it("takes the details, shows the total and places the order", async () => {
      const { widget, field, fill, submit } = await openForm((body) =>
        body.step === "quote"
          ? jsonResponse({ ok: true, step: "quote", quote: quote(body.shippingRateHandle as string) })
          : jsonResponse({ ok: true, step: "place", order: { name: "#1001", total: usd("54.6") } }),
      );

      // The form asks for what a delivery needs, with the browsing country chosen.
      expect(widget.all(".sa-order-form label").map((label) => label.textContent)).toEqual([
        "Email (optional, for order updates)",
        "Country/region",
        "First name (optional)",
        "Last name",
        "Address",
        "Apartment, suite, etc (optional)",
        "City",
        "State",
        "ZIP code",
        "Phone",
      ]);
      // Laid out under the checkout's own headings, names and state/ZIP side by side.
      expect(widget.all(".sa-order-form .sa-order-title").map((title) => title.textContent)).toEqual([
        "Contact",
        "Delivery",
      ]);
      expect(widget.all(".sa-field-half label").map((label) => label.textContent)).toEqual([
        "First name (optional)",
        "Last name",
        "State",
        "ZIP code",
      ]);
      expect(widget.$('.sa-order-form button[type="submit"]').textContent).toBe("Continue to shipping");
      expect(field("countryCode").value).toBe("US");
      expect(field("phone").getAttribute("autocomplete")).toBe("tel");

      fill(DETAILS);
      await submit();

      expect(orderPosts()[0]).toEqual({
        step: "quote",
        items: [{ variantId: "101", quantity: 2 }],
        contact: {
          firstName: "Ada",
          lastName: "Lovelace",
          phone: "+1 613 555 0111",
          email: "ada@example.com",
        },
        address: {
          company: "",
          address1: "12 Analytical Way",
          address2: "",
          city: "Ottawa",
          province: "ON",
          zip: "K1A 0B1",
          countryCode: "CA",
        },
      });

      // Review: lines, delivery options and what will be paid on delivery.
      expect(widget.all(".sa-order-form .sa-order-title").map((title) => title.textContent)).toEqual([
        "Shipping method",
        "Payment",
        "Order summary",
      ]);
      expect(widget.all(".sa-order-recap-row").map((row) => row.textContent)).toEqual([
        "Contactada@example.com · +1 613 555 0111Change",
        "Ship toAda Lovelace, 12 Analytical Way, Ottawa, ON, K1A 0B1, CanadaChange",
      ]);
      expect(widget.$(".sa-order-totals").textContent).toBe(
        "Subtotal$36.00Shipping$5.00Tax$3.60Total$44.60",
      );
      // What the store calls it and tells buyers, then what its checkout takes.
      expect(widget.all(".sa-order-pay").map((option) => option.textContent)).toEqual([
        "COD (cash or card at the door)You pay $44.60 when your order arrives.Have the exact amount ready.",
        "Pay online at checkoutVisa, Mastercard, Shop Pay",
      ]);
      const online = widget.$<HTMLAnchorElement>("a.sa-order-pay-online");
      expect([online.getAttribute("href"), online.target]).toEqual(["/checkout", "_blank"]);
      expect(widget.$('.sa-order-form button[type="submit"]').textContent).toBe("Complete order");

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
      // The chat the order came from, so the assistant can be told about it.
      expect(placed.conversationId).toBe("conv12345678");
      expect(placed.visitorId).toMatch(/^[a-f0-9]{32}$/);
      // A quote places nothing, so it does not need to say.
      expect(orderPosts()[0]).not.toHaveProperty("conversationId");

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

    it("orders what was just picked and leaves the rest of the cart unticked", async () => {
      configMock.mockImplementation(() => appConfig({ chatOrders: true, buyNow: true }));
      const catalog: Record<number, [string, number]> = {
        101: ["Trail Mug", 1800],
        102: ["Camp Kettle", 4500],
        103: ["Camp Blanket", 8950],
      };
      // In the cart from before: two mugs and a blanket.
      const held = new Map<number, number>([
        [101, 2],
        [103, 1],
      ]);
      const cartNow = () =>
        cartJson(
          ...[...held].map(([id, quantity]) => ({
            ...cartLine(id, quantity, catalog[id][0], catalog[id][1]),
            key: `${id}:k`,
          })),
        );
      cartMock.mockImplementation(() => jsonResponse(cartNow()));
      const cartCalls: Array<[string, unknown]> = [];
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (!url.startsWith("/cart/")) {
          return reply("Two picks.", {
            cards: [
              card(),
              card({ title: "Camp Kettle", handle: "camp-kettle", variantId: "102", price: usd("45.0") }),
            ],
          });
        }
        const body = JSON.parse(init!.body as string);
        cartCalls.push([url, body]);
        if (url === "/cart/add.js") {
          for (const item of body.items) held.set(item.id, (held.get(item.id) ?? 0) + item.quantity);
          return jsonResponse({ items: [] });
        }
        if (url === "/cart/change.js") {
          const id = Number(String(body.id).split(":")[0]);
          if (body.quantity > 0) held.set(id, body.quantity);
          else held.delete(id);
        }
        return jsonResponse(cartNow());
      });
      orderMock.mockImplementation((_url: string, init?: RequestInit) => {
        if (init?.method !== "POST") {
          return jsonResponse({ ok: true, countries: [{ code: "CA", name: "Canada" }] });
        }
        return JSON.parse(init.body as string).step === "quote"
          ? jsonResponse({ ok: true, step: "quote", quote: quote() })
          : jsonResponse({ ok: true, step: "place", order: { name: "#1003", total: usd("44.6") } });
      });

      const widget = mountWidget();
      await flush();
      widget.launcher.click();
      widget.send("mugs?");
      await flush();

      // One of each, where the cart already holds two mugs.
      for (const item of widget.all(".sa-card")) {
        Array.from(item.querySelectorAll("button"))
          .find((button) => button.textContent === "+")!
          .click();
      }
      Array.from(widget.$(".sa-cards-bar").querySelectorAll("button"))
        .find((button) => button.textContent === "Buy now")!
        .click();
      await flush();

      // The cart now holds exactly what was picked of each, plus the blanket.
      expect(cartCalls).toEqual([
        ["/cart/add.js", { items: [{ id: 102, quantity: 1 }] }],
        ["/cart/change.js", { id: "101:k", quantity: 1 }],
      ]);

      const names = (selector: string) => widget.all(`${selector} .sa-order-item`).map((item) => item.textContent);
      const ticks = () => widget.all(".sa-order-pick") as HTMLInputElement[];
      expect(names(".sa-order-lines:not(.sa-order-waiting)")).toEqual(["Trail Mug", "Camp Kettle"]);
      expect(names(".sa-order-waiting")).toEqual(["Camp Blanket"]);
      expect(ticks().map((tick) => tick.checked)).toEqual([true, true, false]);
      expect(widget.$(".sa-order-also").textContent).toBe(
        "Also in your cart. Tick anything you want in this order.",
      );
      // Only what is ticked is counted, and has a quantity to change.
      expect(widget.$(".sa-order-total").textContent).toBe("Subtotal$63.00");
      expect(widget.all(".sa-order-waiting .sa-stepper")).toHaveLength(0);
      // Paying online takes only the ticked lines too: a button, not a plain link.
      expect(widget.$(".sa-order-online").tagName).toBe("BUTTON");

      const tick = (title: string, on: boolean) => {
        const box = ticks().find((entry) => entry.getAttribute("aria-label")!.endsWith(title))!;
        box.checked = on;
        box.dispatchEvent(new Event("change", { bubbles: true }));
      };
      tick("Camp Blanket", true);
      expect(widget.all(".sa-order")).toHaveLength(1);
      expect(widget.all(".sa-order-waiting")).toHaveLength(0);
      expect(widget.$(".sa-order-total").textContent).toBe("Subtotal$152.50");
      // Everything ticked is the whole cart: the plain link to the checkout.
      expect(widget.$(".sa-order-online").getAttribute("href")).toBe("/checkout");
      tick("Camp Blanket", false);
      expect(widget.$(".sa-order-total").textContent).toBe("Subtotal$63.00");

      // The ticks are kept with the chat, for the next page.
      const saved = JSON.parse(Object.values({ ...window.localStorage }).join("")) as {
        messages: Array<{ role: string; lines?: Array<{ on: boolean }> }>;
      };
      expect(saved.messages.find((message) => message.role === "order")!.lines!.map((line) => line.on)).toEqual([
        true,
        false,
        true,
      ]);

      widget.$<HTMLButtonElement>(".sa-order-here").click();
      await flush();
      for (const [name, value] of Object.entries(DETAILS)) {
        widget.$<HTMLInputElement>(`.sa-order-form [name="${name}"]`).value = value;
      }
      const submit = async () => {
        widget
          .$<HTMLFormElement>(".sa-order-form")
          .dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
        await flush();
      };
      await submit();
      // The blanket is not part of the order.
      expect(orderPosts()[0].items).toEqual([
        { variantId: "101", quantity: 1 },
        { variantId: "102", quantity: 1 },
      ]);

      await submit();
      expect(widget.all(".sa-notice").at(-1)!.textContent).toContain("Order #1003 is placed.");
      // What was ordered leaves the cart; the blanket stays in it.
      expect(cartCalls.slice(2)).toEqual([
        ["/cart/change.js", { id: "101:k", quantity: 0 }],
        ["/cart/change.js", { id: "102:k", quantity: 0 }],
      ]);
      expect([...held.keys()]).toEqual([103]);
    });

    it("draws the form the app sends for the delivery country and the store", async () => {
      const { widget, field, submit } = await openForm(
        (body) => jsonResponse({ ok: true, step: "quote", quote: quote(body.shippingRateHandle as string) }),
        {},
        () =>
          orderMock.mockImplementation((_url: string, init?: RequestInit) =>
            init?.method === "POST"
              ? jsonResponse({ ok: true, step: "quote", quote: quote() })
              : jsonResponse({
                  ok: true,
                  countries: [
                    { code: "AE", name: "United Arab Emirates", form: 0 },
                    { code: "GB", name: "United Kingdom", form: 1 },
                    { code: "ZZ", name: "Elsewhere", form: 9 },
                  ],
                  forms: [
                    // No postal code in the Emirates; an emirate to pick.
                    formFor("Emirate", "unused").map((row) => row.filter((entry) => entry.name !== "zip")),
                    // No county in the United Kingdom, and this store asks for a company.
                    formFor(null, "Postcode", ["company"]),
                  ],
                }),
          ),
      );
      const labels = () => widget.all(".sa-order-form label").map((label) => label.textContent);
      const pick = (code: string) => {
        field("countryCode").value = code;
        field("countryCode").dispatchEvent(new Event("change", { bubbles: true }));
      };

      expect(field("countryCode").value).toBe("AE");
      expect(labels().slice(2)).toEqual([
        "First name (optional)",
        "Last name",
        "Address",
        "Apartment, suite, etc (optional)",
        "City",
        "Emirate",
        "Phone",
      ]);
      expect(widget.root.querySelector('.sa-order-form [name="zip"]')).toBeNull();
      field("lastName").value = "Lovelace";
      field("province").value = "Dubai";

      pick("GB");
      expect(labels().slice(2)).toEqual([
        "First name (optional)",
        "Last name",
        "Company",
        "Address",
        "Apartment, suite, etc (optional)",
        "City",
        "Postcode",
        "Phone",
      ]);
      // What was typed stays; what this country's form does not have goes.
      expect(field("lastName").value).toBe("Lovelace");
      expect(widget.root.querySelector('.sa-order-form [name="province"]')).toBeNull();
      expect(field("company").required).toBe(true);
      expect(field("company").getAttribute("autocomplete")).toBe("organization");
      // City and postcode share a row; the company has one to itself.
      expect(widget.all(".sa-field-half label").map((label) => label.textContent)).toEqual([
        "First name (optional)",
        "Last name",
        "City",
        "Postcode",
      ]);

      field("company").value = "Analytical Engines";
      field("address1").value = "1 High Street";
      field("city").value = "London";
      field("zip").value = "SE22 8DL";
      field("phone").value = "+44 20 7946 0143";
      await submit();
      expect(orderPosts()[0].address).toEqual({
        company: "Analytical Engines",
        address1: "1 High Street",
        address2: "",
        city: "London",
        province: "",
        zip: "SE22 8DL",
        countryCode: "GB",
      });
      expect(widget.$(".sa-order-recap").textContent).toContain(
        "Lovelace, Analytical Engines, 1 High Street, London, SE22 8DL, United Kingdom",
      );

      // A country the app sent no form for gets every field; the app checks them.
      widget.all(".sa-order-change")[0].click();
      pick("ZZ");
      expect(labels().slice(2)).toEqual([
        "First name (optional)",
        "Last name",
        "Address",
        "Apartment, suite, etc. (optional)",
        "City",
        "State / province",
        "Postal code",
        "Phone",
      ]);
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

      expect(widget.$(".sa-order-form .sa-order-title").textContent).toBe("Contact");
      expect(field("phone").getAttribute("aria-invalid")).toBe("true");
      expect(widget.$(".sa-field-error").textContent).toBe("Enter a phone number with 7 to 15 digits.");
      expect(field("phone").getAttribute("aria-describedby")).toBe(widget.$(".sa-field-error").id);
      expect(widget.$(".sa-order-status-error").textContent).toBe(
        "Please check the highlighted details.",
      );
      expect(field("lastName").value).toBe("Lovelace");
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
      expect(field("firstName").value).toBe("Test");
      expect(field("lastName").value).toBe("Buyer");
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

    describe("states and provinces", () => {
      /** The list Shopify renders for theme address forms, as the Liquid block puts it on the page. */
      const addRegions = () => {
        const select = document.createElement("select");
        select.id = "shopi-assist-regions";
        select.hidden = true;
        const add = (country: string, provinces: unknown) => {
          const option = document.createElement("option");
          option.value = country;
          option.textContent = country;
          option.setAttribute("data-provinces", JSON.stringify(provinces));
          select.appendChild(option);
        };
        add("United States", [
          ["Illinois", "Illinois"],
          ["New York", "New York"],
          ['<img src=x onerror="window.hacked=1">', "Texas"],
        ]);
        add("Canada", [
          ["Ontario", "Ontario"],
          ["Quebec", "Québec"],
        ]);
        add("Germany", []);
        document.body.appendChild(select);
      };

      it("offers the country's states as a list, as the checkout does", async () => {
        const { widget, field, fill, submit } = await openForm(
          (body) => jsonResponse({ ok: true, step: "quote", quote: quote(body.shippingRateHandle as string) }),
          {},
          addRegions,
        );

        const states = field("province") as HTMLSelectElement;
        expect(states.tagName).toBe("SELECT");
        expect(states.required).toBe(true);
        expect(Array.from(states.options).map((option) => option.textContent)).toEqual([
          "Select\u2026",
          "Illinois",
          "New York",
          "Texas",
        ]);
        // Whatever the page's list holds is shown as text, never as markup.
        expect(widget.root.querySelector(".sa-order-form img")).toBeNull();

        fill({ ...DETAILS, countryCode: "US", province: "Illinois" });
        await submit();
        expect(orderPosts()[0].address).toMatchObject({ countryCode: "US", province: "Illinois" });
      });

      it("swaps the list when the country changes and keeps what was typed", async () => {
        const { field } = await openForm(() => jsonResponse({ ok: true }), {}, addRegions);
        field("lastName").value = "Lovelace";
        (field("province") as HTMLSelectElement).value = "Illinois";

        const country = field("countryCode");
        country.value = "CA";
        country.dispatchEvent(new Event("change", { bubbles: true }));

        const states = field("province") as HTMLSelectElement;
        expect(Array.from(states.options).map((option) => option.textContent)).toEqual([
          "Select\u2026",
          "Ontario",
          "Québec",
        ]);
        // The old country's state does not carry over.
        expect(states.value).toBe("");
        expect(field("lastName").value).toBe("Lovelace");
        expect(field("countryCode").value).toBe("CA");
      });

      it("asks for the state as text when the country has no list", async () => {
        // No list on the page at all.
        const none = await openForm(() => jsonResponse({ ok: true }));
        expect(none.field("province").tagName).toBe("INPUT");
      });

      it("picks the test address's state from the list", async () => {
        const { widget, field } = await openForm(
          () => jsonResponse({ ok: true }),
          { testMode: true },
          addRegions,
        );
        widget.$<HTMLButtonElement>(".sa-order-test").click();

        expect((field("province") as HTMLSelectElement).value).toBe("Illinois");
        expect(field("zip").value).toBe("62704");
      });
    });

    it("closes from Cancel and opens only one form at a time", async () => {
      const { widget } = await openForm(() => jsonResponse({ ok: true }));

      widget.$<HTMLButtonElement>(".sa-order-here").click();
      await flush();
      expect(widget.all(".sa-order-form")).toHaveLength(1);

      const cancel = widget.all(".sa-order-form button").find((button) => button.textContent === "Cancel")!;
      cancel.click();
      expect(widget.root.querySelector(".sa-order-form")).toBeNull();
      // The summary is still there, with paying online as the quiet second way.
      expect(widget.$(".sa-order-here").textContent).toBe("Order here, pay on delivery");
      const online = widget.$<HTMLAnchorElement>(".sa-order-online");
      expect(online.getAttribute("href")).toBe("/checkout");
      expect(online.target).toBe("_blank");
      expect(widget.root.querySelector(".sa-order-checkout")).toBeNull();
    });
  });

  describe("changes to an existing order", () => {
    const cancelCard = (overrides: Record<string, unknown> = {}) => ({
      type: "order_action",
      kind: "cancel",
      order: "#1005",
      token: "signed-grant-for-1005",
      title: "Cancel order #1005?",
      lines: ["2 \u00d7 Trail Mug", '<img src=x onerror="window.hacked=1">'],
      note: "Nothing has been charged for this order. Cancelling it cannot be undone.",
      confirmLabel: "Cancel order",
      ...overrides,
    });
    const orderPosts = () =>
      orderMock.mock.calls
        .filter((call) => (call[1] as RequestInit | undefined)?.method === "POST")
        .map((call) => JSON.parse((call[1] as RequestInit).body as string));

    async function showCard(action: Record<string, unknown>) {
      fetchMock.mockImplementation(() => reply("Press the button to confirm.", { actions: [action] }));
      const widget = mountWidget();
      widget.launcher.click();
      widget.send("cancel my order 1005");
      await flush();
      const buttons = () =>
        Array.from(widget.root.querySelectorAll<HTMLButtonElement>(".sa-action button"));
      return { widget, buttons };
    }

    it("shows a card and changes nothing until the shopper presses its button", async () => {
      orderMock.mockImplementation(() =>
        jsonResponse({ ok: true, step: "cancel", order: { name: "#1005" }, message: "Order #1005 is cancelled." }),
      );
      const { widget, buttons } = await showCard(cancelCard());

      const card = widget.$(".sa-action");
      expect(card.querySelector(".sa-order-title")!.textContent).toBe("Cancel order #1005?");
      expect(Array.from(card.querySelectorAll("li")).map((line) => line.textContent)).toEqual([
        "2 \u00d7 Trail Mug",
        '<img src=x onerror="window.hacked=1">',
      ]);
      // Whatever the server sends is shown as text, never as markup.
      expect(card.querySelector("img")).toBeNull();
      expect(buttons().map((button) => button.textContent)).toEqual(["Cancel order", "Keep my order"]);
      // Showing the card asked the store for nothing.
      expect(orderPosts()).toEqual([]);

      buttons()[0].click();
      await flush();

      expect(orderPosts()).toEqual([{ step: "cancel", token: "signed-grant-for-1005" }]);
      expect(widget.root.querySelector(".sa-action")).toBeNull();
      const notice = widget.all(".sa-notice").at(-1)!;
      expect(notice.textContent).toBe("Order #1005 is cancelled.");
      expect(notice.classList.contains("sa-notice-success")).toBe(true);

      // The confirmation is kept for the next page; the grant is not.
      const stored = JSON.stringify({ ...window.localStorage });
      expect(stored).toContain("Order #1005 is cancelled.");
      expect(stored).not.toContain("signed-grant-for-1005");
    });

    it("does nothing when the shopper keeps the order", async () => {
      const { widget, buttons } = await showCard(cancelCard());
      buttons()[1].click();
      expect(widget.root.querySelector(".sa-action")).toBeNull();
      expect(orderPosts()).toEqual([]);
    });

    it("shows the store's reason when it is too late, and does not offer a second try", async () => {
      orderMock.mockImplementation(() =>
        jsonResponse({
          ok: false,
          error: {
            code: "unavailable",
            status: 409,
            message: "Order #1005 is already being prepared or has shipped, so it can no longer be cancelled or changed here.",
          },
        }),
      );
      const { widget, buttons } = await showCard(cancelCard());
      buttons()[0].click();
      await flush();

      expect(widget.$(".sa-action .sa-order-status-error").textContent).toMatch(/already being prepared/);
      expect(buttons()[0].disabled).toBe(true);
      expect(buttons()[1].disabled).toBe(false);
      expect(widget.all(".sa-notice")).toHaveLength(0);
    });

    it("ignores a card that is not well formed", async () => {
      const { widget } = await showCard(cancelCard({ kind: "refund_everything" }));
      expect(widget.root.querySelector(".sa-action")).toBeNull();
      const noToken = await showCard(cancelCard({ token: undefined }));
      expect(noToken.widget.root.querySelector(".sa-action")).toBeNull();
    });

    it("takes a new address in a form and sends it with the grant", async () => {
      orderMock.mockImplementation((_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? jsonResponse({
              ok: true,
              step: "address",
              order: { name: "#1005" },
              message: "The delivery address for order #1005 is updated.",
            })
          : jsonResponse({
              ok: true,
              countries: [
                { code: "CA", name: "Canada" },
                { code: "US", name: "United States" },
              ],
            }),
      );
      const { widget, buttons } = await showCard(
        cancelCard({
          kind: "address",
          title: "Change the delivery address for order #1005",
          lines: [],
          confirmLabel: "Enter new address",
          countryCode: "US",
        }),
      );
      buttons()[0].click();
      await flush();

      const form = widget.$<HTMLFormElement>(".sa-order-form");
      expect(form.querySelector(".sa-order-title")!.textContent).toBe("New delivery address");
      // No email, and no choice of country: the order stays where it is going.
      expect(form.querySelector('[name="email"]')).toBeNull();
      const country = form.querySelector<HTMLSelectElement>('[name="countryCode"]')!;
      expect(Array.from(country.options).map((option) => option.value)).toEqual(["US"]);
      expect(country.parentElement!.hidden).toBe(true);

      const values: Record<string, string> = {
        firstName: "Ada",
        lastName: "Lovelace",
        address1: "350 Fifth Avenue",
        city: "New York",
        province: "NY",
        zip: "10118",
        phone: "+1 202 555 0143",
      };
      for (const [name, value] of Object.entries(values)) {
        form.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value = value;
      }
      form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      await flush();

      expect(orderPosts()).toEqual([
        {
          step: "address",
          token: "signed-grant-for-1005",
          contact: { firstName: "Ada", lastName: "Lovelace", phone: "+1 202 555 0143", email: "" },
          address: {
            company: "",
            address1: "350 Fifth Avenue",
            address2: "",
            city: "New York",
            province: "NY",
            zip: "10118",
            countryCode: "US",
          },
        },
      ]);
      expect(widget.root.querySelector(".sa-order-form")).toBeNull();
      expect(widget.root.querySelector(".sa-action")).toBeNull();
      expect(widget.all(".sa-notice").at(-1)!.textContent).toBe(
        "The delivery address for order #1005 is updated.",
      );
      // The address itself is kept nowhere in the browser.
      const stored = JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage });
      expect(stored).not.toMatch(/Lovelace|Fifth Avenue|10118/);
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
    await flush();

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

  it("is stamped with the fingerprint of its current script and stylesheet", async () => {
    // The Liquid block adds this fingerprint to both asset URLs, which is what
    // makes a browser drop an older cached widget. If this fails, the assets
    // changed without the stamp: run `npm run widget:stamp`.
    const { createHash } = await import("node:crypto");
    const root = join(process.cwd(), "extensions/chat-widget");
    const hash = createHash("sha256");
    for (const file of ["assets/shopi-assist.js", "assets/shopi-assist.css"]) {
      hash.update(readFileSync(join(root, file)));
    }
    const block = readFileSync(join(root, "blocks/shopi-assist-chat.liquid"), "utf8");

    expect(block).toContain(`assign shopi_assist_build = '${hash.digest("hex").slice(0, 12)}'`);
    // Both URLs carry it.
    expect(block).toContain("shopi_assist_css | append: shopi_assist_stamp");
    expect(block).toContain("shopi_assist_js | append: shopi_assist_stamp");
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
