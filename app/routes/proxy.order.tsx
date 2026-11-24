/**
 * Storefront endpoint for pay-on-delivery orders placed from the chat widget's
 * order form, reached only through Shopify's app proxy:
 *
 *   https://{shop}/apps/shopi-assist/order  ->  {app}/proxy/order
 *
 * Like the chat endpoint, the shop comes from Shopify's signature on the
 * request and everything in the body is untrusted. Unlike the chat endpoint,
 * no model is involved: the form posts here directly.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import {
  handleOrderAction,
  ORDER_ACTION_STEPS,
} from "../assistant/order-actions.server";
import {
  handleChatOrder,
  listDeliveryCountries,
  orderErrorResponse,
} from "../assistant/orders.server";
import {
  clientIp,
  errorJson,
  NO_STORE,
  readJsonBody,
  throughProxy,
} from "../assistant/proxy-request.server";
import { toGraphqlFn } from "../assistant/shopify-clients.server";
import { authenticate } from "../shopify.server";

/** GET: what the order form needs before the shopper fills it in. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, storefront } = await authenticate.public.appProxy(request);
  if (!session || !storefront) {
    return errorJson("not_installed", "Ordering is not available for this store.", 404);
  }
  try {
    const delivery = await listDeliveryCountries({
      shop: session.shop,
      language: new URL(request.url).searchParams.get("language"),
      ip: clientIp(request),
      storefront: toGraphqlFn(storefront, "Storefront"),
    });
    return Response.json({ ok: true, ...delivery }, { headers: NO_STORE });
  } catch (error) {
    return throughProxy(orderErrorResponse(error));
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return errorJson("invalid_request", "Method not allowed.", 405);
  }

  const { session, admin, storefront } = await authenticate.public.appProxy(request);
  if (!session || !admin || !storefront) {
    return errorJson("not_installed", "Ordering is not available for this store.", 404);
  }

  const body = await readJsonBody(request);
  if (body instanceof Response) return body;

  try {
    // A confirmed change to an existing order: the body carries a signed grant.
    const isOrderAction = (ORDER_ACTION_STEPS as readonly unknown[]).includes(body.step);
    const result = isOrderAction
      ? await handleOrderAction({
          shop: session.shop,
          body,
          ip: clientIp(request),
          admin: toGraphqlFn(admin, "Admin"),
        })
      : await handleChatOrder({
          shop: session.shop,
          body,
          ip: clientIp(request),
          admin: toGraphqlFn(admin, "Admin"),
          storefront: toGraphqlFn(storefront, "Storefront"),
        });
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    return throughProxy(orderErrorResponse(error));
  }
};
