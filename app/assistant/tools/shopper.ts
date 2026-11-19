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
import type { Money, OrderItem, ProductCard } from "../types";
import {
  defineTool,
  ToolError,
  type ToolContext,
  type ToolDefinition,
} from "./registry";
import {
  BEST_SELLERS_QUERY,
  COLLECTION_BEST_SELLERS_QUERY,
  COLLECTION_BY_PRICE_QUERY,
  COLLECTIONS_QUERY,
  PRODUCT_DETAILS_QUERY,
  PRODUCTS_BY_PRICE_QUERY,
  SEARCH_BY_PRICE_QUERY,
  SEARCH_PRODUCTS_QUERY,
  SHOP_POLICIES_QUERY,
  VARIANT_FOR_CART_QUERY,
  VARIANTS_FOR_ORDER_QUERY,
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
        id
        fulfillments(first: 5) {
          status
          estimatedDeliveryAt
          trackingInfo(first: 3) { company number url }
        }
      }
    }
  }
`;

/** Admin API. What on an order can still be returned. */
export const RETURNABLE_ITEMS_QUERY = `#graphql
  query ShopiAssistReturnableItems($orderId: ID!) {
    returnableFulfillments(orderId: $orderId, first: 10) {
      nodes {
        returnableFulfillmentLineItems(first: 30) {
          nodes {
            quantity
            fulfillmentLineItem {
              id
              lineItem { title }
            }
          }
        }
      }
    }
  }
`;

/** Admin API. Creates a return request for the merchant to approve or decline. */
export const RETURN_REQUEST_MUTATION = `#graphql
  mutation ShopiAssistReturnRequest($input: ReturnRequestInput!) {
    returnRequest(input: $input) {
      return { name status }
      userErrors { field message }
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

/**
 * The Storefront API only returns products the store has published, so
 * anything it returns is public. `onlineStoreUrl` cannot be used as a
 * "published" test: Shopify returns null for every product while the store is
 * password-protected (all dev stores, and real stores before launch).
 */
function isProduct(product: Partial<StorefrontProduct> | null | undefined): product is StorefrontProduct {
  return Boolean(product && product.id && product.handle);
}

/**
 * Link to a product page. Falls back to the standard storefront path when
 * Shopify gives no URL; the widget runs on the storefront, so a relative link
 * resolves against the shop's own domain.
 */
function productUrl(product: { handle: string; onlineStoreUrl: string | null }): string {
  return product.onlineStoreUrl ?? `/products/${product.handle}`;
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
    url: productUrl(product),
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

function productListResult(
  nodes: Array<Partial<StorefrontProduct> | null>,
  extra: Record<string, unknown> = {},
) {
  const products = nodes.filter(isProduct);
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
    return productListResult(data.search.nodes, { query });
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
      return productListResult(data.collection.products.nodes, {
        collection: data.collection.title,
        rankedBy: "best selling",
      });
    }

    const data = await context.storefront!<{
      products: { nodes: Array<Partial<StorefrontProduct>> };
    }>(BEST_SELLERS_QUERY, { first: limit, ...buyerVariables(context) });
    return productListResult(data.products.nodes, {
      rankedBy: "best selling",
    });
  },
});

