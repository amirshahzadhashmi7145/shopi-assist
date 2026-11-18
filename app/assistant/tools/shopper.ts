/**
 * Tools for the public storefront widget.
 *
 * Everything here is reachable by anonymous visitors, so each tool must only
 * expose what a visitor could already see on the storefront. Catalog data
 * comes from the Storefront API, which only returns published products. The
 * single exception is `get_order_status`, which is opt-in per shop and gated
 * on the shopper proving they know both the order number and checkout email.
 */
import { z } from "zod";

import { clientKey } from "../rate-limit";
import type { Money, ProductCard } from "../types";
import { defineTool, ToolError, type ToolDefinition } from "./registry";
import {
  BEST_SELLERS_QUERY,
  COLLECTION_BEST_SELLERS_QUERY,
  COLLECTIONS_QUERY,
  PRODUCT_DETAILS_QUERY,
  SEARCH_PRODUCTS_QUERY,
  SHOP_POLICIES_QUERY,
  VARIANT_FOR_CART_QUERY,
} from "./storefront-queries";

// ---------------------------------------------------------------------------
// Admin API document (Storefront documents live in ./storefront-queries.ts)
// ---------------------------------------------------------------------------

/** Admin API. Returns only what an order-status page would show. */
export const ORDER_STATUS_QUERY = `#graphql
  query ShopiAssistOrderStatus($query: String!) {
    orders(first: 5, query: $query) {
      nodes {
        name
        email
        processedAt
        cancelledAt
        displayFinancialStatus
        displayFulfillmentStatus
        fulfillments(first: 5) {
          status
          estimatedDeliveryAt
          trackingInfo(first: 3) { company number url }
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Result shapes (only the fields selected above)
// ---------------------------------------------------------------------------

interface StorefrontProduct {
  id: string;
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  availableForSale: boolean;
  onlineStoreUrl: string | null;
  description: string;
  featuredImage: { url: string; altText: string | null } | null;
  priceRange: { minVariantPrice: Money; maxVariantPrice: Money };
  compareAtPriceRange: { maxVariantPrice: Money };
  variants: { nodes: Array<{ id: string; availableForSale: boolean }> };
}

interface StorefrontVariant {
  id: string;
  title: string;
  availableForSale: boolean;
  price: Money;
  compareAtPrice: Money | null;
  selectedOptions: Array<{ name: string; value: string }>;
}

interface StorefrontProductDetails extends StorefrontProduct {
  fullDescription: string;
  tags: string[];
  options: Array<{ name: string; optionValues: Array<{ name: string }> }>;
  allVariants: { nodes: StorefrontVariant[] };
}

interface ShopPolicy {
  title: string;
  body: string;
  url: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** "gid://shopify/ProductVariant/123" -> "123". */
export function numericId(gid: string): string | null {
  const match = /(\d+)(?:\?.*)?$/.exec(gid);
  return match ? match[1] : null;
}

function formatMoney(money: Money): string {
  return `${money.amount} ${money.currencyCode}`;
}

/** Products without a storefront page are dropped: the shopper could not open them. */
function isBrowsable(product: Partial<StorefrontProduct> | null | undefined): product is StorefrontProduct {
  return Boolean(product && product.id && product.onlineStoreUrl);
}

export function toProductCard(product: StorefrontProduct): ProductCard {
  const price = product.priceRange.minVariantPrice;
  const compareAt = product.compareAtPriceRange?.maxVariantPrice;
  const onSale = compareAt && Number(compareAt.amount) > Number(price.amount);
  const variants = product.variants.nodes;

  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    url: product.onlineStoreUrl,
    imageUrl: product.featuredImage?.url ?? null,
    imageAlt: product.featuredImage?.altText ?? null,
    price,
    compareAtPrice: onSale ? compareAt : null,
    available: product.availableForSale,
    variantId:
      variants.length === 1 && variants[0].availableForSale
        ? numericId(variants[0].id)
        : null,
  };
}

/** Compact, model-facing view of a product. */
function toProductSummary(product: StorefrontProduct) {
  const { minVariantPrice, maxVariantPrice } = product.priceRange;
  const priceVaries = minVariantPrice.amount !== maxVariantPrice.amount;
  return {
    title: product.title,
    handle: product.handle,
    price: priceVaries
      ? `from ${formatMoney(minVariantPrice)}`
      : formatMoney(minVariantPrice),
    inStock: product.availableForSale,
    vendor: product.vendor || undefined,
    type: product.productType || undefined,
    summary: product.description || undefined,
  };
}

function productListResult(products: StorefrontProduct[], extra: Record<string, unknown> = {}) {
  return {
    output: {
      ...extra,
      count: products.length,
      products: products.map(toProductSummary),
    },
    cards: products.map(toProductCard),
  };
}

export function htmlToText(html: string, maxLength: number): string {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr)>|<br\s*\/?>/gi, "\n")
    // Inline formatting disappears without leaving a gap ("<b>30</b>." -> "30.").
    .replace(/<\/?(strong|b|em|i|u|span|a|small|sup|sub)(\s[^>]*)?>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function buyerVariables(context: { buyer: { country?: string; language?: string } }) {
  return {
    country: context.buyer.country ?? null,
    language: context.buyer.language ?? null,
  };
}

const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(10)
  .default(5)
  .describe("How many products to return (1-10).");

const handleSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9][a-z0-9\-_]*$/i, "Must be a URL handle like 'blue-t-shirt'.");

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const searchProducts = defineTool({
  name: "search_products",
  description:
    "Search this store's catalog by keywords (product name, type, color, use). Returns matching products with price and availability.",
  audiences: ["shopper"],
  schema: z.object({
    query: z.string().trim().min(1).max(200).describe("Search keywords."),
    limit: limitSchema,
  }),
  isAvailable: (context) => Boolean(context.storefront),
  async run({ query, limit }, context) {
    const data = await context.storefront!<{
      search: { nodes: Array<Partial<StorefrontProduct>> };
    }>(SEARCH_PRODUCTS_QUERY, { query, first: limit, ...buyerVariables(context) });
    return productListResult(data.search.nodes.filter(isBrowsable), { query });
  },
});

const getBestSellers = defineTool({
  name: "get_best_sellers",
  description:
    "List the store's best-selling (most popular) products, optionally within one collection. Use for 'top sellers', 'most popular', 'what do people buy' questions.",
  audiences: ["shopper"],
  schema: z.object({
    limit: limitSchema,
    collectionHandle: handleSchema
      .optional()
      .describe("Limit to one collection, using its handle from list_collections."),
  }),
  isAvailable: (context) => Boolean(context.storefront),
  async run({ limit, collectionHandle }, context) {
    if (collectionHandle) {
      const data = await context.storefront!<{
        collection: {
          title: string;
          products: { nodes: Array<Partial<StorefrontProduct>> };
        } | null;
      }>(COLLECTION_BEST_SELLERS_QUERY, {
        handle: collectionHandle,
        first: limit,
        ...buyerVariables(context),
      });
      if (!data.collection) {
        throw new ToolError(`No collection with handle "${collectionHandle}".`);
      }
      return productListResult(data.collection.products.nodes.filter(isBrowsable), {
        collection: data.collection.title,
        rankedBy: "best selling",
      });
    }

    const data = await context.storefront!<{
      products: { nodes: Array<Partial<StorefrontProduct>> };
    }>(BEST_SELLERS_QUERY, { first: limit, ...buyerVariables(context) });
    return productListResult(data.products.nodes.filter(isBrowsable), {
      rankedBy: "best selling",
    });
  },
});

const getProductDetails = defineTool({
  name: "get_product_details",
  description:
    "Get full details for one product by handle: description, options (size, color), every variant with price, stock status and variantId. Call this before adding a product with several variants to the cart.",
  audiences: ["shopper"],
  schema: z.object({
    handle: handleSchema.describe("Product handle from a previous search result."),
  }),
  isAvailable: (context) => Boolean(context.storefront),
  async run({ handle }, context) {
    const data = await context.storefront!<{
      product: StorefrontProductDetails | null;
    }>(PRODUCT_DETAILS_QUERY, { handle, ...buyerVariables(context) });

    const product = data.product;
    if (!isBrowsable(product)) {
      throw new ToolError(`No product with handle "${handle}" is available in this store.`);
    }
    const details = product as StorefrontProductDetails;

    return {
      output: {
        ...toProductSummary(details),
        description: details.fullDescription,
        tags: details.tags.slice(0, 15),
        options: details.options.map((option) => ({
          name: option.name,
          values: option.optionValues.map((value) => value.name),
        })),
        variants: details.allVariants.nodes.map((variant) => ({
          variantId: numericId(variant.id),
          title: variant.title,
          price: formatMoney(variant.price),
          compareAtPrice: variant.compareAtPrice
            ? formatMoney(variant.compareAtPrice)
            : undefined,
          inStock: variant.availableForSale,
        })),
      },
      cards: [toProductCard(details)],
    };
  },
});

const listCollections = defineTool({
  name: "list_collections",
  description:
    "List the store's product collections (categories) with their handles. Use to answer 'what do you sell' or before filtering best sellers by collection.",
  audiences: ["shopper"],
  schema: z.object({
    limit: z.number().int().min(1).max(20).default(10),
  }),
  isAvailable: (context) => Boolean(context.storefront),
  async run({ limit }, context) {
    const data = await context.storefront!<{
      collections: {
        nodes: Array<{
          title: string;
          handle: string;
          onlineStoreUrl: string | null;
          description: string;
        }>;
      };
    }>(COLLECTIONS_QUERY, { first: limit, ...buyerVariables(context) });

    return {
      output: {
        collections: data.collections.nodes
          .filter((collection) => collection.onlineStoreUrl)
          .map((collection) => ({
            title: collection.title,
            handle: collection.handle,
            url: collection.onlineStoreUrl,
            description: collection.description || undefined,
          })),
      },
    };
  },
});

const POLICY_FIELDS = {
  shipping: "shippingPolicy",
  refund: "refundPolicy",
  privacy: "privacyPolicy",
  terms: "termsOfService",
} as const;

const getStorePolicy = defineTool({
  name: "get_store_policy",
  description:
    "Read one of the store's published policies: shipping, refund (returns and exchanges), privacy, or terms of service. Always use this instead of guessing policy details.",
  audiences: ["shopper"],
  schema: z.object({
    policy: z.enum(["shipping", "refund", "privacy", "terms"]),
  }),
  isAvailable: (context) => Boolean(context.storefront),
  async run({ policy }, context) {
    const data = await context.storefront!<{
      shop: Record<string, ShopPolicy | null | string>;
    }>(SHOP_POLICIES_QUERY);

    const found = data.shop[POLICY_FIELDS[policy]] as ShopPolicy | null;
    if (!found || !found.body) {
      return {
        output: {
          policy,
          published: false,
          note: "The store has not published this policy. Say so and suggest contacting the store.",
        },
      };
    }
    return {
      output: {
        policy,
        published: true,
        title: found.title,
        url: found.url,
        text: htmlToText(found.body, 4000),
      },
    };
  },
});

const addToCart = defineTool({
  name: "add_to_cart",
  description:
    "Add one product variant to the shopper's cart. Only call this when the shopper clearly asks to add an item. Needs a variantId from get_product_details.",
  audiences: ["shopper"],
  schema: z.object({
    variantId: z
      .string()
      .trim()
      .regex(/^\d{1,20}$/, "Use the numeric variantId from get_product_details."),
    quantity: z.number().int().min(1).max(10).default(1),
  }),
  isAvailable: (context) => Boolean(context.storefront),
  async run({ variantId, quantity }, context) {
    // Confirm the variant is real and purchasable, so a made-up id cannot
    // produce a confusing error in the shopper's browser.
    const data = await context.storefront!<{
      node: {
        id?: string;
        title?: string;
        availableForSale?: boolean;
        product?: { title: string; onlineStoreUrl: string | null };
      } | null;
    }>(VARIANT_FOR_CART_QUERY, { id: `gid://shopify/ProductVariant/${variantId}` });

    const variant = data.node;
    // Same rule as the catalog tools: a product without a storefront page is
    // treated as if it did not exist, so ids cannot be used to probe for it.
    if (!variant?.id || !variant.product?.onlineStoreUrl) {
      throw new ToolError("That variant does not exist. Look it up with get_product_details first.");
    }
    if (!variant.availableForSale) {
      throw new ToolError(`"${variant.product.title}" (${variant.title}) is out of stock.`);
    }

    const title =
      variant.title && variant.title !== "Default Title"
        ? `${variant.product.title} (${variant.title})`
        : variant.product.title;

    return {
      output: {
        status: "adding",
        item: title,
        quantity,
        note: "The chat widget is adding this to the cart in the shopper's browser now. Confirm briefly and mention they can review it in their cart.",
      },
      actions: [{ type: "add_to_cart", variantId, quantity, title }],
    };
  },
});

