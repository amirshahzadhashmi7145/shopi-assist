# Shopi Assist

An AI shopping assistant for Shopify stores. Installing the app adds a chat widget to the storefront; shoppers ask questions in plain language and the assistant answers from live store data using LLM tool calling (GPT-4o by default).

**Status: built and tested locally, not yet run against a real Shopify store.** See [What has and hasn't been verified](#what-has-and-hasnt-been-verified).

## What it does

**For shoppers (storefront widget)**

- "What are your best sellers?" returns the store's best-selling products as cards with image, price and an Add to cart button.
- Product search, product details and variants, collections.
- Shipping, refund, privacy and terms answers read from the store's published policies.
- "Add the small one to my cart" adds to the real storefront cart.
- Order status by order number plus checkout email (off by default; the merchant opts in).

**For the merchant (inside Shopify admin)**

- A store assistant that answers from private store data: top-selling products by units or revenue, sales summaries, recent and unfulfilled orders, low stock, catalog search including drafts.
- Setup page with a one-click link to turn the widget on, settings, and a log of shopper conversations.

The merchant assistant is **read-only**. Nothing in this version changes products, prices, inventory, orders or discounts.

## About "one-click install"

Shopify does not allow an app to switch on its own storefront widget. App embeds are off after install and the store owner has to enable them. The closest supported flow, which this app implements, is:

1. Merchant installs the app.
2. The app's home page shows a **Turn on chat widget** button. It opens the theme editor with Shopi Assist already toggled on.
3. Merchant clicks **Save**.

The older way of injecting scripts automatically (ScriptTag) is being shut off by Shopify and is not accepted for new App Store apps.

## How it works

```
Storefront page
  └─ chat widget (theme app embed, plain JS in a shadow root)
       │  POST /apps/shopi-assist/chat          same-origin, no CORS
       ▼
Shopify app proxy ── signs the request (HMAC) and forwards it
       ▼
App server  /proxy/chat
  1. verify Shopify's signature  → this is what proves which shop it is
  2. validate input, rate limit, load shop settings
  3. run the model with the tools this audience is allowed to use
       model ⇄ tools ⇄ Storefront API / Admin API
  4. store the exchange, return { reply, cards, actions }
```

| Path | What lives there |
| --- | --- |
| `extensions/chat-widget/` | The storefront widget: Liquid embed block, JS, CSS |
| `app/routes/proxy.chat.tsx` | Storefront chat endpoint (app proxy) |
| `app/routes/app.*.tsx` | Admin pages: home/setup, store assistant, conversations, settings |
| `app/routes/webhooks.*.tsx` | Uninstall, scope updates, mandatory privacy webhooks |
| `app/assistant/engine.ts` | The tool-calling loop |
| `app/assistant/tools/shopper.ts` | Tools available to storefront visitors |
| `app/assistant/tools/merchant.ts` | Tools available only inside the admin |
| `app/assistant/llm/` | Provider interface, OpenAI adapter, offline mock |
| `app/assistant/chat.server.ts` | One chat turn end to end: validation, limits, storage |
| `prisma/schema.prisma` | Sessions, per-shop settings, conversations, messages |

### Security model

- **Two audiences, decided by the server.** A request through the app proxy is always a `shopper`; a request through the authenticated admin is always a `merchant`. Each tool declares which audience may use it, and a tool call for the wrong audience is refused. Nothing the browser sends can change the audience or the shop.
- **Shoppers only see public data.** Catalog tools use the Storefront API, which returns published products only. Sales figures, inventory counts and other customers' data are not reachable from the widget.
- **Order lookup** is opt-in, needs both order number and checkout email to match exactly, returns only status and tracking, gives the same answer for "wrong email" and "no such order", and is throttled.
- **Tenant isolation.** Every database query filters by the authenticated shop. A conversation id from one shop (or one visitor) cannot be continued or read by another.
- **No HTML from the model.** The widget renders replies with DOM text nodes and a tiny Markdown subset; only `http(s)` and same-site links become links.
- **Abuse limits.** Per-IP and per-shop rate limits, message length cap, bounded tool steps and output tokens.
- **Secrets** stay on the server in environment variables. Message text is never written to logs.

## Getting started

Requirements: Node 22.12+, a [Shopify Partner account](https://partners.shopify.com/signup), a [development store](https://help.shopify.com/en/partners/dashboard/development-stores#create-a-development-store), and an OpenAI API key (or use mock mode first).

```bash
npm install
cp .env.example .env        # add OPENAI_API_KEY, or set LLM_PROVIDER=mock
npm run dev                 # logs in to Shopify, creates/links the app, starts a tunnel
```

`npm run dev` prints a preview link. Open it, install the app on your dev store, then:

1. On the app's home page click **Turn on chat widget**, then **Save** in the theme editor.
2. Open the storefront. The chat bubble is in the corner.
3. Ask "What are your best sellers?"

Dev stores are password protected; unlock the storefront in the same browser first.

### Testing without a store

```bash
npm test                    # 96 unit and integration tests
npm run widget:preview      # the real widget on a fake storefront, canned replies → http://localhost:4010
npm run build && npm run smoke   # real HTTP requests, signed like Shopify's proxy, against the built server
npm run graphql-codegen     # validates every GraphQL query against Shopify's Admin and Storefront schemas
```

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_PROVIDER` | `openai` | `openai` or `mock` |
| `OPENAI_API_KEY` | none | Required for `openai` |
| `OPENAI_MODEL` | `gpt-4o` | Any chat-completions model with tool calling |
| `OPENAI_BASE_URL` | none | Use an OpenAI-compatible endpoint |
| `OPENAI_MAX_OUTPUT_TOKENS` | `1200` | Cap per model reply |
| `CHAT_LIMIT_PER_IP_PER_MINUTE` | `12` | Storefront rate limit per visitor address |
| `CHAT_LIMIT_PER_SHOP_PER_HOUR` | `600` | Storefront ceiling per shop (bounds LLM spend) |
| `CHAT_LIMIT_MERCHANT_PER_MINUTE` | `30` | Admin assistant limit per shop |

Widget appearance (title, welcome message, accent color, position, suggested questions) is set by the merchant in the theme editor. Behaviour (pause chat, extra guidance for the assistant, order lookup, transcript retention) is set on the app's Settings page.

To use a different model provider, implement the `LlmProvider` interface in `app/assistant/llm/provider.ts` and select it in `app/assistant/llm/index.server.ts`.

### Access scopes

| Scope | Used for |
| --- | --- |
| `unauthenticated_read_product_listings` | Storefront catalog: search, best sellers, product details |
| `read_products` | Merchant assistant: catalog search, low stock |
| `read_orders` | Merchant assistant: recent orders. Shopper order-status lookup (opt-in) |
| `read_reports` | Merchant assistant: sales analytics through ShopifyQL |
| `write_app_proxy` | Registering the `/apps/shopi-assist` storefront proxy |

`read_orders` and `read_reports` involve **protected customer data**. On a development store you can use them after selecting the data in your app's Dev Dashboard (Settings → Access requests); for a public app Shopify must approve the request. If analytics access is missing, the merchant assistant falls back to totalling recent orders and says the figures are approximate.

## What has and hasn't been verified

Verified locally:

- 96 automated tests: tool-calling loop, audience boundary, each tool against fake API responses, shop and visitor isolation on a real SQLite database, rate limits, retention and redaction, the proxy route, the OpenAI adapter's request format, and the widget in a simulated browser (rendering, XSS safety, cart, errors, persistence).
- All 15 GraphQL queries validate against Shopify's published 2026-10 Admin and Storefront schemas.
- The built server accepts correctly signed proxy requests and rejects unsigned, forged, tampered and replayed ones (`npm run smoke`).
- `shopify theme check` and `shopify app security check` report no findings.
- The widget was rendered in headless Chrome at desktop and mobile sizes.

Not yet verified, because it needs your Shopify login, a dev store and an API key:

- Install and OAuth on a real store, and the app proxy registration.
- The theme editor deep link and the widget-status check on the home page.
- Real answers from GPT-4o, including how well it picks tools.
- Storefront API results on a real catalog. In particular, confirm that best sellers and search return your Online Store products; if they come back empty, the products may need to be made available to the app's channel.
- ShopifyQL responses on a real store (row format and access).
- The admin pages inside the real Shopify admin.

## Before going live

- **Data handling.** Shopper messages and the store data needed to answer them are sent to the LLM provider. Transcripts are stored in the app database for the retention period. Cover both in your privacy policy and get whatever approvals your organisation requires before connecting real customer data.
- **Database.** SQLite is for development. Use a hosted database in production and change `datasource` in `prisma/schema.prisma`.
- **Rate limits** are held in memory per process. Move them to a shared store before running more than one instance.
- **Customer data requests.** The `customers/data_request` webhook is acknowledged and logged but the export is manual.
- **Protected customer data** approval is needed for orders and analytics on live stores.
- **Hosting.** `shopify app deploy` publishes configuration and the widget extension; the app server needs its own host.

## Not built yet

- Merchant write actions (create discounts, edit products, adjust inventory). The tool registry is designed for them, but each should run only after the merchant confirms it in the UI.
- Streaming replies.
- Billing.
- Translations of the widget's own labels.

## Credits

Scaffolded from Shopify's React Router app template. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
