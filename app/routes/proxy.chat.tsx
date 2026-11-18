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

/**
 * Reads the request body but stops as soon as it exceeds `maxBytes`, so a
 * request that lies about (or omits) Content-Length cannot make the server
 * buffer an arbitrarily large body. Returns null when the limit is exceeded.
 */
async function readBodyCapped(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * GET: the widget's configuration. The name and welcome message set in the
 * app override the theme editor's defaults when they are filled in, and a
 * paused chat tells the widget to hide itself.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return errorJson("not_installed", "Chat is not available for this store.", 404);
  }
  const settings = await getSettings(session.shop);
  return Response.json(
    {
      ok: true,
      enabled: settings.enabled,
      ready: getLlmStatus().ready,
      title: settings.assistantName,
      greeting: settings.greeting,
    },
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

  // Only the widget should be posting here. Another website can make a
  // visitor's browser send a "simple" cross-site POST without asking, but it
  // cannot set a JSON content type without a CORS preflight, which this
  // endpoint never approves. Browsers also label cross-site requests.
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return errorJson("invalid_request", "Unsupported content type.", 415);
  }
  // The content-type rule above is the real barrier. This second check only
  // refuses what the browser itself labels as coming from another site.
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return errorJson("invalid_request", "Cross-site requests are not allowed.", 403);
  }

  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return errorJson("invalid_request", "That message is too long.", 413);
  }
  const text = await readBodyCapped(request, MAX_BODY_BYTES);
  if (text === null) {
    return errorJson("invalid_request", "That message is too long.", 413);
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return errorJson("invalid_request", "Something went wrong. Please reload the page.", 400);
  }

  const url = new URL(request.url);
  // Shopify adds exactly one logged_in_customer_id (empty for guests) and
  // signs it. Anything else, such as a duplicate or a non-numeric value, is
  // treated as "not logged in" rather than trusted.
  const customerIds = url.searchParams.getAll("logged_in_customer_id");
  const customerId =
    customerIds.length === 1 && /^\d{1,20}$/.test(customerIds[0]) ? customerIds[0] : null;
  // Shopify's proxy reports the visitor's address here. It is used only as
  // one of several rate-limit keys, never for access decisions.
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
