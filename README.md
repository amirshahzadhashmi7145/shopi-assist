# Shopi Assist

An AI shopping assistant for Shopify stores. Installing the app adds a chat widget to the storefront; shoppers ask questions in plain language and the assistant answers from live store data using LLM tool calling (GPT-4o by default).

**Status: working on a development store with the mock model; not yet tested with a real LLM or released.** See [What has and hasn't been verified](#what-has-and-hasnt-been-verified).

## What it does

**For shoppers (storefront widget)**

- "What are your best sellers?" returns the store's best-selling products as cards with image, price and an Add to cart button.
- Product search, product details and variants, collections.
- "What's your cheapest snowboard?" or "most expensive" is answered by asking Shopify for in-stock products sorted by price, not by comparing whatever the assistant happened to look up.
- Shipping, refund, privacy and terms answers read from the store's published policies.
- "Add the small one to my cart" adds to the real storefront cart.
- "I want to order two mugs and the blanket" puts those items in the cart and shows an order summary in the chat: each line, the subtotal and a Go to checkout button. Items already in the cart are topped up to the quantity asked for, so repeating an order never doubles it.
- "I want to buy it" or "checkout" shows the same summary for what is already in the cart, or says the cart is empty.
- The assistant knows what is in the cart. It answers "what's in my cart?", says when an order will include items that were already there, takes an item out ("remove the blanket"), empties the cart ("clear the cart") and orders only what was named ("only the mug"). Each summary line also has a Remove button.
- Normally, delivery details and payment happen on the store's Shopify checkout. The assistant never asks for an address or card in the chat messages.
- **The order form asks for what Shopify's checkout asks for**, in the same order: email, country, first and last name, address, city, state, ZIP and phone. Where Shopify knows a country's states, the state is a list to pick from, as in the checkout. The lists come from the data Shopify gives themes for address forms; the theme editor has a switch for it.
- **Chat ratings** (on by default). Once the assistant has answered, a thumbs-up and a thumbs-down sit under the chat. The shopper's rating is kept with the conversation, can be changed or taken back, and shows on the merchant's Conversations page with the totals.
- **Pay-on-delivery orders in the chat** (off by default). The order summary gets an "Order here, pay on delivery" button. The shopper fills in a form laid out like the checkout (contact, delivery address), sees delivery options, tax and the total, and presses Complete order. The order appears in the Shopify admin as unpaid, tagged `shopi-assist`, and the chat shows the order number.
  - The form follows the delivery country: which address fields there are, their order and names ("State" and "ZIP code" in the United States, "Postcode" and no county in the United Kingdom, no postal code in the Emirates), whether a postal code is needed and what one looks like. These rules come from the address data Shopify publishes and builds its checkout on (`app/assistant/address-rules.json`; rebuild it with `node scripts/build-address-rules.mjs <path to a Shopify/worldwide checkout>`). The server checks every order against them.
  - Three choices are the store's: whether a first name is required, and whether a company name and a second address line are asked for. Shopify has the same options under Settings > Checkout but does not let apps read them, so the merchant sets them in this app's settings. The defaults are Shopify's.
  - The order summary has a tick box per line on every store. What was just picked is ticked; older cart items wait underneath. "Go to checkout" (and "Pay online at checkout") with everything ticked is a plain link to the checkout. With some lines unticked, the app makes a cart of its own for the ticked lines through the Storefront API and sends the shopper to that cart's checkout, because Shopify's checkout always takes a whole cart. The storefront cart is left as it is, the way Shopify's own "Buy it now" button leaves it.
  - Payment: the in-chat order is always paid on delivery, because an app cannot take a card payment outside Shopify's checkout. Shopify does not tell apps which manual payment methods a store has set up, so the merchant gives the method's name (Shopify's "Cash on Delivery (COD)" by default) and optional instructions in this app's settings. The cards and wallets the store's checkout accepts are read from Shopify and shown with the link to pay online there.
  - Not checked the way the checkout does: whether a postal code belongs to the chosen state, and the phone number's format for the country (7 to 15 digits is all that is asked).
- Order status by order number plus proof that the order is theirs: the checkout email, or the phone number on the order for shoppers who gave no email (off by default; the merchant opts in).
- Optionally, basic order status from the order number alone (a second opt-in): order date, payment status and delivery status, without the tracking number or link.
- **Changes to an order that has not started shipping** (each off by default). The shopper proves the order is theirs, the assistant shows a card, and the change happens only when they press its button:
  - *Cancel.* An order nothing has been paid for is cancelled and restocked. A paid order is not cancelled or refunded by the assistant; it is tagged `cancellation-requested` with the reason, for the merchant to handle.
  - *New delivery address.* Typed into a form, within the same country.
  - *Different items.* Add, remove or change quantities, only while nothing has been paid for the order.
- **Signed-in customers are recognised** (off by default). A shopper signed in to their store account can ask about their own recent orders, and change them, without giving an order number or email.
- The chat remembers its own orders. An order placed through the chat's order form, or one the shopper has already proved is theirs, can be asked about again ("give me my order details", "where is it?") without giving the email a second time. This matters for pay-on-delivery orders, where the shopper may never have given an email.
- Return requests by order number, checkout email and a reason (off by default). This creates a return request in the Shopify admin that the merchant approves or declines. Nothing is refunded automatically.

**For the merchant (inside Shopify admin)**

- A **setup tour** that opens the first time the app is opened after install. It is built around ticking boxes and picking from lists, not writing:
  1. *What it can do:* add to cart, place an order, pay-on-delivery orders in the chat, order status, return requests. Ordering in chat needs both "add to cart" and "place an order" ticked; with only "place an order", the assistant shows the summary of the existing cart.
  2. *Your policies:* return window, who pays return shipping, how fast orders ship, delivery time, where you ship.
  3. *Name and tone.*
  4. *Go live.*

  Every step is optional and saves on its own. Longer free-text answers (a business description, common questions, extra guidance) are available in Settings for merchants who want them.
- **Try it as a shopper** on the last step: a test chat in the admin that behaves exactly like the storefront widget, so answers can be checked before going live. Test chats stay out of the conversation log.

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
| `app/routes/app.*.tsx` | Admin pages: home, setup tour, store assistant, conversations, settings |
| `app/routes/app.preview.tsx` | "Try it as a shopper" chat for staff |
| `app/components/AssistantFields.tsx` | The setup form fields, shared by the tour and Settings |
| `app/routes/webhooks.*.tsx` | Uninstall, scope updates, mandatory privacy webhooks |
| `app/assistant/engine.ts` | The tool-calling loop |
| `app/assistant/tools/shopper.ts` | Tools available to storefront visitors |
| `app/assistant/tools/merchant.ts` | Tools available only inside the admin |
| `app/assistant/llm/` | Provider interface, OpenAI adapter, offline mock |
| `app/assistant/chat.server.ts` | One chat turn end to end: validation, limits, storage |
| `prisma/schema.prisma` | Sessions, per-shop settings, conversations, messages |

### Security model

- **Two audiences, decided by the server.** A request through the app proxy is always a `shopper`; a request through the authenticated admin is always a `merchant`. Each tool declares which audience may use it, and a tool call for the wrong audience is refused. Nothing the browser sends can change the audience or the shop.
- **Shoppers only see public data.** Catalog tools use the Storefront API, which returns only products the store has published. Sales figures, inventory counts and other customers' data are not reachable from the widget.
- **Ordering in chat changes only the shopper's own cart**, in their own browser, through the storefront's cart endpoints. The server checks that each item is a published, in-stock variant and returns its id; it creates no order, draft order or checkout. No address, phone number or payment detail passes through the chat.
- **The cart the assistant sees is the browser's word, used as information only.** The widget sends the cart's titles, quantities and variant ids with each message. That comes from the request body, so it is validated, capped, stripped of anything that could break out of its block in the prompt, and never used to price, order or authorise anything; changes to the cart still happen in the shopper's own browser.
- **Pay-on-delivery orders are the one place an anonymous visitor makes the app create an order**, so they are opt-in and kept away from the model. The form posts straight to its own signed endpoint (`/proxy/order`); it is not a tool the LLM can call, so a prompt injection cannot place an order, and names, phone numbers and addresses never reach the LLM provider, the stored transcript, the logs or the browser's storage. Prices come from Shopify, never from the browser. Items are first checked against the Storefront API, so unpublished products cannot be ordered. The shopper must confirm the exact total; if it changed, nothing is placed. Orders are limited per visitor address, per phone number and per shop, a retried request returns the same order instead of a second one, and an order is never completed without "due on fulfillment" payment terms (without them Shopify would record it as paid).
- **Return requests** are opt-in and use the same proof and throttles as order lookup, plus one request per order per day. They are the only thing a shopper's chat can write to the store, and what they write is a request awaiting the merchant's decision. The assistant never guesses which item to return.
- **Order changes are proposed by the model and carried out by the shopper.** A cancel, address change or item change is three separate steps. A tool checks proof and that the order has not started shipping, and returns a *grant*: a note naming one order and one change, signed with the app's secret and good for 15 minutes. The widget shows a card. Only when the shopper presses its button does the grant go to `/proxy/order`, which checks the signature, reads the order from Shopify again, and acts. So the model cannot change an order by itself, the browser cannot swap in another order or another change, and an order that started shipping in the meantime is refused. `blocker()` in `order-actions.server.ts` is the one place that decides "too late": anything other than unfulfilled, with no fulfilment begun, is too late.
- **An order number alone never changes anything.** Number-only lookups, where a store allows them, are for the basic status. Every change needs proof (email or phone on the order), an order the server tied to the chat, or a signed-in customer's own order.
- **No money moves.** Cancelling and re-pricing happen only while nothing has been paid or authorised. For a paid order the assistant records a request and the merchant decides on the cancellation and the refund.
- **A signed-in customer is whoever Shopify says they are.** The customer id comes from the app proxy's signed query string, never from the request body, and is used to list that customer's own recent orders.
- **Orders a chat already knows.** When the server places an order from a chat, or the shopper proves an order with its number and email, the server records that order against the conversation (order id and number only). Later questions in that same conversation are answered with the order number alone, matched on the recorded id. The record is written by the server, never taken from the browser; a conversation is only reachable with its own random visitor id; and it is deleted with the conversation. What the assistant is told about a placed order is its number, items, delivery option and total, never the name, phone number or address.
- **Order lookup** is opt-in. The shopper gives the order number and one proof, the checkout email or the phone number on the order, and both must match exactly (a phone number may be written with or without its country code, but needs at least seven matching digits). It returns only status and tracking, and gives the same answer for "wrong proof" and "no such order". Guessing is throttled four ways: per chat turn, per visitor address, per email or phone, and per shop. Phone numbers are read from Shopify only when a shopper offers one as proof, and are never sent to the model or echoed back.
- **Order status from the number alone is a separate opt-in, and deliberately weaker.** Order numbers are sequential, so with this on anyone can see the order date, payment status and delivery status of any order. The tracking number and link, which lead to where a parcel is going, are still only given with proof, and an order looked up this way is not treated as the shopper's afterwards. The per-address and per-shop throttles slow down walking through order numbers; they do not stop it. Leave it off unless that trade is acceptable.
- **No Admin API for shoppers.** A shopper's chat turn is not handed an Admin API client at all unless the merchant has turned order lookup or return requests on.
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

`npm run dev` opens the tunnel itself and keeps it alive (`scripts/dev.mjs`): it retries until Cloudflare has connected one, hands it to `shopify app dev`, and when the tunnel later stops answering (the laptop slept, the network changed) it opens a new one and restarts the dev server on it. Left to itself, the CLI's own tunnel can die while the dev server looks healthy, and the storefront chat then answers "something went wrong". `npm run dev:tunnel-check` tests whether a tunnel can be opened from your network; `npm run dev:plain` is `shopify app dev` on its own. None of this applies to a deployed app, which has a fixed address.

`npm run dev` asks you to log in, name the app, and pick or create a dev store. It also asks for the dev store's **storefront password** (Shopify admin → Online Store → Preferences), which is not your account password. Then:

1. Press `p` in the terminal to open the app and install it.
2. Turn the widget on **in the host theme**. While developing, the CLI serves the widget only to a separate development theme it uploads, named "App Ext. Host (...)". Open Online Store → Themes, click **Customize** on that theme, go to **App embeds**, switch on **Shopi Assist chat** and **Save**.
3. Open the local preview the CLI prints, `http://127.0.0.1:9293`, in Chrome. The chat bubble is in the corner. Ask "What are your best sellers?"

During development the widget does **not** appear at the store's own address (`your-store.myshopify.com`). That address shows the published theme, which only gets the widget after `npm run deploy` releases a version of the app. The **Turn on chat widget** button on the app's home page targets the published theme, so it is the right button for merchants on a released app but not for this dev preview.

If linking to a new app blanks the `scopes` line in `shopify.app.toml`, restore it from git and restart `npm run dev`; the app proxy needs `write_app_proxy`.

### Testing without a store

```bash
npm test                    # 142 unit and integration tests
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
| `CHAT_ORDERS_PER_IP_PER_HOUR` | `10` | Pay-on-delivery orders per visitor address |
| `CHAT_ORDERS_PER_PHONE_PER_DAY` | `3` | Pay-on-delivery orders per phone number |
| `CHAT_ORDERS_PER_SHOP_PER_HOUR` | `60` | Pay-on-delivery orders per shop, all visitors together |
| `CHAT_ORDERS_PER_SHOP_PER_DAY` | `300` | Daily ceiling of pay-on-delivery orders per shop |
| `LLM_DAILY_TOKEN_BUDGET` | `2000000` | Token ceiling per UTC day across **all** shops. Chat stops when it is reached. Size it to your budget |

What the merchant sets, and where:

- **In the app (setup tour or Settings):** which abilities are on, the policy picks, the assistant's name, welcome message and tone, optional free-text detail, pause chat, transcript retention. The widget fetches the name and welcome message from the app, and hides itself while chat is paused.
- **In the theme editor:** accent color, position and suggested questions, plus a fallback title and welcome message used until the app's are filled in.

What the merchant writes is added to the assistant's instructions as "notes from the store owner", below the fixed rules, which it cannot override. It should be treated as public: a determined shopper can get the assistant to repeat it.

To use a different model provider, implement the `LlmProvider` interface in `app/assistant/llm/provider.ts` and select it in `app/assistant/llm/index.server.ts`.

### Access scopes

| Scope | Used for |
| --- | --- |
| `unauthenticated_read_product_listings` | Storefront catalog: search, best sellers, product details |
| `read_products` | Merchant assistant: catalog search, low stock |
| `read_orders` | Merchant assistant: recent orders. Shopper order-status lookup (opt-in) |
| `read_reports` | Merchant assistant: sales analytics through ShopifyQL |
| `write_app_proxy` | Registering the `/apps/shopi-assist` storefront proxy |
| `write_returns` | Shopper return requests (opt-in). Creates a request the merchant must approve |
| `write_draft_orders` | Pay-on-delivery orders from the chat form (opt-in): prices the order, creates it and completes it |
| `write_payment_terms` | Marks those orders "due on fulfillment" so they are unpaid rather than paid |
| `write_orders` | Shopper-confirmed changes to their own unshipped order (opt-in): cancel, new delivery address, the tags and note that tell the merchant |
| `write_order_edits` | Shopper-confirmed item changes to their own unshipped, unpaid order (opt-in) |

`read_orders` and `read_reports` involve **protected customer data**. On a development store you can use them after selecting the data in your app's Dev Dashboard (Settings → Access requests); for a public app Shopify must approve the request. If analytics access is missing, the merchant assistant falls back to totalling recent orders and says the figures are approximate.

## Testing with dummy data

`TESTING.md` has dummy customers, things to say to the bot and what to expect. `npm run seed:test-orders` creates unpaid dummy orders on a development store (and only there). On a development store the order form also shows a "Fill test details" button and the order limits are much looser; Shopify, not the browser, says whether a store is a development store.

## What has and hasn't been verified

Verified locally:

- 287 automated tests: tool-calling loop, audience boundary, each tool against fake API responses, shop and visitor isolation on a real SQLite database, rate and spend limits, order-lookup throttles, pay-on-delivery orders (pricing, placing, limits, retries), retention and redaction, the proxy routes, the OpenAI adapter's request format, and the widget in a simulated browser (rendering, XSS safety, cart, order summary, order form, errors, persistence).
- All 38 GraphQL queries and mutations validate against Shopify's published 2026-10 Admin and Storefront schemas.
- The built server accepts correctly signed proxy requests and rejects unsigned, forged, tampered and stale ones (`npm run smoke`). Shopify's signature covers the query string and a timestamp with a 90-second window; it does not stop the same request being re-sent inside that window, which is one reason the limits above exist.
- **Pay-on-delivery orders on a development store, end to end.** Through the app's own order endpoint: the country list loads; a made-up item is refused; an address without state and postal code is asked to add them; delivery options and totals come back and change with the option picked; a wrong total is refused; the order is created **unpaid** (payment pending, "due on fulfillment") with its tags; and the same request sent twice returns the same order. A state typed as a name ("Illinois", "California") is accepted. Not yet clicked through in a browser on the storefront, and tax was 0 on this store, so tax has not been compared with the checkout.
- **Order status on the development store, with the real model:** basic status from the order number alone; full status with the phone number on the order in place of an email; a wrong phone number refused; and "where is it?" afterwards answered without asking for proof again.
- An independent security review of the code; its findings are fixed or listed below.
- `shopify theme check` and `shopify app security check` report no findings.
- The widget was rendered in headless Chrome at desktop and mobile sizes.

Verified on a real development store (with the mock model):

- Install, OAuth and scopes; the app proxy; Shopify's signature on real proxied requests.
- The widget rendering inside a real theme (Dawn) through the CLI's local preview.
- Best sellers from the real Storefront API, returned as product cards.

Two things only showed up on the real store and are now fixed and tested:

- Dawn hides empty `<div>`s, which hid the widget's mount point (its content is in a shadow root).
- On a password-protected store Shopify returns no storefront URL for any product, so products were being discarded. They are now linked by handle.

Not yet verified:

- Real answers from GPT-4o, including how well it picks tools. Everything so far used the mock model.
- The other shopper tools on a real store: search, product details, collections, policies, add to cart from chat, ordering in chat and the order summary, order status. The order summary reads the theme's `/cart.js`; so far it has only run against the preview server's stand-in cart (`npm run widget:preview`).
- **The list of states in a real browser.** The form reads it from `country_option_tags`, which the app embed puts on the page. Tested against a copy of that markup, not yet seen on the storefront. If the list is missing or a country's name does not match, the form falls back to a text box for the state.
- **Order changes on a real store.** Cancelling, changing the address and changing the items are tested against fake Shopify responses, and every query validates against Shopify's schema, but none has run on a store yet: the two scopes they need (`write_orders`, `write_order_edits`) had not been approved on the development store when this was written. Things to check there: that a cancelled order is restocked and the customer notified; that an item change on a pay-on-delivery order saves with the new total; that the address change keeps the phone number; and that a signed-in customer's orders are listed.
- **Return requests on a real store.** The queries validate against Shopify's schema and the logic is tested with fake responses, but no real return request has been created yet. It needs a fulfilled order on the dev store.
- The merchant assistant on a real store, including ShopifyQL responses (row format and access).
- The admin pages inside the real Shopify admin: the setup tour, the shopper preview chat, Settings and the widget-status check. They type-check against Shopify's Polaris types and build, but have not been clicked through in a browser.
- The widget on a published theme after `npm run deploy` (so far it has only been seen in the dev preview).
- **Which visitor address Shopify's proxy reports.** The per-address limits use the first `X-Forwarded-For` value. Shopify's docs say the proxy sets it to the client address but not whether a value sent by the visitor is replaced. On the dev store, request the proxy URL with `curl -H "X-Forwarded-For: 1.2.3.4"` and check the app log. If the visitor's value survives, the per-address limits can be dodged and the address must be read from a different position. The per-email, per-shop and token limits do not depend on it.

## Before going live

- **Data handling.** Shopper messages and the store data needed to answer them are sent to the LLM provider. Transcripts are stored in the app database for the retention period. Cover both in your privacy policy and get whatever approvals your organisation requires before connecting real customer data.
- **Database.** SQLite is for development. Use a hosted database in production and change `datasource` in `prisma/schema.prisma`.
- **Limits are held in memory per process.** Rate limits and the daily token budget reset on restart and are per instance. Move them to a shared store before running more than one instance, and set a hard spending limit in your LLM provider's dashboard as the real backstop.
- **App Store listing.** The landing page (`app/routes/_index`) and `auth.login` include the template's "enter your shop domain" form. The App Store does not allow asking for a myshopify.com URL, so remove both forms before submitting.
- **Access tokens** are stored unencrypted in the database, as in Shopify's template. Use a database with encryption at rest.
- **Shared devices.** The widget keeps the conversation in the browser's local storage for up to a day so it survives page changes.
- **Customer data requests.** The `customers/data_request` webhook logs the shop, customer id and number of linked transcripts; the export itself is manual. Guest conversations are not linked to a customer, which is why email addresses are masked rather than stored.
- **Protected customer data** approval is needed for orders and analytics on live stores. Pay-on-delivery orders also write the shopper's name, phone, email and address, so they need those fields approved too. On a development store no review is needed, but the data still has to be selected: in the Dev Dashboard open the app, then Settings, Access requests, Protected customer data, Manage; select customer data and the name, address, phone and email fields, and save. Until then every order attempt fails and the app log says `reason=protected_customer_data`.
- **Errors through the app proxy.** Shopify's proxy does not hand an error response to the browser as the app sent it, so the storefront endpoints send errors meant for the shopper as HTTP 200 with `ok: false` and the real status in `error.status`.
- **Fake orders.** Pay-on-delivery orders come from anonymous visitors and commit stock. The limits slow abuse down but cannot tell a real buyer from a fake one, so confirm these orders (for example by phone) before shipping, and leave the feature off if you do not offer cash on delivery.
- **Hosting.** `shopify app deploy` publishes configuration and the widget extension; the app server needs its own host.

## Not built yet

- Merchant write actions (create discounts, edit products, adjust inventory, refunds). The tool registry is designed for them, but each should run only after the merchant confirms it in the UI.
- Refunds. A paid order's cancellation is passed to the merchant as a request; the assistant never refunds.
- Changing the items of a paid order, or sending an order to another country. Both change what is owed, so they go to the store.
- For pay-on-delivery orders: discount codes, subscriptions and customised items (those carts are sent to the checkout), and attaching the order to a logged-in customer.
- Looking up a pay-on-delivery order placed without an email from a different chat or device. Inside the chat it was placed from, the assistant knows it; anywhere else the lookup still needs an email.
- Online payment inside the chat. Shopify does not let an app take card payments outside its checkout.
- Streaming replies.
- Billing.
- Translations of the widget's own labels.

## Credits

Scaffolded from Shopify's React Router app template. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
