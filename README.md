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
- **Order lookup** is opt-in, needs both order number and checkout email to match exactly, returns only status and tracking, and gives the same answer for "wrong email" and "no such order". Guessing is throttled four ways: per chat turn, per visitor address, per email address and per shop.
- **No Admin API for shoppers.** A shopper's chat turn is not handed an Admin API client at all unless the merchant has turned order lookup on.
- **Tenant isolation.** Every database query filters by the authenticated shop. A conversation id from one shop (or one visitor) cannot be continued or read by another.
- **No HTML from the model.** The widget renders replies with DOM text nodes and a tiny Markdown subset; only `http(s)` and same-site links become links.
- **Abuse and spend limits.** Per-address limits (per minute and per hour, IPv6 grouped by /64), per-shop limits (per hour and per day), a daily token ceiling across all shops, a 50-second deadline per turn, a message length cap, and bounded tool steps and output tokens. A blocked address does not use up the shop's shared budget.
- **Widget-only endpoint.** The chat endpoint accepts only JSON requests from the same origin, so another website cannot make visitors' browsers post to it.
- **Privacy.** Email addresses are masked before a transcript is stored. Transcripts are deleted after the shop's retention period by an hourly job. Links in stored shopper transcripts are shown as plain text in the admin.
- **Secrets** stay on the server in environment variables. Message text and provider error messages are never written to logs.

## Getting started

Requirements: Node 22.12+, a [Shopify Partner account](https://partners.shopify.com/signup), a [development store](https://help.shopify.com/en/partners/dashboard/development-stores#create-a-development-store), and an OpenAI API key (or use mock mode first).

```bash
npm install
cp .env.example .env        # add OPENAI_API_KEY, or set LLM_PROVIDER=mock
npm run dev                 # logs in to Shopify, creates/links the app, starts a tunnel
```

`npm run dev` asks you to log in, name the app, and pick or create a dev store. It also asks for the dev store's **storefront password** (Shopify admin → Online Store → Preferences), which is not your account password. Then:

1. Press `p` in the terminal to open the app and install it.
2. Turn the widget on **in the host theme**. While developing, the CLI serves the widget only to a separate development theme it uploads, named "App Ext. Host (...)". Open Online Store → Themes, click **Customize** on that theme, go to **App embeds**, switch on **Shopi Assist chat** and **Save**.
3. Open the local preview the CLI prints, `http://127.0.0.1:9293`, in Chrome. The chat bubble is in the corner. Ask "What are your best sellers?"

During development the widget does **not** appear at the store's own address (`your-store.myshopify.com`). That address shows the published theme, which only gets the widget after `npm run deploy` releases a version of the app. The **Turn on chat widget** button on the app's home page targets the published theme, so it is the right button for merchants on a released app but not for this dev preview.

If linking to a new app blanks the `scopes` line in `shopify.app.toml`, restore it from git and restart `npm run dev`; the app proxy needs `write_app_proxy`.

### Testing without a store

```bash
npm test                    # 114 unit and integration tests
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
| `CHAT_LIMIT_PER_IP_PER_MINUTE` | `12` | Storefront burst limit per visitor address |
| `CHAT_LIMIT_PER_IP_PER_HOUR` | `60` | Storefront hourly limit per visitor address |
| `CHAT_LIMIT_PER_SHOP_PER_HOUR` | `600` | Storefront ceiling per shop, all visitors together |
| `CHAT_LIMIT_PER_SHOP_PER_DAY` | `3000` | Storefront daily ceiling per shop |
| `CHAT_LIMIT_MERCHANT_PER_MINUTE` | `30` | Admin assistant limit per shop |
| `LLM_DAILY_TOKEN_BUDGET` | `2000000` | Token ceiling per UTC day across **all** shops. Chat stops when it is reached. Size it to your budget |

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

- 114 automated tests: tool-calling loop, audience boundary, each tool against fake API responses, shop and visitor isolation on a real SQLite database, rate and spend limits, order-lookup throttles, retention and redaction, the proxy route, the OpenAI adapter's request format, and the widget in a simulated browser (rendering, XSS safety, cart, errors, persistence).
- All 15 GraphQL queries validate against Shopify's published 2026-10 Admin and Storefront schemas.
- The built server accepts correctly signed proxy requests and rejects unsigned, forged, tampered and stale ones (`npm run smoke`). Shopify's signature covers the query string and a timestamp with a 90-second window; it does not stop the same request being re-sent inside that window, which is one reason the limits above exist.
- An independent security review of the code; its findings are fixed or listed below.
- `shopify theme check` and `shopify app security check` report no findings.
- The widget was rendered in headless Chrome at desktop and mobile sizes.

Not yet verified, because it needs your Shopify login, a dev store and an API key:

- Install and OAuth on a real store, and the app proxy registration.
- The theme editor deep link and the widget-status check on the home page.
- Real answers from GPT-4o, including how well it picks tools.
- Storefront API results on a real catalog. In particular, confirm that best sellers and search return your Online Store products; if they come back empty, the products may need to be made available to the app's channel.
- ShopifyQL responses on a real store (row format and access).
- The admin pages inside the real Shopify admin.
- **Which visitor address Shopify's proxy reports.** The per-address limits use the first `X-Forwarded-For` value. Shopify's docs say the proxy sets it to the client address but not whether a value sent by the visitor is replaced. On the dev store, request the proxy URL with `curl -H "X-Forwarded-For: 1.2.3.4"` and check the app log. If the visitor's value survives, the per-address limits can be dodged and the address must be read from a different position. The per-email, per-shop and token limits do not depend on it.

## Before going live

- **Data handling.** Shopper messages and the store data needed to answer them are sent to the LLM provider. Transcripts are stored in the app database for the retention period. Cover both in your privacy policy and get whatever approvals your organisation requires before connecting real customer data.
- **Database.** SQLite is for development. Use a hosted database in production and change `datasource` in `prisma/schema.prisma`.
- **Limits are held in memory per process.** Rate limits and the daily token budget reset on restart and are per instance. Move them to a shared store before running more than one instance, and set a hard spending limit in your LLM provider's dashboard as the real backstop.
- **App Store listing.** The landing page (`app/routes/_index`) and `auth.login` include the template's "enter your shop domain" form. The App Store does not allow asking for a myshopify.com URL, so remove both forms before submitting.
- **Access tokens** are stored unencrypted in the database, as in Shopify's template. Use a database with encryption at rest.
- **Shared devices.** The widget keeps the conversation in the browser's local storage for up to a day so it survives page changes.
- **Customer data requests.** The `customers/data_request` webhook logs the shop, customer id and number of linked transcripts; the export itself is manual. Guest conversations are not linked to a customer, which is why email addresses are masked rather than stored.
- **Protected customer data** approval is needed for orders and analytics on live stores.
- **Hosting.** `shopify app deploy` publishes configuration and the widget extension; the app server needs its own host.

## Not built yet

- Merchant write actions (create discounts, edit products, adjust inventory). The tool registry is designed for them, but each should run only after the merchant confirms it in the UI.
- Streaming replies.
- Billing.
- Translations of the widget's own labels.

## Credits

Scaffolded from Shopify's React Router app template. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
