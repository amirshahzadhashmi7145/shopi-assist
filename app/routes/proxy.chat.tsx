/**
 * Storefront chat endpoint, reached only through Shopify's app proxy:
 *
 *   https://{shop}/apps/shopi-assist/chat  ->  {app}/proxy/chat
 *
 * `authenticate.public.appProxy` verifies Shopify's HMAC signature on the
 * request. That signature is what proves which shop the request is for; the
 * request body is untrusted input from an anonymous visitor.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { chatErrorResponse, handleChatTurn } from "../assistant/chat.server";
import { getLlmStatus } from "../assistant/llm/index.server";
import { getSettings } from "../assistant/settings.server";
import { toGraphqlFn } from "../assistant/shopify-clients.server";
import { authenticate } from "../shopify.server";

const MAX_BODY_BYTES = 16 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };

function errorJson(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status, headers: NO_STORE });
}

/** GET: lets the widget (and you, while testing) check that the proxy is wired up. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return errorJson("not_installed", "Chat is not available for this store.", 404);
  }
  const settings = await getSettings(session.shop);
  return Response.json(
    { ok: true, enabled: settings.enabled, ready: getLlmStatus().ready },
    { headers: NO_STORE },
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return errorJson("invalid_request", "Method not allowed.", 405);
  }

  const { session, admin, storefront } = await authenticate.public.appProxy(request);
  if (!session || !admin || !storefront) {
    return errorJson("not_installed", "Chat is not available for this store.", 404);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return errorJson("invalid_request", "That message is too long.", 413);
  }

  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return errorJson("invalid_request", "That message is too long.", 413);
    }
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return errorJson("invalid_request", "Something went wrong. Please reload the page.", 400);
  }

  const url = new URL(request.url);
  // Signed by Shopify, so it can be trusted. Empty for guests.
  const customerId = url.searchParams.get("logged_in_customer_id") || null;
  // Shopify's proxy puts the visitor's address first.
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;

  try {
    const result = await handleChatTurn({
      shop: session.shop,
      audience: "shopper",
      visitorId: body.visitorId,
      conversationId: body.conversationId,
      message: body.message,
      country: body.country,
      language: body.language,
      customerId,
      ip,
      admin: toGraphqlFn(admin, "Admin"),
      storefront: toGraphqlFn(storefront, "Storefront"),
    });
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    return chatErrorResponse(error);
  }
};