// Order lookup limits. Guessing an order number for a known email must stay
// impractical even for someone rotating addresses, so the address is only one
// of four independent keys.
const ORDER_LOOKUPS_PER_TURN = 2;
const ORDER_LOOKUPS_PER_ADDRESS = 5; // per 15 minutes
const ORDER_LOOKUPS_PER_EMAIL = 5; // per hour, whoever is asking
const ORDER_LOOKUPS_PER_SHOP = 60; // per hour, all visitors together
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ORDER_LOOKUP_THROTTLED =
  "Too many order lookups. Ask the shopper to try again later or contact the store.";

/** Short non-reversible key, so email addresses are not held in the limiter. */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
const ORDER_NOT_FOUND =
  "No order matches that order number and email. Ask the shopper to double-check both, or to contact the store.";

const getOrderStatus = defineTool({
  name: "get_order_status",
  description:
    "Check the status and tracking of the shopper's own order. Requires BOTH the order number and the email address used at checkout; ask for whichever is missing before calling.",
  audiences: ["shopper"],
  schema: z.object({
    orderNumber: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^#?[A-Za-z0-9\-_.]+$/, "Order number like 1001 or #1001."),
    email: z.email().max(254),
  }),
  // Off unless the merchant turned it on in the app settings.
  isAvailable: (context) =>
    Boolean(context.admin) && context.settings.orderLookupEnabled,
  async run({ orderNumber, email }, context) {
    const wantedEmail = email.trim().toLowerCase();

    // Slow down guessing of order number + email pairs.
    context.turn.orderLookups += 1;
    if (context.turn.orderLookups > ORDER_LOOKUPS_PER_TURN) {
      throw new ToolError(
        "Only a couple of orders can be checked per message. Ask the shopper which single order they mean.",
      );
    }
    const nowMs = context.now().getTime();
    const limits: Array<[key: string, max: number, windowMs: number]> = [
      [
        `order-lookup:ip:${context.shop}:${clientKey(context.buyer.ip)}`,
        ORDER_LOOKUPS_PER_ADDRESS,
        FIFTEEN_MINUTES_MS,
      ],
      [
        `order-lookup:email:${context.shop}:${fingerprint(wantedEmail)}`,
        ORDER_LOOKUPS_PER_EMAIL,
        ONE_HOUR_MS,
      ],
      [`order-lookup:shop:${context.shop}`, ORDER_LOOKUPS_PER_SHOP, ONE_HOUR_MS],
    ];
    for (const [key, max, windowMs] of limits) {
      if (!context.rateLimiter.hit(key, max, windowMs, nowMs).allowed) {
        throw new ToolError(ORDER_LOOKUP_THROTTLED);
      }
    }

    const wantedName = orderNumber.replace(/^#/, "").toLowerCase();

    const data = await context.admin!<{
      orders: {
        nodes: Array<{
          name: string;
          email: string | null;
          processedAt: string;
          cancelledAt: string | null;
          displayFinancialStatus: string | null;
          displayFulfillmentStatus: string;
          fulfillments: Array<{
            status: string;
            estimatedDeliveryAt: string | null;
            trackingInfo: Array<{
              company: string | null;
              number: string | null;
              url: string | null;
            }>;
          }>;
        }>;
      };
    }>(ORDER_STATUS_QUERY, { query: `name:${wantedName}` });

    // The search is fuzzy, so require an exact match on both fields here.
    // The same message is used for "no such order" and "wrong email" so the
    // tool cannot be used to discover which order numbers exist.
    const order = data.orders.nodes.find(
      (candidate) =>
        candidate.name.replace(/^#/, "").toLowerCase() === wantedName &&
        (candidate.email ?? "").toLowerCase() === wantedEmail,
    );
    if (!order) throw new ToolError(ORDER_NOT_FOUND);

    return {
      output: {
        order: order.name,
        placedOn: order.processedAt.slice(0, 10),
        cancelled: Boolean(order.cancelledAt),
        paymentStatus: order.displayFinancialStatus,
        fulfillmentStatus: order.displayFulfillmentStatus,
        shipments: order.fulfillments.map((fulfillment) => ({
          status: fulfillment.status,
          estimatedDelivery: fulfillment.estimatedDeliveryAt?.slice(0, 10),
          tracking: fulfillment.trackingInfo.map((tracking) => ({
            carrier: tracking.company,
            number: tracking.number,
            url: tracking.url,
          })),
        })),
      },
    };
  },
});

export const shopperTools: ToolDefinition[] = [
  searchProducts,
  getBestSellers,
  getProductDetails,
  listCollections,
  getStorePolicy,
  addToCart,
  getOrderStatus,
];
