/**
 * Storefront endpoint for asking to hear when a sold-out product is back,
 * reached only through Shopify's app proxy:
 *
 *   https://{shop}/apps/shopi-assist/stock-alert  ->  {app}/proxy/stock-alert
 *
 * The shop comes from Shopify's signature on the request; everything in the
 * body is untrusted. The body holds an email address, so it is never logged.
 */
import type { ActionFunctionArgs } from "react-router";

import { chatErrorResponse } from "../assistant/chat.server";
import {
  clientIp,
  errorJson,
  NO_STORE,
  readJsonBody,
  throughProxy,
} from "../assistant/proxy-request.server";
import { toGraphqlFn } from "../assistant/shopify-clients.server";
import { handleStockAlert } from "../assistant/stock-alerts.server";
import { authenticate } from "../shopify.server";

export const loader = async () => errorJson("invalid_request", "Method not allowed.", 405);

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return errorJson("invalid_request", "Method not allowed.", 405);
  }

  const { session, storefront } = await authenticate.public.appProxy(request);
  if (!session || !storefront) {
    return errorJson("not_installed", "Chat is not available for this store.", 404);
  }

  const body = await readJsonBody(request);
  if (body instanceof Response) return body;

  try {
    const result = await handleStockAlert({
      shop: session.shop,
      body,
      ip: clientIp(request),
      storefront: toGraphqlFn(storefront, "Storefront"),
    });
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    return throughProxy(chatErrorResponse(error));
  }
};
