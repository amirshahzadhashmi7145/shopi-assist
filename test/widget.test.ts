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
/** GET requests: the widget asking the app for its settings. */
let configMock: FetchMock;

const appConfig = (overrides: Record<string, unknown> = {}) =>
  jsonResponse({ ok: true, enabled: true, ready: true, title: "", greeting: "", ...overrides });

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  fetchMock = vi.fn<FetchHandler>(() => reply("Hello!"));
  configMock = vi.fn<FetchHandler>(() => appConfig());
  window.fetch = ((url: string, init?: RequestInit) =>
    (init?.method ?? "GET") === "GET"
      ? configMock(url, init)
      : fetchMock(url, init)) as unknown as typeof window.fetch;
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

  it("shows a checkout link when the assistant offers checkout", async () => {
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
    // Only the chat message was sent: the widget itself places no order.
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
