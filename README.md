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
- **The address form asks for what Shopify's checkout asks for**, in the same order: country, first and last name, address, city, state, ZIP and phone. It is the form a shopper fills in to change the delivery address of their own order (see below). Where Shopify knows a country's states, the state is a list to pick from, as in the checkout. The lists come from the data Shopify gives themes for address forms; the theme editor has a switch for it.
- **Chat ratings** (on by default). Once the assistant has answered, a thumbs-up and a thumbs-down sit under the chat. The shopper's rating is kept with the conversation, can be changed or taken back, and shows on the merchant's Conversations page with the totals.
- **A few numbers on the app's home page.** Conversations in the last 7 and 30 days, shopper messages, the share of thumbs up, signed-in customers, and a bar for each of the last seven days. Counted from the chats still on record, so never further back than the retention period.
- **Every order is placed on the store's checkout, however the shopper pays.** The chat puts the items in the cart, shows an order summary and sends the shopper to Shopify's checkout, where they choose card, wallet or cash on delivery, whichever the store offers. The chat takes no orders and no payment details itself. (It used to have a pay-on-delivery order form of its own. That was removed, so that paying on delivery goes through the checkout like every other way of paying.) While ordering, the assistant does not go into payment at all: it starts the order and points to the one button, Go to checkout, and if the shopper names a way of paying it says only that this is chosen on the checkout page. (Shopify does not tell apps whether a store offers cash on delivery, so there is one optional pick for it in Settings. It is used only when a shopper asks whether the store offers it.)
  - The order summary has a tick box per line. What was just picked is ticked; older cart items wait underneath. "Go to checkout" with everything ticked is a plain link to the checkout. With some lines unticked, the app makes a cart of its own for the ticked lines through the Storefront API and sends the shopper to that cart's checkout, because Shopify's checkout always takes a whole cart. The storefront cart is left as it is, the way Shopify's own "Buy it now" button leaves it.
- **A change of delivery address is typed into a form, not into the chat** (one of the changes to an order, below).
  - The form follows the order's country: which address fields there are, their order and names ("State" and "ZIP code" in the United States, "Postcode" and no county in the United Kingdom, no postal code in the Emirates), whether a postal code is needed and what one looks like. These rules come from the address data Shopify publishes and builds its checkout on (`app/assistant/address-rules.json`; rebuild it with `node scripts/build-address-rules.mjs <path to a Shopify/worldwide checkout>`). The server checks every address change against them.
  - Three choices are the store's: whether a first name is required, and whether a company name and a second address line are asked for. Shopify has the same options under Settings > Checkout but does not let apps read them, so the merchant can set them in this app's settings, under Delivery address changes. They sit behind an "Address form options" button, because Shopify's defaults suit most stores and there is then nothing to set. The defaults are Shopify's.
  - Not checked the way the checkout does: whether a postal code belongs to the chosen state, and the phone number's format for the country (7 to 15 digits is all that is asked).
- Order status by order number plus proof that the order is theirs: the checkout email, or the phone number on the order for shoppers who gave no email (off by default; the merchant opts in).
- Optionally, basic order status from the order number alone (a second opt-in): order date, payment status and delivery status, without the tracking number or link.
- **Changes to an order that has not started shipping** (each off by default). The shopper proves the order is theirs, the assistant shows a card, and the change happens only when they press its button:
  - *Cancel.* An order nothing has been paid for is cancelled and restocked. A paid order is not cancelled or refunded by the assistant; it is tagged `cancellation-requested` with the reason, for the merchant to handle.
  - *New delivery address.* Typed into a form, within the same country.
  - *Different items.* Add, remove or change quantities, only while nothing has been paid for the order.
- **Signed-in customers are recognised** (off by default). A shopper signed in to their store account can ask about their own recent orders, and change them, without giving an order number or email.
- The chat remembers the orders a shopper has proved are theirs. An order proved once (its number plus the email or phone on it) can be asked about again ("give me my order details", "where is it?") without giving the proof a second time.
- Return requests by order number, checkout email and a reason (off by default). This creates a return request in the Shopify admin that the merchant approves or declines. Nothing is refunded automatically.

**For the merchant (inside Shopify admin)**

