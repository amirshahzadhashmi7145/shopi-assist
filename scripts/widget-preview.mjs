/**
 * Widget preview: a fake storefront page that loads the real widget assets
 * and answers with canned replies. For working on the widget's look and
 * behaviour without a dev store, an app server or an LLM key.
 *
 *   npm run widget:preview     then open http://localhost:4010
 *
 * Query options:  ?accent=%23B4532A  ?position=left  ?demo=1 (opens the chat
 * and asks a question automatically; used for screenshots).
 *
 * Nothing here ships to Shopify; only extensions/chat-widget is deployed.
 */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.PREVIEW_PORT || 4010);
const ASSETS_DIR = join(process.cwd(), "extensions/chat-widget/assets");
const TYPES = { ".js": "text/javascript", ".css": "text/css" };

const PRODUCTS = [
  { title: "Trail Enamel Mug", handle: "trail-enamel-mug", price: "18.0", compareAt: null, variantId: "101", hue: 150 },
  { title: "Ridgeline Camp Kettle", handle: "ridgeline-camp-kettle", price: "42.0", compareAt: "52.0", variantId: null, hue: 28 },
  { title: "Wool Camp Blanket", handle: "wool-camp-blanket", price: "89.0", compareAt: null, variantId: "103", hue: 215 },
];

const card = (product) => ({
  id: `gid://shopify/Product/${product.handle}`,
  title: product.title,
  handle: product.handle,
  url: `/products/${product.handle}`,
  imageUrl: `/img/${product.handle}.svg`,
  imageAlt: product.title,
  price: { amount: product.price, currencyCode: "USD" },
  compareAtPrice: product.compareAt ? { amount: product.compareAt, currencyCode: "USD" } : null,
  available: true,
  variantId: product.variantId,
});

function cannedReply(message) {
  if (/best|top|popular|sell/i.test(message)) {
    return {
      reply: `Here are our three best sellers right now:\n\n- **${PRODUCTS[0].title}**, a customer favourite for camping\n- **${PRODUCTS[1].title}**, on sale this week\n- **${PRODUCTS[2].title}**\n\nWant details on any of them?`,
      cards: PRODUCTS.map(card),
    };
  }
  if (/return|refund|policy/i.test(message)) {
    return {
      reply: "You can return unused items within **30 days** of delivery for a full refund. Return shipping is free for orders over $50. The full details are in our [refund policy](/policies/refund-policy).",
      cards: [],
    };
  }
  if (/order|buy/i.test(message)) {
    return {
      reply: `Here's your order: 2 of the **${PRODUCTS[0].title}** and the **${PRODUCTS[2].title}**. Check the summary below and go to checkout when you're ready.`,
      cards: [],
      actions: [
        {
          type: "order",
          items: [
            { variantId: "101", quantity: 2, title: PRODUCTS[0].title },
            { variantId: "103", quantity: 1, title: PRODUCTS[2].title },
          ],
        },
      ],
    };
  }
  if (/checkout|pay/i.test(message)) {
    return { reply: "Here's what is in your cart.", cards: [], actions: [{ type: "checkout" }] };
  }
  if (/add/i.test(message)) {
    return {
      reply: `Done, I've added the **${PRODUCTS[0].title}** to your cart.`,
      cards: [],
      actions: [{ type: "add_to_cart", variantId: "101", quantity: 1 }],
    };
  }
  if (/error/i.test(message)) return null;
  return {
    reply: "This is the preview server, so answers are canned. Try asking for best sellers, the return policy, to add something to the cart, or to place an order.",
    cards: [],
  };
}

/** A stand-in for the storefront cart, shaped like Shopify's /cart.js. */
const cartLines = new Map();

function cartJson() {
  const items = [...cartLines].map(([variantId, quantity]) => {
    const product = PRODUCTS.find((candidate) => candidate.variantId === variantId);
    const price = Math.round(Number(product.price) * 100);
    return {
      variant_id: Number(variantId),
      key: `${variantId}:preview`,
      quantity,
      title: product.title,
      price,
      final_line_price: price * quantity,
    };
  });
  const total = items.reduce((sum, item) => sum + item.final_line_price, 0);
  return {
    currency: "USD",
    item_count: items.reduce((sum, item) => sum + item.quantity, 0),
    items,
    items_subtotal_price: total,
    total_price: total,
  };
}

