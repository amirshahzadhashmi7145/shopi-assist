/**
 * Shopify calls this whenever a product changes, which includes its stock.
 * If shoppers are waiting to hear that the product is back, they are told.
 *
 * Shopify expects an answer within a few seconds, so the emails are sent
 * after the answer has gone out, not before.
 */
import type { ActionFunctionArgs } from "react-router";

import { toGraphqlFn } from "../assistant/shopify-clients.server";
import { hasWaitingAlerts, notifyBackInStock } from "../assistant/stock-alerts.server";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // Throws a 401 response when the HMAC signature is invalid.
  const { shop, admin, payload } = await authenticate.webhook(request);
  const productId = String((payload as { id?: number | string } | null)?.id ?? "");

  // No session means the app was uninstalled: there is nobody to send for.
  if (admin && /^\d{1,20}$/.test(productId) && (await hasWaitingAlerts(db, shop, productId))) {
    void notifyBackInStock({ shop, productId, admin: toGraphqlFn(admin, "Admin") }).catch(
      (error: unknown) => {
        console.error(
          `[shopi-assist] back-in-stock check failed shop=${shop} error=${error instanceof Error ? error.name : "unknown"}`,
        );
      },
    );
  }
  return new Response();
};
