# Shopi Assist

An embedded Shopify app (React Router template) plus a theme app extension. Read `README.md` first: it covers architecture, the security model and what is still unverified.

## Rules that must keep holding

- The chat **audience** (`shopper` or `merchant`) and the **shop** come from the authenticated request only: `authenticate.public.appProxy` for the storefront, `authenticate.admin` for the admin. Never read either from a request body.
- The widget also sends the shopper's cart with each message. It is untrusted and only ever shown to the model as information about the shopper's own cart (`readCart` in `chat.server.ts`). Never price, order or authorise anything from it.
- Every tool declares its `audiences`. Tools reachable by `shopper` may only expose what an anonymous storefront visitor could already see. Admin-data tools are `merchant` only.
- The exception is order status, which the merchant opts into. Full status and tracking need the order number plus proof (checkout email, or the phone number on the order), or an order the server already tied to the conversation. With the second opt-in, an order number alone gets the basics only: date, payment status, delivery status. Never add tracking, items, names or addresses to that number-only answer.
- Every Prisma query on `Conversation`, `Message`, `ConversationOrder` or `ShopSettings` filters by the authenticated shop.
- Remembered orders (`ConversationOrder`, and a signed-in customer's) are never simply listed in the system prompt: the model takes a list for the only orders it may help with and turns away another order the shopper has just proved. `rememberedOrdersNote` in `prompts.ts` mentions them only when the latest message names one of them or names no order at all, and says nothing when the message brings an email or another number. Keep it that way; replay real chats before changing it.
- `ConversationOrder` rows are written only by the server, after it placed the order or checked the order number and email against Shopify. Never create one from anything the browser or the model says.
- The widget never assigns HTML strings (`innerHTML` and friends). Model output is rendered as text nodes.
- Do not log message text, emails, tokens or webhook payloads.
- Pay-on-delivery orders (`app/assistant/orders.server.ts`, `/proxy/order`) are not a model tool and must stay that way. Names, phone numbers and addresses go from the widget's form to Shopify only: never to the LLM, the transcript, the logs or browser storage. Prices come from Shopify, never from the request. Never complete a draft order without payment terms, or Shopify records it as paid.
- Changes to an existing order (cancel, address, items) are never made by a tool. A tool returns a signed grant (`action-grant.server.ts`); the change is made by `handleOrderAction` only when the widget brings the grant back from a button press. Keep it that way, keep `blocker()` as the only test for "too late", and never grant a change for an order number alone. No money moves: nothing is cancelled or re-priced once anything has been paid.
- What the order form asks for is never written into the widget. It comes from `app/assistant/address-rules.ts`: the delivery country's layout, names and postal code rules (data generated from Shopify/worldwide by `scripts/build-address-rules.mjs`; do not edit the JSON by hand) plus the store's three choices in `ShopSettings`. The server checks every order and address change against the same rules (`checkDelivery`); the widget's own checks are a convenience, never the gate.
- What the assistant says about a product has to be in that product's own data. The product tools give the model each product's title, summary, options, versions, tags and picture description; `search_products` keeps only products whose data mentions what the shopper asked for (`mustMention`) and says so when none does. Do not weaken this to make answers sound more helpful: a shopper asking for white boards on a store with none must be told there are none. Replay real questions on a store before changing the search tool or the grounding rules in `prompts.ts`.
- A signed-in customer's id comes only from the app proxy's signed `logged_in_customer_id`.
- Storefront API documents go in `app/assistant/tools/storefront-queries.ts`; all other `#graphql` documents are validated against the Admin schema.

## Checks to run before finishing a change

```bash
npm run typecheck && npm run lint && npm test
npm run graphql-codegen          # after touching any GraphQL document
npm run build && npm run smoke   # after touching the proxy route or chat pipeline
npm run widget:stamp             # after touching the widget's JS or CSS (a test fails if you forget)
npx shopify theme check --path extensions/chat-widget   # after touching the widget
```

## Shopify platform work

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for Shopify API and platform questions, and check current docs before relying on remembered API details.
