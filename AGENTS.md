# Shopi Assist

An embedded Shopify app (React Router template) plus a theme app extension. Read `README.md` first: it covers architecture, the security model and what is still unverified.

## Rules that must keep holding

- The chat **audience** (`shopper` or `merchant`) and the **shop** come from the authenticated request only: `authenticate.public.appProxy` for the storefront, `authenticate.admin` for the admin. Never read either from a request body.
- The widget also sends the shopper's cart with each message. It is untrusted and only ever shown to the model as information about the shopper's own cart (`readCart` in `chat.server.ts`). Never price, order or authorise anything from it.
- Every tool declares its `audiences`. Tools reachable by `shopper` may only expose what an anonymous storefront visitor could already see. Admin-data tools are `merchant` only.
- The exception is order status, which the merchant opts into. Full status and tracking need the order number plus proof (checkout email, or the phone number on the order), or an order the server already tied to the conversation. With the second opt-in, an order number alone gets the basics only: date, payment status, delivery status. Never add tracking, items, names or addresses to that number-only answer.
- Every Prisma query on `Conversation`, `Message`, `ConversationOrder` or `ShopSettings` filters by the authenticated shop.
- `ConversationOrder` rows are written only by the server, after it placed the order or checked the order number and email against Shopify. Never create one from anything the browser or the model says.
- The widget never assigns HTML strings (`innerHTML` and friends). Model output is rendered as text nodes.
- Do not log message text, emails, tokens or webhook payloads.
- Pay-on-delivery orders (`app/assistant/orders.server.ts`, `/proxy/order`) are not a model tool and must stay that way. Names, phone numbers and addresses go from the widget's form to Shopify only: never to the LLM, the transcript, the logs or browser storage. Prices come from Shopify, never from the request. Never complete a draft order without payment terms, or Shopify records it as paid.
- Changes to an existing order (cancel, address, items) are never made by a tool. A tool returns a signed grant (`action-grant.server.ts`); the change is made by `handleOrderAction` only when the widget brings the grant back from a button press. Keep it that way, keep `blocker()` as the only test for "too late", and never grant a change for an order number alone. No money moves: nothing is cancelled or re-priced once anything has been paid.
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