const getProductsByPrice = defineTool({
  name: "get_products_by_price",
  description:
    "List in-stock products ordered by price. Use for every 'cheapest', 'most affordable', 'lowest price', 'most expensive' or 'top of the range' question; never work out the cheapest from products you happened to fetch another way. Optionally limited to search keywords or to one collection.",
  audiences: ["shopper"],
  schema: z.object({
    order: z
      .enum(["lowest_first", "highest_first"])
      .default("lowest_first")
      .describe("lowest_first for cheapest, highest_first for most expensive."),
    limit: limitSchema,
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Keywords, when the shopper wants the cheapest of a kind, e.g. 'snowboard'."),
    collectionHandle: handleSchema
      .optional()
      .describe("Limit to one collection, using its handle from list_collections."),
  }),
  isAvailable: (context) => Boolean(context.storefront),
  async run({ order, limit, query, collectionHandle }, context) {
    const reverse = order === "highest_first";
    const variables = { first: limit, reverse, ...buyerVariables(context) };
    const extra = {
      rankedBy: `price, ${reverse ? "highest" : "lowest"} first`,
      note: "In-stock products only, ordered by each product's lowest price. The first one is the answer to 'cheapest' or 'most expensive'.",
    };

    if (collectionHandle) {
      const data = await context.storefront!<{
        collection: {
          title: string;
          products: { nodes: Array<Partial<StorefrontProduct>> };
        } | null;
      }>(COLLECTION_BY_PRICE_QUERY, { handle: collectionHandle, ...variables });
      if (!data.collection) {
        throw new ToolError(`No collection with handle "${collectionHandle}".`);
      }
      return productListResult(data.collection.products.nodes, {
        collection: data.collection.title,
        ...extra,
      });
    }

    if (query) {
      const data = await context.storefront!<{
        search: { nodes: Array<Partial<StorefrontProduct>> };
      }>(SEARCH_BY_PRICE_QUERY, { query, ...variables });
      return productListResult(data.search.nodes, { query, ...extra });
    }

    const data = await context.storefront!<{
      products: { nodes: Array<Partial<StorefrontProduct>> };
    }>(PRODUCTS_BY_PRICE_QUERY, variables);
    return productListResult(data.products.nodes, extra);
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
    if (!isProduct(product)) {
      throw new ToolError(`No product with handle "${handle}" is available in this store.`);
    }
    const details = product as StorefrontProductDetails;
    const variants = details.allVariants.nodes;
    // Shopify gives a product without options one variant called "Default
    // Title". That is not a size or a choice, so it is not shown as one.
    const hasChoices = variants.length > 1 || variants[0]?.title !== "Default Title";

    return {
      output: {
        ...toProductSummary(details),
        description: details.fullDescription,
        tags: details.tags.slice(0, 15),
        ...(hasChoices
          ? {
              options: details.options.map((option) => ({
                name: option.name,
                values: option.optionValues.map((value) => value.name),
              })),
            }
          : {
              choices:
                "None. This product comes in one version only: no sizes, colours or other options. Do not ask the shopper to pick one.",
            }),
        variants: variants.map((variant) => ({
          variantId: numericId(variant.id),
          title: hasChoices ? variant.title : undefined,
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
        collections: data.collections.nodes.map((collection) => ({
            title: collection.title,
            handle: collection.handle,
            url: collection.onlineStoreUrl ?? `/collections/${collection.handle}`,
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
    "Add one product variant to the shopper's cart, for a shopper who wants to keep shopping. Only call this when the shopper asks to add an item to the cart. When they say they want to buy or order it, start the order instead. Needs a variantId from get_product_details.",
  audiences: ["shopper"],
  schema: z.object({
    variantId: z
      .string()
      .trim()
      .regex(/^\d{1,20}$/, "Use the numeric variantId from get_product_details."),
    quantity: z.number().int().min(1).max(10).default(1),
  }),
  isAvailable: (context) => Boolean(context.storefront) && context.settings.allowAddToCart,
  async run({ variantId, quantity }, context) {
    // Confirm the variant is real and purchasable, so a made-up id cannot
    // produce a confusing error in the shopper's browser.
    const data = await context.storefront!<{
      node: {
        id?: string;
        title?: string;
        availableForSale?: boolean;
        product?: { title: string };
      } | null;
    }>(VARIANT_FOR_CART_QUERY, { id: `gid://shopify/ProductVariant/${variantId}` });

    const variant = data.node;
    // The Storefront API resolves only variants of published products, so a
    // draft or unpublished product's variant id comes back as null here.
    if (!variant?.id || !variant.product) {
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

const MAX_ORDER_LINES = 10;
const MAX_LINE_QUANTITY = 10;

/** Digits after the decimal point, so sums keep the currency's own precision. */
function decimalPlaces(amount: string): number {
  return (amount.split(".")[1] ?? "").length;
}

/** "18.0 USD" times 3 is "54.0 USD". */
function lineTotal(price: Money, quantity: number): Money {
  return {
    amount: (Number(price.amount) * quantity).toFixed(decimalPlaces(price.amount)),
    currencyCode: price.currencyCode,
  };
}

/** The total of several amounts, or null when they are not all in one currency. */
function sumMoney(amounts: Money[]): Money | null {
  if (!amounts.length) return null;
  const currencyCode = amounts[0].currencyCode;
  if (amounts.some((money) => money.currencyCode !== currencyCode)) return null;
  const places = Math.max(...amounts.map((money) => decimalPlaces(money.amount)));
  const total = amounts.reduce((sum, money) => sum + Number(money.amount), 0);
  return { amount: total.toFixed(places), currencyCode };
}

const placeOrder = defineTool({
  name: "place_order",
  description:
    "Start an order as soon as the shopper says they want to buy or order something. Puts the items in the shopper's cart and shows an order summary with the buttons to complete it. Call it once with every item; the quantity is 1 unless they said otherwise. Only ask first when a product has several variants and they have not said which. Items already in the cart are topped up to the quantity given, never doubled. You cannot take payment or delivery details yourself.",
  audiences: ["shopper"],
  schema: z.object({
    items: z
      .array(
        z.object({
          variantId: z
            .string()
            .trim()
            .regex(/^\d{1,20}$/, "Use the numeric variantId from get_product_details."),
          quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY).default(1),
        }),
      )
      .min(1)
      .max(MAX_ORDER_LINES)
      .describe("Every item in the order."),
    onlyTheseItems: z
      .boolean()
      .default(false)
      .describe(
        "True empties the cart first, so the order holds these items and nothing else. Use it only when the shopper says so: 'only this', 'just that', 'nothing else', 'start over'.",
      ),
  }),
  // Building an order means putting items in the cart, so the merchant must
  // have allowed both.
  isAvailable: (context) =>
    Boolean(context.storefront) &&
    context.settings.allowCheckout &&
    context.settings.allowAddToCart,
  async run({ items, onlyTheseItems }, context) {
    // The same variant listed twice is one line.
    const quantities = new Map<string, number>();
    for (const item of items) {
      quantities.set(
        item.variantId,
        Math.min(MAX_LINE_QUANTITY, (quantities.get(item.variantId) ?? 0) + item.quantity),
      );
    }
    const variantIds = [...quantities.keys()];

    const data = await context.storefront!<{
      nodes: Array<{
        id?: string;
        title?: string;
        availableForSale?: boolean;
        price?: Money;
        product?: { title: string };
      } | null>;
    }>(VARIANTS_FOR_ORDER_QUERY, {
      ids: variantIds.map((id) => `gid://shopify/ProductVariant/${id}`),
      country: context.buyer.country ?? null,
    });

    // One bad line stops the whole order, so the shopper never gets a summary
    // that quietly leaves out something they asked for.
    const lines = variantIds.map((variantId, index) => {
      const variant = data.nodes?.[index];
      // The Storefront API resolves only variants of published products.
      if (!variant?.id || !variant.product || !variant.price) {
        throw new ToolError(
          `Variant ${variantId} does not exist. Look each item up with get_product_details first.`,
        );
      }
      const title =
        variant.title && variant.title !== "Default Title"
          ? `${variant.product.title} (${variant.title})`
          : variant.product.title;
      if (!variant.availableForSale) {
        throw new ToolError(
          `"${title}" is out of stock, so nothing was added. Tell the shopper and ask what they want instead.`,
        );
      }
      return { variantId, quantity: quantities.get(variantId)!, title, price: variant.price };
    });

    const totals = lines.map((line) => lineTotal(line.price, line.quantity));
    const itemsTotal = sumMoney(totals);
    const orderItems: OrderItem[] = lines.map(({ variantId, quantity, title }) => ({
      variantId,
      quantity,
      title,
    }));

    return {
      output: {
        status: "summary_shown",
        items: lines.map((line, index) => ({
          item: line.title,
          quantity: line.quantity,
          unitPrice: formatMoney(line.price),
          lineTotal: formatMoney(totals[index]),
        })),
        itemsTotal: itemsTotal ? formatMoney(itemsTotal) : undefined,
        note: onlyTheseItems
          ? "The chat widget is emptying the shopper's cart, putting in only these items and showing an order summary with the buttons to complete the order. Shipping, taxes and discounts are worked out after that. Confirm the items briefly and tell the shopper to check the summary. The order is not placed until they complete it, so do not say it has been placed."
          : "The chat widget is putting these items in the shopper's cart and showing an order summary with the buttons to complete the order. The summary lists everything in the cart, including anything that was already there, so its total can be higher than itemsTotal; say so if the cart held other items. Shipping, taxes and discounts are worked out after that. Confirm the items briefly and tell the shopper to check the summary. The order is not placed until they complete it, so do not say it has been placed.",
      },
      actions: [
        { type: "order" as const, items: orderItems, ...(onlyTheseItems ? { replace: true } : {}) },
      ],
    };
  },
});

const removeFromCart = defineTool({
  name: "remove_from_cart",
  description:
    "Take one item out of the shopper's cart completely. Use when the shopper asks to remove something from their cart or order. Needs the item's variantId, which is listed with the shopper's cart.",
  audiences: ["shopper"],
  schema: z.object({
    variantId: z
      .string()
      .trim()
      .regex(/^\d{1,20}$/, "Use the numeric variantId listed with the shopper's cart."),
  }),
  isAvailable: (context) => context.settings.allowAddToCart,
  async run({ variantId }, context) {
    const line = context.cart?.find((entry) => entry.variantId === variantId);
    // When the cart is known, a variant that is not in it is a mistake worth
    // telling the model about instead of a silent no-op in the browser.
    if (context.cart && !line) {
      throw new ToolError(
        "That item is not in the shopper's cart. Use a variantId from the cart you were shown.",
      );
    }
    return {
      output: {
        status: "removing",
        item: line?.title,
        note: "The chat widget is taking this item out of the shopper's cart now. Confirm briefly.",
      },
      actions: [{ type: "remove_from_cart" as const, variantId, title: line?.title }],
    };
  },
});

const clearCart = defineTool({
  name: "clear_cart",
  description:
    "Empty the shopper's cart. Use only when the shopper asks to clear or empty their cart or to start over.",
  audiences: ["shopper"],
  schema: z.object({}),
  isAvailable: (context) => context.settings.allowAddToCart,
  async run() {
    return {
      output: {
        status: "clearing",
        note: "The chat widget is emptying the shopper's cart now. Confirm briefly and ask what they would like instead.",
      },
      actions: [{ type: "clear_cart" as const }],
    };
  },
});

const startCheckout = defineTool({
  name: "start_checkout",
  description:
    "Show the shopper a summary of what is already in their cart with a button to the store's secure checkout. Use when they want to buy, pay or check out what is in the cart. You cannot take payment or place the order yourself.",
  audiences: ["shopper"],
  schema: z.object({}),
  isAvailable: (context) => context.settings.allowCheckout,
  async run() {
    return {
      output: {
        status: "summary_shown",
        note: "The chat now shows what is in the shopper's cart with a 'Go to checkout' button, or tells them the cart is empty. Tell the shopper to check it and press the button; they pay on the store's checkout page. Do not say an order has been placed.",
      },
      actions: [{ type: "checkout" as const }],
    };
  },
});

// Order lookup limits. Guessing an order number for a known email must stay
// impractical even for someone rotating addresses, so the address is only one
// of four independent keys. Return requests count against the same limits.
const ORDER_LOOKUPS_PER_TURN = 2;
const ORDER_LOOKUPS_PER_ADDRESS = 5; // per 15 minutes
const ORDER_LOOKUPS_PER_EMAIL = 5; // per hour, whoever is asking
const ORDER_LOOKUPS_PER_SHOP = 60; // per hour, all visitors together
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const ORDER_LOOKUP_THROTTLED =
  "Too many order lookups. Ask the shopper to try again later or contact the store.";
const ORDER_NOT_FOUND =
  "No order matches that order number and email. Ask the shopper to double-check both, or to contact the store.";

/** Short non-reversible key, so email addresses are not held in the limiter. */
export function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

interface VerifiedOrder {
  id: string;
  name: string;
  email: string | null;
  processedAt: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string;
  fulfillments: Array<{
    status: string;
    estimatedDeliveryAt: string | null;
    trackingInfo: Array<{ company: string | null; number: string | null; url: string | null }>;
  }>;
}

const orderProofSchema = {
  orderNumber: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^#?[A-Za-z0-9\-_.]+$/, "Order number like 1001 or #1001."),
  email: z.email().max(254),
};

/**
 * Finds the order only if the shopper proved it is theirs by giving both the
 * order number and the checkout email, after applying the lookup throttles.
 * Throws the same error for "no such order" and "wrong email", so it cannot
 * be used to discover which order numbers exist.
 */
async function findVerifiedOrder(
  context: ToolContext,
  orderNumber: string,
  email: string,
): Promise<VerifiedOrder> {
  const wantedName = orderNumber.replace(/^#/, "").toLowerCase();
  const wantedEmail = email.trim().toLowerCase();

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

  const data = await context.admin!<{ orders: { nodes: VerifiedOrder[] } }>(
    ORDER_STATUS_QUERY,
    { query: `name:${wantedName}` },
  );

  // The search is fuzzy, so require an exact match on both fields here.
  const order = data.orders.nodes.find(
    (candidate) =>
      candidate.name.replace(/^#/, "").toLowerCase() === wantedName &&
      (candidate.email ?? "").toLowerCase() === wantedEmail,
  );
  if (!order) throw new ToolError(ORDER_NOT_FOUND);
  return order;
}

const getOrderStatus = defineTool({
  name: "get_order_status",
  description:
    "Check the status and tracking of the shopper's own order. Requires BOTH the order number and the email address used at checkout; ask for whichever is missing before calling.",
  audiences: ["shopper"],
  schema: z.object(orderProofSchema),
  // Off unless the merchant turned it on in the app settings.
  isAvailable: (context) =>
    Boolean(context.admin) && context.settings.orderLookupEnabled,
  async run({ orderNumber, email }, context) {
    const order = await findVerifiedOrder(context, orderNumber, email);

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

interface ReturnableItem {
  fulfillmentLineItemId: string;
  title: string;
  quantity: number;
}

const requestReturn = defineTool({
  name: "request_return",
  description:
    "Ask the store to accept a return for the shopper's own order. Requires BOTH the order number and the checkout email, and a reason. This sends a return REQUEST that the store approves or declines; it does not approve the return or issue a refund. If the order has several items and the shopper has not said which, call it without itemTitle first to get the list, then ask them.",
  audiences: ["shopper"],
  schema: z.object({
    ...orderProofSchema,
    reason: z
      .string()
      .trim()
      .min(3)
      .max(300)
      .describe("Why the shopper wants to return it, in their words."),
    itemTitle: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe("Which item to return, when the order has more than one."),
    quantity: z.number().int().min(1).max(20).default(1),
  }),
  // Off unless the merchant turned it on in the app settings.
  isAvailable: (context) => Boolean(context.admin) && context.settings.allowReturns,
  async run({ orderNumber, email, reason, itemTitle, quantity }, context) {
    const order = await findVerifiedOrder(context, orderNumber, email);

    const data = await context.admin!<{
      returnableFulfillments: {
        nodes: Array<{
          returnableFulfillmentLineItems: {
            nodes: Array<{
              quantity: number;
              fulfillmentLineItem: { id: string; lineItem: { title: string } };
            }>;
          };
        }>;
      };
    }>(RETURNABLE_ITEMS_QUERY, { orderId: order.id });

    const items: ReturnableItem[] = data.returnableFulfillments.nodes
      .flatMap((fulfillment) => fulfillment.returnableFulfillmentLineItems.nodes)
      .filter((item) => item.quantity > 0)
      .map((item) => ({
        fulfillmentLineItemId: item.fulfillmentLineItem.id,
        title: item.fulfillmentLineItem.lineItem.title,
        quantity: item.quantity,
      }));

    if (items.length === 0) {
      throw new ToolError(
        "Nothing on this order can be returned right now. It may not have shipped yet, or a return may already be open. Suggest contacting the store.",
      );
    }

    const wanted = itemTitle?.toLowerCase();
    const matches = wanted
      ? items.filter((item) => item.title.toLowerCase().includes(wanted))
      : items;

    // Never guess which item: with more than one candidate, hand the list back.
    if (matches.length !== 1) {
      return {
        output: {
          status: "need_item",
          note: "No request was sent. Ask the shopper which one item they want to return, then call again with itemTitle.",
          returnableItems: (matches.length ? matches : items).map((item) => ({
            title: item.title,
            quantity: item.quantity,
          })),
        },
      };
    }
    const item = matches[0];

    // One request per order per day, so a repeated message cannot pile up
    // duplicate requests in the merchant's admin.
    const once = context.rateLimiter.hit(
      `return-request:${context.shop}:${order.id}`,
      1,
      ONE_DAY_MS,
      context.now().getTime(),
    );
    if (!once.allowed) {
      throw new ToolError(
        "A return was already requested for this order today. The store will be in touch by email.",
      );
    }

    const result = await context.admin!<{
      returnRequest: {
        return: { name: string; status: string } | null;
        userErrors: Array<{ message: string }>;
      } | null;
    }>(RETURN_REQUEST_MUTATION, {
      input: {
        orderId: order.id,
        returnLineItems: [
          {
            fulfillmentLineItemId: item.fulfillmentLineItemId,
            quantity: Math.min(quantity, item.quantity),
            customerNote: reason,
          },
        ],
      },
    });

    const created = result.returnRequest?.return;
    if (!created) {
      throw new ToolError(
        `The store's system did not accept the return request${
          result.returnRequest?.userErrors[0]
            ? `: ${result.returnRequest.userErrors[0].message}`
            : "."
        } Suggest contacting the store.`,
      );
    }

    return {
      output: {
        status: "requested",
        returnReference: created.name,
        item: item.title,
        quantity: Math.min(quantity, item.quantity),
        note: "The request has been sent to the store for review. Tell the shopper it is a request, not an approval: the store will reply by email with the decision and return instructions. Do not promise a refund.",
      },
    };
  },
});

export const shopperTools: ToolDefinition[] = [
  searchProducts,
  getBestSellers,
  getProductsByPrice,
  getProductDetails,
  listCollections,
  getStorePolicy,
  addToCart,
  removeFromCart,
  clearCart,
  placeOrder,
  startCheckout,
  getOrderStatus,
  requestReturn,
];