- **Settings a merchant can finish without writing anything**, in five parts with a live preview beside them:
  - *Assistant:* show or pause the chat, its name (Ava until changed), a welcome message picked from presets or written, chat ratings, how long transcripts are kept. Its tone is not a setting: always professional, polite and precise.
  - *Shopping:* add to cart, checkout help.
  - *Orders:* order status, cancellations, address changes, edits to unpaid orders, return requests.
  - *Policies:* return window, eligibility, return shipping, exchanges and refund method; delivery time; cash on delivery. All picked from lists. Shipping regions, shipping rates and order processing time are not picked at all: they are shown live from Shopify. A delivery time is asked for only while some rate has none of its own in Shopify.
  - *Knowledge:* answers to the questions shoppers ask most (sizing, warranty, care, compatibility, discount codes, support hours, contact), each picked from a list.

  Features are switches, and a feature's own options appear only once it is on (the address form's options only with delivery address changes, lookup by order number alone only with order status). A text box appears only where a name is needed, after "Custom" is picked, or when the merchant asks to add a note in their own words. One save covers all five parts.
- **What Shopify already knows is read from Shopify, not asked for.** The app reads the store's published policies, delivery rates (from its markets or its shipping zones, whichever it uses), order processing time, the cards and wallets its checkout takes, its catalog size, its own description and its contact address, and shows each as "Synced from Shopify" or "Live from Shopify" (or says what is missing, with a link to where it is set). Where Shopify has answered, the matching question is not asked at all. See "Store facts" and "Delivery and payment" under Security model.
- **Delivery and payment are answered live.** When a shopper asks which countries the store delivers to, what delivery costs, how soon orders are sent out or how they can pay, the assistant asks Shopify at that moment (`get_shipping_info`, `get_payment_methods`) and answers with the store's own rates, conditions and delivery times ("Standard 8.00 USD, free on orders of 70.00 USD or more, 3 to 5 business days"). It works for both ways Shopify keeps shipping: in the store's markets (where Shopify is moving every store) and in its older shipping profiles. Nothing about these is stored or typed in: a rate the merchant changed a minute ago is the rate quoted. The merchant's own picks fill in only what Shopify does not answer, and their typed shipping note is used only while Shopify cannot be read.
- **A live preview of the storefront chat** next to Settings. Its look follows the name and welcome message before they are saved. Its answers come from the real assistant with the saved settings, so a test message can be sent only once changes are saved. Test chats stay out of the conversation log.
- A **setup tour** that opens the first time the app is opened after install, showing the same parts in three steps: *what it can do* (Shopping and Orders), *your policies*, and *go live* (turn the widget on, try the preview). Every step is optional and saves on its own.

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
| `app/components/settings/` | The five parts of Settings, shared by the Settings page and the tour; the live preview; the "From your Shopify store" panel |
| `app/assistant/setting-options.ts` | Every list a merchant picks from, with what the assistant is told for each pick |
| `app/assistant/store-facts.ts`, `store-facts.server.ts` | What is read from Shopify about the store, and when |
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
- **Ordering in chat changes only the shopper's own cart**, in their own browser, through the storefront's cart endpoints. The server checks that each item is a published, in-stock variant and returns its id; it creates no order, draft order or checkout. No address, phone number or payment detail passes through the chat. Every order, cash on delivery included, is placed and paid for on Shopify's checkout.
- **The cart the assistant sees is the browser's word, used as information only.** The widget sends the cart's titles, quantities and variant ids with each message. That comes from the request body, so it is validated, capped, stripped of anything that could break out of its block in the prompt, and never used to price, order or authorise anything; changes to the cart still happen in the shopper's own browser.
- **The app places no orders.** It once took pay-on-delivery orders through a form in the chat. That is gone, and with it the one place where an anonymous visitor could make the app create something in the store. The order endpoint (`/proxy/order`) now does three things, none of them reachable by the model: it opens the store's checkout for the ticked items (a cart made through the Storefront API, with no Admin API access), it says what the address form asks for, and it carries out a change to an order that the shopper confirmed with a button (below). A request to place an order there, as a widget from before the change would still send, is refused and told where orders are placed.
- **Return requests** are opt-in and use the same proof and throttles as order lookup, plus one request per order per day. They are the only thing a shopper's chat can write to the store, and what they write is a request awaiting the merchant's decision. The assistant never guesses which item to return.
- **Order changes are proposed by the model and carried out by the shopper.** A cancel, address change or item change is three separate steps. A tool checks proof and that the order has not started shipping, and returns a *grant*: a note naming one order and one change, signed with the app's secret and good for 15 minutes. The widget shows a card. Only when the shopper presses its button does the grant go to `/proxy/order`, which checks the signature, reads the order from Shopify again, and acts. So the model cannot change an order by itself, the browser cannot swap in another order or another change, and an order that started shipping in the meantime is refused. `blocker()` in `order-actions.server.ts` is the one place that decides "too late": anything other than unfulfilled, with no fulfilment begun, is too late.
- **An order number alone never changes anything.** Number-only lookups, where a store allows them, are for the basic status. Every change needs proof (email or phone on the order), an order the server tied to the chat, or a signed-in customer's own order.
- **No money moves.** Cancelling and re-pricing happen only while nothing has been paid or authorised. For a paid order the assistant records a request and the merchant decides on the cancellation and the refund.
- **A signed-in customer is whoever Shopify says they are.** The customer id comes from the app proxy's signed query string, never from the request body, and is used to list that customer's own recent orders.
- **Orders a chat already knows.** When the shopper proves an order with its number and their email or phone, the server records that order against the conversation (order id and number only). Later questions in that same conversation are answered with the order number alone, matched on the recorded id. The record is written by the server, never taken from the browser; a conversation is only reachable with its own random visitor id; and it is deleted with the conversation.
- **Order lookup** is opt-in. The shopper gives the order number and one proof, the checkout email or the phone number on the order, and both must match exactly (a phone number may be written with or without its country code, but needs at least seven matching digits). It returns only status and tracking, and gives the same answer for "wrong proof" and "no such order". Guessing is throttled four ways: per chat turn, per visitor address, per email or phone, and per shop. Phone numbers are read from Shopify only when a shopper offers one as proof, and are never sent to the model or echoed back.
- **Order status from the number alone is a separate opt-in, and deliberately weaker.** Order numbers are sequential, so with this on anyone can see the order date, payment status and delivery status of any order. The tracking number and link, which lead to where a parcel is going, are still only given with proof, and an order looked up this way is not treated as the shopper's afterwards. The per-address and per-shop throttles slow down walking through order numbers; they do not stop it. Leave it off unless that trade is acceptable.
- **Store facts come from Shopify, with the merchant's own session.** When the merchant opens the app, it asks Shopify which policies the store has published, how many products are active, and for the store's description and contact address, and keeps the answers with the shop's settings. Of these the assistant is told the store's own description (unless the merchant picks otherwise) and the contact address only if the merchant picks "by email" as their contact answer. A chat turn reads what is stored; when that is more than ten minutes old it is read from Shopify again first, waiting at most two seconds, so an answer does not rest on older facts. What one of Shopify's two APIs could not be reached for keeps its last known value, and reading the facts can never fail a chat.
- **Delivery and payment are read from Shopify at the moment a shopper asks, and never stored.** Delivery rates are public (every visitor sees them at the checkout) but live in the Admin API, so a shopper's tools are not given an Admin client for them: they are given one question they can ask (`shippingRates` on the tool context), which runs three fixed queries for the authenticated shop, once per chat turn however often the assistant asks within it. Payment methods come from the Storefront API. The model is told to use these tools for every such question and never to answer from memory.
- **The rates are read from where the store really keeps them.** Shopify keeps a store's shipping in one of two places: with its markets ("market-driven shipping", which every store is being moved to by mid-2027) or in its older shipping profiles. A store that has moved still has its old profiles, and the Admin API still returns them, but its checkout ignores them; the Storefront API's list of countries with a shipping zone is left behind in the same way. So the first query asks Shopify which the store is on (`shop.features.marketDrivenShipping`), and only that one is read; if Shopify does not say, neither is. This was learned the hard way: an earlier version read the profile of a development store on markets and answered "we deliver to the United States only" for a store whose markets deliver to Canada as well.
- **The assistant never says "we don't deliver there" on a partial read.** A country counts as delivered to only if a market or zone names it and has a rate (a market with delivery switched off, or with no rate set, delivers nothing). When Shopify had more than one request could return, or some products have rates of their own, a country the settings do not show is answered with "the checkout will show the options", not with "no". The merchant's own picks are a fallback for exactly what Shopify does not answer (where it delivers and what that costs when the settings cannot be read; dispatch and delivery times when Shopify holds no figure), and their typed shipping note only for when the settings cannot be read. Neither is given to the model otherwise: on a real store a typed note that had fallen behind was repeated as fact next to the live settings.
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
npm test                    # 468 unit and integration tests
npm run widget:preview      # the real widget on a fake storefront, canned replies → http://localhost:4010
npm run smoke               # builds the app, then real HTTP requests against it: signed like Shopify's proxy, and admin forms posted as a browser behind HTTPS posts them
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

