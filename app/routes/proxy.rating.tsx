/**
 * Storefront endpoint for rating a chat, reached only through Shopify's app
 * proxy:
 *
 *   https://{shop}/apps/shopi-assist/rating  ->  {app}/proxy/rating
 *
 * The shop comes from Shopify's signature on the request; everything in the
 * body is untrusted.
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
import { handleChatRating } from "../assistant/rating.server";
import { authenticate } from "../shopify.server";

export const loader = async () => errorJson("invalid_request", "Method not allowed.", 405);

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return errorJson("invalid_request", "Method not allowed.", 405);
  }

  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return errorJson("not_installed", "Chat is not available for this store.", 404);
  }

  const body = await readJsonBody(request);
  if (body instanceof Response) return body;

  try {
    const result = await handleChatRating({ shop: session.shop, body, ip: clientIp(request) });
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    return throughProxy(chatErrorResponse(error));
  }
};