const productImage = (hue) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" fill="hsl(${hue} 30% 88%)"/><circle cx="64" cy="64" r="34" fill="hsl(${hue} 35% 55%)"/><rect x="40" y="72" width="48" height="26" rx="6" fill="hsl(${hue} 40% 35%)"/></svg>`;

/**
 * The colour and corner asked for in a page's address. The widget is told
 * them the way the app tells it, with the rest of its settings, so they are
 * read off the address of the page that asks for those.
 */
function look(address) {
  let params = new URLSearchParams();
  try {
    params = new URL(address || "", "http://localhost").searchParams;
  } catch {
    // Not an address: the defaults.
  }
  return {
    accent: /^#[0-9a-f]{6}$/i.test(params.get("accent") || "") ? params.get("accent") : "#1F3D2F",
    position: params.get("position") === "left" ? "left" : "right",
  };
}

function page(url) {
  const demo = url.searchParams.get("demo");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Widget preview</title>
<style>
  body { margin: 0; font-family: Georgia, "Times New Roman", serif; color: #23201c; background: #faf7f2; }
  /* Shopify's Dawn theme ships this rule. It once hid the whole widget, so the preview keeps it. */
  div:empty { display: none; }
  header { padding: 18px 32px; border-bottom: 1px solid #e6dfd3; display: flex; justify-content: space-between; align-items: center; }
  header strong { font-size: 22px; letter-spacing: 0.04em; }
  nav { font: 14px/1 system-ui, sans-serif; color: #6b655c; display: flex; gap: 22px; }
  main { max-width: 980px; margin: 0 auto; padding: 40px 32px 120px; }
  h1 { font-size: clamp(30px, 5vw, 46px); font-weight: 400; margin: 0 0 12px; }
  p.lede { font: 17px/1.5 system-ui, sans-serif; color: #6b655c; max-width: 52ch; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 20px; margin-top: 36px; }
  .tile { background: #fff; border: 1px solid #e6dfd3; border-radius: 6px; overflow: hidden; font: 14px/1.4 system-ui, sans-serif; }
  .tile img { display: block; width: 100%; aspect-ratio: 1; }
  .tile div { padding: 12px 14px; }
  .note { margin-top: 40px; font: 13px/1.5 system-ui, sans-serif; color: #8a8378; }
</style>
</head>
<body>
<header><strong>ALPINE OUTFITTERS</strong><nav><span>Shop</span><span>About</span><span>Cart</span></nav></header>
<main>
  <h1>Gear for slow mornings outdoors</h1>
  <p class="lede">A stand-in storefront for previewing the Shopi Assist chat widget. The chat bubble in the corner is the real widget code; its answers come from a canned preview server.</p>
  <div class="grid">
    ${PRODUCTS.map((product) => `<div class="tile"><img src="/img/${product.handle}.svg" alt=""><div>${product.title}<br>$${Number(product.price).toFixed(2)}</div></div>`).join("")}
  </div>
  <p class="note">Preview only. Try: "What are your best sellers?", "What's your return policy?", "Add the mug to my cart", "I want to order two mugs and a blanket", "Checkout", or "error" to see the failure state.</p>
</main>

<div
  id="shopi-assist-root"
  data-endpoint="/apps/shopi-assist/chat"
  data-stylesheet="/assets/shopi-assist.css"
  data-suggestion-1="What are your best sellers?"
  data-suggestion-2="What's your return policy?"
  data-suggestion-3="Help me find a gift"
  data-country="US"
  data-locale="en"
  data-cart-url="/cart"
  data-cart-add-url="/cart/add"
></div>
<select id="shopi-assist-regions" hidden>
  <option value="Canada" data-provinces='[["Alberta","Alberta"],["British Columbia","British Columbia"],["Ontario","Ontario"],["Quebec","Quebec"]]'>Canada</option>
  <option value="United States" data-provinces='[["California","California"],["Illinois","Illinois"],["New York","New York"],["Texas","Texas"]]'>United States</option>
</select>
<script src="/assets/shopi-assist.js" defer></script>
${
  demo
    ? `<script>
  window.addEventListener("load", function () {
    try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}
    setTimeout(function () {
      var root = document.getElementById("shopi-assist-root").shadowRoot;
      root.querySelector(".sa-launcher").click();
      ${
        demo === "open"
          ? ""
          : `var input = root.querySelector(".sa-input");
      input.value = ${JSON.stringify(demo === "1" ? "What are your best sellers?" : demo)};
      root.querySelector(".sa-form").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));`
      }
    }, 300);
  });
</script>`
    : ""
}
</body>
</html>`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${PORT}`);
  const send = (status, type, body) => {
    response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
    response.end(body);
  };

  try {
    if (request.method === "POST" && url.pathname === "/apps/shopi-assist/chat") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw || "{}");
      await new Promise((resolve) => setTimeout(resolve, 600)); // show the typing state
      const canned = cannedReply(String(body.message || ""));
      if (!canned) {
        return send(502, "application/json", JSON.stringify({
          error: { code: "assistant_failed", message: "Sorry, I'm having trouble answering right now. Please try again in a moment." },
        }));
      }
      return send(200, "application/json", JSON.stringify({
        conversationId: body.conversationId || "previewconv0001",
        actions: [],
        ...canned,
      }));
    }

    if (request.method === "GET" && url.pathname === "/apps/shopi-assist/chat") {
      return send(200, "application/json", JSON.stringify({
        ok: true, enabled: true, ready: true, title: "", greeting: "", testMode: true,
        ...look(request.headers.referer),
      }));
    }

    if (url.pathname === "/apps/shopi-assist/order") {
      if (request.method === "GET") {
        return send(200, "application/json", JSON.stringify({
          ok: true,
          countries: [{ code: "CA", name: "Canada" }, { code: "US", name: "United States" }],
        }));
      }
      // The preview has no checkout to open and no orders to change.
      return send(200, "application/json", JSON.stringify({
        ok: false,
        error: { code: "unavailable", status: 409, message: "This is a preview: on a store, this opens the checkout." },
      }));
    }

    if (request.method === "POST" && url.pathname === "/cart/change.js") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const change = JSON.parse(raw || "{}");
      const variantId = String(change.id).split(":")[0];
      if (Number(change.quantity) > 0) cartLines.set(variantId, Number(change.quantity));
      else cartLines.delete(variantId);
      return send(200, "application/json", JSON.stringify(cartJson()));
    }

    if (request.method === "POST" && url.pathname === "/cart/clear.js") {
      cartLines.clear();
      return send(200, "application/json", JSON.stringify(cartJson()));
    }

    if (request.method === "POST" && url.pathname === "/cart/add.js") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      for (const item of JSON.parse(raw || "{}").items ?? []) {
        const variantId = String(item.id);
        if (!PRODUCTS.some((product) => product.variantId === variantId)) {
          return send(422, "application/json", JSON.stringify({
            status: 422, message: "Cart Error", description: "Cannot find variant",
          }));
        }
        cartLines.set(variantId, (cartLines.get(variantId) ?? 0) + Number(item.quantity || 1));
      }
      return send(200, "application/json", JSON.stringify({ items: cartJson().items }));
    }

    if (request.method === "GET" && url.pathname === "/cart.js") {
      return send(200, "application/json", JSON.stringify(cartJson()));
    }

    if (url.pathname.startsWith("/assets/")) {
      const file = normalize(join(ASSETS_DIR, url.pathname.slice("/assets/".length)));
      if (!file.startsWith(ASSETS_DIR)) return send(403, "text/plain", "Forbidden");
      return send(200, TYPES[extname(file)] || "application/octet-stream", await readFile(file));
    }

    if (url.pathname.startsWith("/img/")) {
      const handle = url.pathname.slice("/img/".length).replace(/\.svg$/, "");
      const product = PRODUCTS.find((candidate) => candidate.handle === handle);
      return send(200, "image/svg+xml", productImage(product ? product.hue : 0));
    }

    if (url.pathname === "/") return send(200, "text/html; charset=utf-8", page(url));
    return send(404, "text/plain", "Not found (this is only a preview server)");
  } catch (error) {
    return send(500, "text/plain", error instanceof Error ? error.message : "error");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Widget preview on http://localhost:${PORT}  (Ctrl+C to stop)`);
});