What the merchant sets, and where:

- **In the app (setup tour or Settings):** which abilities are on, the policy picks, answers to common questions, the assistant's name and welcome message, optional notes in the merchant's own words, pause chat, transcript retention. The widget fetches the name and welcome message from the app, and hides itself while chat is paused.
- **In Shopify, read by the app:** published policies, delivery rates (the store's markets or shipping zones), order processing time, checkout payment methods, the store's description and contact address. They are changed in Shopify, never in the app.
- **In the theme editor:** accent color, position and suggested questions. The name and welcome message are set in the app only.

What the merchant picks or writes is added to the assistant's instructions as "notes from the store owner", below the fixed rules, which it cannot override. It should be treated as public: a determined shopper can get the assistant to repeat it.

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
| `write_draft_orders`, `write_payment_terms` | Not used by the app itself any more. Only `npm run seed:test-orders`, which makes dummy unpaid orders on a development store, still needs them. Remove both before submitting the app |
| `write_orders` | Shopper-confirmed changes to their own unshipped order (opt-in): cancel, new delivery address, the tags and note that tell the merchant |
| `write_order_edits` | Shopper-confirmed item changes to their own unshipped, unpaid order (opt-in) |
| `read_shipping` | Order processing time, and the zones and rates of a store that keeps its shipping in profiles, read live when a shopper asks about delivery and when the merchant opens Settings |
| `read_markets` | The same rates for a store on market-driven shipping, where each market holds its own delivery options. Shopify requires this scope to read them |

`read_orders` and `read_reports` involve **protected customer data**. On a development store you can use them after selecting the data in your app's Dev Dashboard (Settings → Access requests); for a public app Shopify must approve the request. If analytics access is missing, the merchant assistant falls back to totalling recent orders and says the figures are approximate.

## Testing with dummy data

`TESTING.md` has dummy customers, things to say to the bot and what to expect. `npm run seed:test-orders` creates unpaid dummy orders on a development store (and only there). On a development store the address form also shows a "Fill test details" button; Shopify, not the browser, says whether a store is a development store.

## What has and hasn't been verified

Verified locally:

- 468 automated tests: tool-calling loop, audience boundary, each tool against fake API responses, shop and visitor isolation on a real SQLite database, rate and spend limits, order-lookup throttles, the checkout for ticked items and the address form (its checks and what it asks for), retention and redaction, the proxy routes, the OpenAI adapter's request format, and the widget in a simulated browser (rendering, XSS safety, cart, order summary, address form, errors, persistence).
- All 38 GraphQL queries and mutations validate against Shopify's published 2026-10 Admin and Storefront schemas.
- **The admin's forms can be posted, and only from the app's own address.** React Router refuses a form post whose origin is not the address the server believes it has, and since 7.18.3 that includes the protocol. A Shopify app is always reached over HTTPS while the server behind the tunnel or proxy is spoken to over HTTP, so without being told the app's address it answers every form in the admin (saving Settings, a setup step, a preview message) with "400 Bad Request". That happened here: a routine upgrade from 7.18.2 to 7.18.6 broke all of them, in development and, as a test of the built server showed, in production too. `react-router.config.ts` now lists the app's own host, from `SHOPIFY_APP_URL` and from `application_url` in `shopify.app.toml`: exact hosts, never a pattern. `npm run smoke` posts those forms the way a browser behind HTTPS does and one from another site: the first reaches Shopify's sign-in check, the second is still refused. Shopify's own template deals with this by staying on 7.18.2.
- The built server accepts correctly signed proxy requests and rejects unsigned, forged, tampered and stale ones (`npm run smoke`). Shopify's signature covers the query string and a timestamp with a 90-second window; it does not stop the same request being re-sent inside that window, which is one reason the limits above exist.
- **Cash on delivery through the checkout: not checked on a store.** The assistant sends every order to the checkout and, when the merchant has said cash on delivery is offered, tells shoppers to pick it there. Whether the checkout really shows it depends on the store's own payment settings (a manual payment method in Shopify), which an app cannot read. The chat's own pay-on-delivery order form, which had been run end to end on the development store, was removed in favour of this.
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
- The admin pages inside the real Shopify admin: the setup tour, the shopper preview chat, Settings and the widget-status check. Settings and the tour have been drawn and clicked through in a browser with Shopify's own Polaris components (switches revealing their options, "Custom" revealing a text box, discard, what each form submits), but outside the admin: the "unsaved changes" bar, the toast after saving and the links into the Shopify admin have not been seen working there.
- **Store facts on a real store.** The queries validate against Shopify's schemas and the merging is tested with fake answers. Read for real from the development store through the Admin API: the store's name, currency, contact address and product count. From its Storefront API, the list of countries with a shipping zone was read and found to be behind the store's real settings (it is on market-driven shipping), which is why that list is shown only for stores on shipping profiles. Not yet seen: the rest of the Storefront half on a real store (description, published policies, payment brands; a development store reports no payment brands).
- **Live shipping on the development store: done for market-driven shipping, after a wrong first claim.** The development store is on market-driven shipping. This line used to say its live answers were verified; they had been checked against the store's old shipping profile, which its checkout ignores, so they were wrong for the store (they left out Canada). The reader now asks Shopify which set-up the store is on and reads its markets: three calls, about a second, a requested query cost of 487 against Shopify's limit of 1,000 for one query. Asked for real, through the signed app proxy with the real model: delivery to Canada (30.00 USD), delivery within the US (Standard 8.00 USD, free from 70.00 USD, 3 to 5 business days; Express 15.00 USD, 1 to 2 business days), which countries it ships to (both), a country it does not ship to, and how soon orders leave (within 1 business day). Every answer matched what the store's Markets settings hold, and its typed shipping note, which says otherwise, was not repeated. Not yet seen on a real store: a store still on shipping profiles (that path is tested on answers recorded from a real profile); markets nested inside one another or covering part of a country; rates by order value or weight, and carrier-calculated ones; a market with delivery switched off; an app's own shipping profile; more than 20 markets; and the payment tool on a store that reports card brands. One reading is an assumption: Shopify gives a rate's transit time in seconds, and it is worded as business days, rounded up, as Shopify's own rate names word it.
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
- **Protected customer data** approval is needed for orders and analytics on live stores. A change of delivery address also writes the shopper's name, phone and address, so those fields need approving too. On a development store no review is needed, but the data still has to be selected: in the Dev Dashboard open the app, then Settings, Access requests, Protected customer data, Manage; select customer data and the name, address, phone and email fields, and save.
- **Errors through the app proxy.** Shopify's proxy does not hand an error response to the browser as the app sent it, so the storefront endpoints send errors meant for the shopper as HTTP 200 with `ok: false` and the real status in `error.status`.
- **Hosting.** `shopify app deploy` publishes configuration and the widget extension; the app server needs its own host. The build has to know that host's address, or the admin's forms are refused (see above): put it in `application_url` in `shopify.app.toml`, where Shopify needs it anyway, or set `SHOPIFY_APP_URL` when building. A build that knows neither says so.

## Not built yet

- Merchant write actions (create discounts, edit products, adjust inventory, refunds). The tool registry is designed for them, but each should run only after the merchant confirms it in the UI.
- Refunds. A paid order's cancellation is passed to the merchant as a request; the assistant never refunds.
- Changing the items of a paid order, or sending an order to another country. Both change what is owed, so they go to the store.
- Online payment inside the chat. Shopify does not let an app take card payments outside its checkout.
- Streaming replies.
- Billing.
- Translations of the widget's own labels.

## Credits

Scaffolded from Shopify's React Router app template. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
