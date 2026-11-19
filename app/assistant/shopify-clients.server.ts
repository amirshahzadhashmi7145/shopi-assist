import type { GraphqlFn } from "./types";

/** The part of Shopify's admin and storefront clients that the assistant uses. */
interface ShopifyGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

interface GraphqlBody {
  data?: unknown;
  errors?: Array<{ message?: string }> | { message?: string } | string;
}

function describeErrors(errors: GraphqlBody["errors"]): string {
  if (!errors) return "";
  if (typeof errors === "string") return errors;
  if (Array.isArray(errors)) {
    return errors.map((error) => error.message ?? "unknown error").join("; ");
  }
  return errors.message ?? "unknown error";
}

/**
 * Adapts a Shopify API client to the plain `GraphqlFn` the tools use:
 * resolves with `data`, rejects on any GraphQL or transport error.
 */
export function toGraphqlFn(client: ShopifyGraphqlClient, label: string): GraphqlFn {
  return async <T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> => {
    const response = await client.graphql(query, { variables });
    const body = (await response.json()) as GraphqlBody;

    const message = describeErrors(body.errors);
    if (message) throw new Error(`${label} GraphQL error: ${message}`);
    if (body.data === undefined || body.data === null) {
      throw new Error(`${label} GraphQL returned no data`);
    }
    return body.data as T;
  };
}

const SHOP_NAME_TTL_MS = 60 * 60 * 1000;
const shopNames = new Map<string, { name: string; expiresAt: number }>();

/**
 * The store's display name for the system prompt, looked up server-side and
 * cached for an hour. It is never taken from the browser, because anything in
 * the system prompt must be trustworthy.
 */
export async function getShopName(
  shop: string,
  admin: GraphqlFn | undefined,
  now: number = Date.now(),
): Promise<string> {
  const cached = shopNames.get(shop);
  if (cached && cached.expiresAt > now) return cached.name;

  let name = shop.replace(/\.myshopify\.com$/i, "");
  if (admin) {
    try {
      const data = await admin<{ shop: { name: string } }>(
        `#graphql
          query ShopiAssistShopName { shop { name } }`,
      );
      if (data.shop?.name) name = data.shop.name;
    } catch {
      // Fall back to the domain; the name is cosmetic.
    }
  }
  shopNames.set(shop, { name, expiresAt: now + SHOP_NAME_TTL_MS });
  return name;
}

const STORE_KIND_TTL_MS = 60 * 60 * 1000;
const STORE_KIND_RETRY_MS = 5 * 60 * 1000;
const developmentStores = new Map<string, { value: boolean; expiresAt: number }>();

/**
 * Whether the shop is a Partner development store, which exists only for
 * testing. Asked of Shopify, never of the browser, and cached for an hour.
 * Test conveniences (a "fill test details" button, looser order limits) are
 * switched on by this alone, so they can never appear on a real store.
 * Anything short of a clear "yes" from Shopify counts as "no".
 */
export async function isDevelopmentStore(
  shop: string,
  admin: GraphqlFn | undefined,
  now: number = Date.now(),
): Promise<boolean> {
  const cached = developmentStores.get(shop);
  if (cached && cached.expiresAt > now) return cached.value;
  if (!admin) return false;

  try {
    const data = await admin<{ shop: { plan: { partnerDevelopment: boolean } | null } | null }>(
      `#graphql
        query ShopiAssistShopPlan { shop { plan { partnerDevelopment } } }`,
    );
    const value = data.shop?.plan?.partnerDevelopment === true;
    developmentStores.set(shop, { value, expiresAt: now + STORE_KIND_TTL_MS });
    return value;
  } catch {
    // Do not ask again on every page view while Shopify cannot be reached.
    developmentStores.set(shop, { value: false, expiresAt: now + STORE_KIND_RETRY_MS });
    return false;
  }
}
