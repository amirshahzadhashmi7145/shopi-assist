import { toGraphqlFn } from "./assistant/shopify-clients.server";
import type { FactClients } from "./assistant/store-facts.server";
import { unauthenticated } from "./shopify.server";

/**
 * The two Shopify clients an admin page reads a store's facts with. `shop`
 * must be the signed-in admin's own shop, and `admin` their Admin API client.
 * A store whose Storefront API cannot be opened is still read through the
 * Admin API alone.
 */
export async function factClients(
  shop: string,
  admin: Parameters<typeof toGraphqlFn>[0],
): Promise<FactClients> {
  let storefront: FactClients["storefront"];
  try {
    const client = await unauthenticated.storefront(shop);
    storefront = toGraphqlFn(client.storefront, "Storefront");
  } catch {
    storefront = undefined;
  }
  return { admin: toGraphqlFn(admin, "Admin"), storefront };
}
