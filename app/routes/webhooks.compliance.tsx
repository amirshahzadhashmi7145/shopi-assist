/**
 * Mandatory privacy webhooks (GDPR/CPRA). Shopify verifies delivery of all
 * three before an app can be listed.
 *
 * What this app stores about people: chat transcripts, and the email address
 * of a shopper who asked to hear when a product is back in stock. A
 * transcript is linked to a Shopify customer id only when the shopper was
 * logged in while chatting; an alert is found by its email address.
 */
import type { ActionFunctionArgs } from "react-router";

import {
  countCustomerConversations,
  deleteCustomerConversations,
  deleteShopData,
} from "../assistant/store.server";
import { deleteStockAlertsForEmail } from "../assistant/stock-alerts.server";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // Throws a 401 response when the HMAC signature is invalid.
  const { shop, topic, payload } = await authenticate.webhook(request);
  const customer = (payload as { customer?: { id?: number | string; email?: string } })?.customer;
  const customerId = customer?.id;
  const customerEmail = typeof customer?.email === "string" ? customer.email : "";

  // Payloads contain personal data and are never logged. The only identifier
  // that appears in a log line is the numeric customer id on a data request.
  console.log(`Received ${topic} webhook for ${shop}`);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST": {
      // The merchant must be given the customer's data within 30 days. There
      // is no automated export yet, so this logs what is needed to do it by
      // hand: the shop, the customer id and how many transcripts are linked.
      // Transcripts never contain email addresses (they are masked on save)
      // and guest conversations are not linked to any customer.
      const linked =
        customerId !== undefined && customerId !== null
          ? await countCustomerConversations(db, shop, String(customerId))
          : 0;
      console.log(
        `[shopi-assist] ACTION NEEDED: data request for customer ${customerId ?? "unknown"} of ${shop}: ${linked} linked conversation(s) to export for the merchant.`,
      );
      break;
    }

    case "CUSTOMERS_REDACT":
      if (customerId !== undefined && customerId !== null) {
        const removed = await deleteCustomerConversations(db, shop, String(customerId));
        console.log(`[shopi-assist] redacted ${removed} conversation(s) for a customer of ${shop}`);
      }
      // Their back-in-stock alerts go too. The address itself is never logged.
      if (customerEmail) {
        const alerts = await deleteStockAlertsForEmail(db, shop, customerEmail);
        console.log(`[shopi-assist] redacted ${alerts} back-in-stock alert(s) for a customer of ${shop}`);
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
