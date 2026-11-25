/**
 * Storefront endpoint for what the chat widget does with orders outside the
 * conversation, reached only through Shopify's app proxy:
 *
 *   https://{shop}/apps/shopi-assist/order  ->  {app}/proxy/order
 *
 *   GET   what the address form asks for (a change of delivery address)
 *   POST  the checkout for the items the shopper ticked, or a change to their
 *         own order that they have just confirmed with a button
 *
 * No order is placed here: that happens on the store's checkout page, however
 * the shopper pays.
 *
 * Like the chat endpoint, the shop comes from Shopify's signature on the
 * request and everything in the body is untrusted. Unlike the chat endpoint,
 * no model is involved: the widget posts here directly.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import {
  handleOrderAction,
  ORDER_ACTION_STEPS,
} from "../assistant/order-actions.server";
import {
  listDeliveryCountries,
  openCheckout,
  OrderError,
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

/** GET: what the address form needs before the shopper fills it in. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, storefront } = await authenticate.public.appProxy(request);
  if (!session || !storefront) {
    return errorJson("not_installed", "This is not available for this store.", 404);
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
    return errorJson("not_installed", "This is not available for this store.", 404);
  }

  const body = await readJsonBody(request);
  if (body instanceof Response) return body;

  try {
    // A confirmed change to an existing order: the body carries a signed grant.
    if ((ORDER_ACTION_STEPS as readonly unknown[]).includes(body.step)) {
      const result = await handleOrderAction({
        shop: session.shop,
        body,
        ip: clientIp(request),
        admin: toGraphqlFn(admin, "Admin"),
      });
      return Response.json(result, { headers: NO_STORE });
    }
    if (body.step === "checkout") {
      const result = await openCheckout({
        shop: session.shop,
        body,
        ip: clientIp(request),
        storefront: toGraphqlFn(storefront, "Storefront"),
      });
      return Response.json(result, { headers: NO_STORE });
    }
    // Anything else is not something this endpoint does. An older widget still
    // open in a browser may ask to place a pay-on-delivery order, which the
    // chat no longer takes: it is told where orders are placed.
    throw new OrderError(
      "disabled",
      403,
      "Orders are placed on the store's checkout page. Please use the checkout.",
    );
  } catch (error) {
    return throughProxy(orderErrorResponse(error));
  }
};
