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
import {
  clientIp,
  errorJson,
  NO_STORE,
  readJsonBody,
  throughProxy,
} from "../assistant/proxy-request.server";
import { getSettings } from "../assistant/settings.server";
import { isDevelopmentStore, toGraphqlFn } from "../assistant/shopify-clients.server";
import { authenticate } from "../shopify.server";

/**
 * GET: the widget's configuration. The name and welcome message set in the
 * app override the theme editor's defaults when they are filled in, and a
 * paused chat tells the widget to hide itself.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.public.appProxy(request);
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
      // Whether shoppers can give the chat a thumbs-up or thumbs-down.
      ratings: settings.chatRatings,
      // Whether product cards offer "Buy now", which starts an order.
      buyNow: settings.allowCheckout && settings.allowAddToCart,
      // On a development store the address form offers to fill in test details.
      testMode:
        settings.allowAddressChange && admin
          ? await isDevelopmentStore(session.shop, toGraphqlFn(admin, "Admin"))
          : false,
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

  const body = await readJsonBody(request);
  if (body instanceof Response) return body;

  const url = new URL(request.url);
  // Shopify adds exactly one logged_in_customer_id (empty for guests) and
  // signs it. Anything else, such as a duplicate or a non-numeric value, is
  // treated as "not logged in" rather than trusted.
  const customerIds = url.searchParams.getAll("logged_in_customer_id");
  const customerId =
    customerIds.length === 1 && /^\d{1,20}$/.test(customerIds[0]) ? customerIds[0] : null;
  const ip = clientIp(request);

  try {
    const result = await handleChatTurn({
      shop: session.shop,
      audience: "shopper",
      visitorId: body.visitorId,
      conversationId: body.conversationId,
      message: body.message,
      country: body.country,
      language: body.language,
      cart: body.cart,
      supports: body.supports,
      customerId,
      ip,
      admin: toGraphqlFn(admin, "Admin"),
      storefront: toGraphqlFn(storefront, "Storefront"),
    });
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    return throughProxy(chatErrorResponse(error));
  }
};
