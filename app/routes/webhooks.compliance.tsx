/**
 * Mandatory privacy webhooks (GDPR/CPRA). Shopify verifies delivery of all
 * three before an app can be listed.
 *
 * What this app stores about people: chat transcripts. A transcript is linked
 * to a Shopify customer id only when the shopper was logged in while chatting.
 */
import type { ActionFunctionArgs } from "react-router";

import {
  deleteCustomerConversations,
  deleteShopData,
} from "../assistant/store.server";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // Throws a 401 response when the HMAC signature is invalid.
  const { shop, topic, payload } = await authenticate.webhook(request);
  const customerId = (payload as { customer?: { id?: number | string } })?.customer?.id;

  // Log the topic only. Payloads contain personal data and must not be logged.
  console.log(`Received ${topic} webhook for ${shop}`);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      // The merchant must be given the customer's data within 30 days. This
      // app has no automated export yet: find the customer's transcripts on
      // the Conversations page and pass them to the merchant.
      console.log(
        `[shopi-assist] ACTION NEEDED: data request for a customer of ${shop}. Export their conversations for the merchant.`,
      );
      break;

    case "CUSTOMERS_REDACT":
      if (customerId !== undefined && customerId !== null) {
        const removed = await deleteCustomerConversations(db, shop, String(customerId));
        console.log(`[shopi-assist] redacted ${removed} conversation(s) for a customer of ${shop}`);
      }
      break;

    case "SHOP_REDACT":
      // Sent 48 hours after uninstall: remove everything for the shop.
      await deleteShopData(db, shop);
      console.log(`[shopi-assist] removed all data for ${shop}`);
      break;

    default:
      break;
  }

  return new Response();
};
