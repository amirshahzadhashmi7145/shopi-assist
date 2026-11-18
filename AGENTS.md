# Shopi Assist

An embedded Shopify app (React Router template) plus a theme app extension. Read `README.md` first: it covers architecture, the security model and what is still unverified.

## Rules that must keep holding

- The chat **audience** (`shopper` or `merchant`) and the **shop** come from the authenticated request only: `authenticate.public.appProxy` for the storefront, `authenticate.admin` for the admin. Never read either from a request body.
- Every tool declares its `audiences`. Tools reachable by `shopper` may only expose what an anonymous storefront visitor could already see. Admin-data tools are `merchant` only.
- Every Prisma query on `Conversation`, `Message` or `ShopSettings` filters by the authenticated shop.
- The widget never assigns HTML strings (`innerHTML` and friends). Model output is rendered as text nodes.
- Do not log message text, emails, tokens or webhook payloads.
- Storefront API documents go in `app/assistant/tools/storefront-queries.ts`; all other `#graphql` documents are validated against the Admin schema.

## Checks to run before finishing a change

```bash
npm run typecheck && npm run lint && npm test
npm run graphql-codegen          # after touching any GraphQL document
npm run build && npm run smoke   # after touching the proxy route or chat pipeline
npx shopify theme check --path extensions/chat-widget   # after touching the widget
```

## Shopify platform work

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for Shopify API and platform questions, and check current docs before relying on remembered API details.
