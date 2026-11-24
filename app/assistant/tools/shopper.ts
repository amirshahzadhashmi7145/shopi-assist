/**
 * Tools for the public storefront widget.
 *
 * Everything here is reachable by anonymous visitors, so each tool must only
 * expose what a visitor could already see on the storefront. Catalog data
 * comes from the Storefront API, which only returns published products. The
 * single exception is `get_order_status`, which is opt-in per shop. It is gated
 * on the shopper proving the order is theirs (order number plus the checkout
 * email or the phone number on the order), unless the merchant has also opted
 * in to giving the bare basics for an order number alone.
 */
import { z } from "zod";

import { clientKey } from "../rate-limit";
import { CALLING_CODES } from "../address-rules";
import type { CardVariant, GraphqlFn, KnownOrder, Money, OrderItem, ProductCard } from "../types";
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
  COLLECTION_NEWEST_QUERY,
  COLLECTIONS_QUERY,
  NEWEST_PRODUCTS_QUERY,
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

/**
 * Admin API. The same order fields plus the phone numbers on the order, used
 * only to check a shopper who proves an order with its phone number instead
 * of an email. Kept apart from the query above so that lookups by email keep
 * working on a store where the app may not read phone numbers.
 */
export const ORDER_STATUS_WITH_PHONE_QUERY = `#graphql
  query ShopiAssistOrderStatusWithPhone($query: String!) {
    orders(first: 5, query: $query) {
      nodes {
        name
        email
        phone
        shippingAddress { phone }
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

/** Admin API. One order's state for a return, and what on it can be returned now. */
export const RETURNABLE_ORDER_QUERY = `#graphql
  query ShopiAssistReturnableOrder($orderId: ID!) {
    order(id: $orderId) {
      name
      cancelledAt
      returnStatus
      fulfillments(first: 1) { id }
    }
    returnableFulfillments(orderId: $orderId, first: 5) {
      nodes {
        returnableFulfillmentLineItems(first: 10) {
          nodes {
            quantity
            fulfillmentLineItem {
              lineItem { title }
            }
          }
        }
      }
    }
  }
`;

/**
 * Admin API. Shopify's own reason categories: a return request must name one
 * ("Return reason can't be blank" otherwise).
 */
export const RETURN_REASONS_QUERY = `#graphql
  query ShopiAssistReturnReasons($handles: [String!]) {
    returnReasonDefinitions(first: 5, handles: $handles) {
      nodes { id handle }
    }
  }
`;

/** The categories the assistant may choose from, and Shopify's handle for each. */
const RETURN_REASON_HANDLES = {
  changed_my_mind: "changed-my-mind",
  not_as_described: "item-not-as-described",
  wrong_item: "received-the-wrong-item",
  damaged_or_defective: "damaged-or-defective",
  too_small: "too-small",
  too_big: "too-big",
  other: "other-reason",
} as const;
type ReturnReasonKind = keyof typeof RETURN_REASON_HANDLES;

/** The reasons as a shopper is offered them; "other" is theirs to type. */
export const RETURN_REASON_LABELS = [
  "Changed my mind",
  "Not as described",
  "Wrong item",
  "Damaged or defective",
  "Too small",
  "Too big",
] as const;

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
  tags?: string[] | null;
  options?: Array<{ name: string; optionValues: Array<{ name: string }> }> | null;
  featuredImage: { url: string; altText: string | null } | null;
  priceRange: { minVariantPrice: Money; maxVariantPrice: Money };
  compareAtPriceRange: { maxVariantPrice: Money };
  variants: {
    nodes: Array<{ id: string; title: string; availableForSale: boolean; price: Money }>;
  };
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

/** "$24.95", as the cards show it, or "24.95 XYZ" for a currency this server cannot format. */
function formatMoney(money: Money): string {
  const amount = Number(money.amount);
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: money.currencyCode }).format(amount);
  } catch {
    return `${money.amount} ${money.currencyCode}`;
  }
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

/** The most versions of one product a card offers to pick from. */
const MAX_CARD_VARIANTS = 12;

/**
 * The versions a shopper can pick between, or none when the product comes in
 * one version only or in more than a card can show. The query asks for one
 * more than the limit, which is how "more" is known.
 */
function variantChoices(product: StorefrontProduct): CardVariant[] {
  const variants = product.variants.nodes;
  if (variants.length < 2 || variants.length > MAX_CARD_VARIANTS) return [];
  return variants.flatMap((variant) => {
    const id = numericId(variant.id);
    return id && variant.title && variant.price
      ? [{ id, title: variant.title, price: variant.price, available: variant.availableForSale }]
      : [];
  });
}

export function toProductCard(product: StorefrontProduct): ProductCard {
  const price = product.priceRange.minVariantPrice;
  const compareAt = product.compareAtPriceRange?.maxVariantPrice;
  const onSale = compareAt && Number(compareAt.amount) > Number(price.amount);
  const variants = product.variants.nodes;
  const choices = variantChoices(product);

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
    ...(choices.length > 1 ? { variants: choices } : {}),
  };
}

/** Compact, model-facing view of a product. */
/**
 * What the store says a product comes in: "Color: Ice, Dawn, Powder". A
 * product with nothing to choose has Shopify's placeholder option, left out.
 */
function productOptions(product: StorefrontProduct): Record<string, string> | undefined {
  const options: Record<string, string> = {};
  for (const option of product.options ?? []) {
    const values = (option.optionValues ?? []).map((value) => value.name).filter(Boolean);
    if (!option.name || !values.length) continue;
    if (option.name === "Title" && values.length === 1 && values[0] === "Default Title") continue;
    options[option.name.slice(0, 40)] = values.slice(0, 12).join(", ").slice(0, 200);
  }
  return Object.keys(options).length ? options : undefined;
}

/**
 * Everything the store's own data says about a product, as one lower-case
 * text: what a claim about it has to be found in.
 */
function productEvidence(product: StorefrontProduct): string {
  return [
    product.title,
    product.description,
    product.productType,
    product.vendor,
    ...(product.tags ?? []),
    ...(product.options ?? []).flatMap((option) => [
      option.name,
      ...(option.optionValues ?? []).map((value) => value.name),
    ]),
    ...product.variants.nodes.map((variant) => variant.title),
    product.featuredImage?.altText ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

// Words in a search that say nothing about a product.
const SEARCH_FILLER = new Set(["and", "any", "for", "from", "some", "the", "with", "your"]);

/** The words of a search that are worth looking for in a product's data. */
function searchWords(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !SEARCH_FILLER.has(word));
  return [...new Set(words)];
}

/** "snowboards" is found in "snowboard": plurals do not count as missing. */
function mentions(evidence: string, word: string): boolean {
  if (evidence.includes(word)) return true;
  const stem = word.length > 4 ? word.replace(/(es|s)$/, "") : word;
  return stem !== word && evidence.includes(stem);
}

function toProductSummary(product: StorefrontProduct) {
  const { minVariantPrice, maxVariantPrice } = product.priceRange;
  const priceVaries = minVariantPrice.amount !== maxVariantPrice.amount;
  const choices = variantChoices(product);
  const tags = (product.tags ?? []).filter(Boolean).slice(0, 12);
  const picture = product.featuredImage?.altText?.replace(/\s+/g, " ").trim().slice(0, 180);
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
    // What the store's data says it is like. A colour, size, material or
    // feature is only true of the product if it is found in these.
    options: productOptions(product),
    tags: tags.length ? tags : undefined,
    picture: picture || undefined,
    // The same versions, with the same numbers, as the product's card lets
    // the shopper pick from.
    versions: choices.length > 1
      ? choices.map((choice, index) => ({
          number: index + 1,
          title: choice.title,
          price: formatMoney(choice.price),
          variantId: choice.id,
          soldOut: choice.available ? undefined : true,
        }))
      : undefined,
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

// What a filter on a search may narrow by: Shopify's ProductFilter fields.
const FILTER_KEYS = new Set([
  "available",
  "category",
  "price",
  "productMetafield",
  "productType",
  "productVendor",
  "tag",
  "taxonomyMetafield",
  "variantMetafield",
  "variantOption",
]);

/** A filter as the model passed it back: kept only if it is one Shopify could have offered. */
function parseFilter(text: string): Record<string, unknown> | null {
  try {
    const filter: unknown = JSON.parse(text);
    if (!filter || typeof filter !== "object" || Array.isArray(filter)) return null;
    const keys = Object.keys(filter);
    return keys.length === 1 && FILTER_KEYS.has(keys[0]) ? (filter as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface SearchFacet {
  label: string;
  type: string;
  values: Array<{ label: string; count: number; input: unknown }>;
}

/**
 * The store's filters that apply to a search's results, in a form the model
 * can read and hand back: "Color" with "White (3 products)" and the filter
 * that selects it. Price sliders are left out; the price tool covers those.
 */
function searchFacets(facets: SearchFacet[] | null | undefined) {
  const found = (facets ?? [])
    .filter((facet) => facet.type !== "PRICE_RANGE" && facet.label)
    .map((facet) => ({
      name: facet.label.slice(0, 40),
      values: (facet.values ?? [])
        .filter((value) => value.count > 0 && value.label && value.input)
        .slice(0, 12)
        .map((value) => ({
          value: value.label.slice(0, 40),
          products: value.count,
          filter: (typeof value.input === "string" ? value.input : JSON.stringify(value.input)).slice(0, 400),
        })),
    }))
    .filter((facet) => facet.values.length)
    .slice(0, 8);
  return found.length ? found : undefined;
}

/** How many products are looked through when only some of them will qualify. */
const EVIDENCE_POOL = 20;

/**
 * "teal or turquoise" is met by a product whose data mentions either;
 * "long sleeve" needs both words. Empty when the requirement says nothing.
 */
function requirementMet(evidence: string, requirement: string): boolean {
  const alternatives = requirement
    .toLowerCase()
    .split(/\s+or\s+|[|,/]/)
    .map((alternative) => alternative.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2))
    .filter((words) => words.length > 0);
  return alternatives.some((words) => words.every((word) => mentions(evidence, word)));
}

const searchProducts = defineTool({
  name: "search_products",
  description:
    "Search this store's catalog. Put the kind of product in 'query' ('snowboard', 'rain jacket') and anything specific the shopper asked for (a colour, material, size, feature) in 'mustMention': only products whose own data mentions it are returned, so the results are real matches. Without 'mustMention' it is a plain keyword search whose results match some of the words, not necessarily all; each result then lists the search words its data does not mention under 'doesNotMention'. The result also lists the store's own 'filters' for these products (for example a colour with how many products have it); passing a value's 'filter' in 'filters' narrows the search the way the store's own filter does.",
  audiences: ["shopper"],
  schema: z.object({
    query: z.string().trim().min(1).max(200).describe("Search keywords."),
    limit: limitSchema,
    filters: z
      .array(z.string().max(400))
      .max(6)
      .optional()
      .describe(
        "Narrow the search to products that have these. Each entry is a 'filter' copied exactly from the 'filters' of an earlier search_products result.",
      ),
    inStockOnly: z.boolean().optional().describe("True leaves out products that are sold out."),
    mustMention: z
      .array(z.string().trim().min(2).max(60))
      .max(4)
      .optional()
      .describe(
        "What the shopper specifically asked for, one entry each. A product is returned only if its own data (title, description, options, versions, tags, picture description) mentions every entry. Give alternatives and close synonyms in one entry with 'or': ['teal or turquoise'], ['grey or gray', 'waterproof'].",
      ),
  }),
  isAvailable: (context) => Boolean(context.storefront),
  async run({ query, limit, filters, inStockOnly, mustMention }, context) {
    const chosen = (filters ?? []).map(parseFilter);
    if (chosen.includes(null)) {
      throw new ToolError(
        "Copy each filter exactly from the 'filters' of a search_products result. One of these is not a filter from there.",
      );
    }
    const productFilters = [
      ...(chosen as Array<Record<string, unknown>>),
      ...(inStockOnly ? [{ available: true }] : []),
    ];

    const data = await context.storefront!<{
      search: {
        totalCount?: number;
        productFilters?: SearchFacet[] | null;
        nodes: Array<Partial<StorefrontProduct>>;
      };
    }>(SEARCH_PRODUCTS_QUERY, {
      query,
      // Only some will have what was asked for: look through more of them.
      first: mustMention?.length ? EVIDENCE_POOL : limit,
      filters: productFilters.length ? productFilters : null,
      ...buyerVariables(context),
    });

    const found = data.search.nodes.filter(isProduct);
    if (mustMention?.length) {
      const asked = mustMention.join(", ");
      const matching = found.filter((product) => {
        const evidence = productEvidence(product);
        return mustMention.every((requirement) => requirementMet(evidence, requirement));
      });
      if (matching.length) {
        const result = productListResult(matching.slice(0, limit), { query, mustMention });
        return {
          ...result,
          output: {
            ...result.output,
            checked: found.length,
            matching: matching.length,
            note: `Each of these mentions ${asked} in its own data. ${found.length - matching.length} other result(s) did not and were left out.`,
          },
        };
      }
      // Nothing qualifies. The closest results go back clearly marked, so they
      // can be offered as something else, never as what was asked for.
      const others = productListResult(found.slice(0, 3));
      return {
        cards: others.cards,
        output: {
          query,
          mustMention,
          checked: found.length,
          matching: 0,
          count: 0,
          products: [],
          note: `No product in this store's results for "${query}" mentions ${asked} anywhere in its own data. Tell the shopper you could not find any. You may offer 'others' as alternatives, saying what they actually are.`,
          others: others.output.products,
        },
      };
    }

    const products = found;
    // Which of the words asked for each product's own data does not have.
    const words = searchWords(query);
    const missing = products.map((product) => {
      const evidence = productEvidence(product);
      return words.filter((word) => !mentions(evidence, word));
    });
    const nowhere = words.filter((word) => products.length > 0 && missing.every((list) => list.includes(word)));

    const result = productListResult(products, { query });
    return {
      ...result,
      output: {
        ...result.output,
        filtered: productFilters.length ? true : undefined,
        products: result.output.products.map((summary, index) => ({
          ...summary,
          doesNotMention: missing[index].length ? missing[index] : undefined,
        })),
        filters: searchFacets(data.search.productFilters),
        note: nowhere.length
          ? `None of these products mentions ${nowhere.map((word) => `"${word}"`).join(" or ")} anywhere in its title, description, options, tags or picture. They matched other words of the search. Do not present them as ${nowhere.join(" ")} products.`
          : undefined,
      },
    };
  },
});

const getBestSellers = defineTool({
  name: "get_best_sellers",
  description:
    "List the store's best-selling (most popular) products, optionally within one collection. Use for 'top sellers', 'most popular', 'what do people buy' questions. Not for 'latest' or 'new' products: get_newest_products answers those.",
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

const getNewestProducts = defineTool({
  name: "get_newest_products",
  description:
    "List the products added to the store most recently, newest first, optionally within one collection. Use for every 'latest', 'newest', 'new arrivals', 'what's new' or 'just in' question, and call them the newest products, not best sellers.",
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
      }>(COLLECTION_NEWEST_QUERY, {
        handle: collectionHandle,
        first: limit,
        ...buyerVariables(context),
      });
      if (!data.collection) {
        throw new ToolError(`No collection with handle "${collectionHandle}".`);
      }
      return productListResult(data.collection.products.nodes, {
        collection: data.collection.title,
        rankedBy: "newest first",
      });
    }

    const data = await context.storefront!<{
      products: { nodes: Array<Partial<StorefrontProduct>> };
    }>(NEWEST_PRODUCTS_QUERY, { first: limit, ...buyerVariables(context) });
    return productListResult(data.products.nodes, {
      rankedBy: "newest first",
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
    "Add one product variant to the shopper's cart, for a shopper who wants to keep shopping. Only call this when the shopper asks to add an item to the cart. When they say they want to buy or order it, start the order instead. Needs a variantId: one given with a product's versions, or from get_product_details.",
  audiences: ["shopper"],
  schema: z.object({
    variantId: z
      .string()
      .trim()
      .regex(/^\d{1,20}$/, "Use a numeric variantId given with a product's versions or by get_product_details."),
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
            .regex(/^\d{1,20}$/, "Use a numeric variantId given with a product's versions or by get_product_details."),
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

/** How many of the shopper's most recent orders are checked for a return. */
const MAX_RETURN_CHECKS = 6;

export interface ReturnCheck {
  /** "#1008" */
  name: string;
  /** What can be returned from it right now. Empty when nothing can. */
  items: Array<{ title: string; quantity: number }>;
  /** Why nothing can be returned, when nothing can. */
  reason?: string;
}

/**
 * Asks Shopify, now, which of these orders have something that can be
 * returned. Only for orders already known to be the shopper's own.
 */
export async function checkReturnable(admin: GraphqlFn, orders: KnownOrder[]): Promise<ReturnCheck[]> {
  const checks = await Promise.all(
    orders.slice(0, MAX_RETURN_CHECKS).map(async (known): Promise<ReturnCheck | null> => {
      try {
        const data = await admin<{
          order: {
            name: string;
            cancelledAt: string | null;
            returnStatus: string;
            fulfillments: Array<{ id: string }>;
          } | null;
          returnableFulfillments: {
            nodes: Array<{
              returnableFulfillmentLineItems: {
                nodes: Array<{ quantity: number; fulfillmentLineItem: { lineItem: { title: string } } }>;
              };
            }>;
          };
        }>(RETURNABLE_ORDER_QUERY, { orderId: known.id });
        if (!data.order) return null;

        const items = data.returnableFulfillments.nodes
          .flatMap((fulfillment) => fulfillment.returnableFulfillmentLineItems.nodes)
          .filter((item) => item.quantity > 0)
          .map((item) => ({ title: item.fulfillmentLineItem.lineItem.title, quantity: item.quantity }));
        if (items.length) return { name: known.name, items };

        const status = data.order.returnStatus;
        return {
          name: known.name,
          items: [],
          reason: data.order.cancelledAt
            ? "it was cancelled"
            : data.order.fulfillments.length === 0
              ? "it has not shipped yet"
              : status === "RETURN_REQUESTED"
                ? "a return request for it is already waiting for the store's answer"
                : status === "IN_PROGRESS" || status === "INSPECTION_COMPLETE"
                  ? "a return for it is already in progress"
                  : status === "RETURNED"
                    ? "it has already been returned"
                    : "nothing on it can be returned",
        };
      } catch {
        // An order that could not be checked is left out rather than guessed about.
        return null;
      }
    }),
  );
  return checks.filter((check): check is ReturnCheck => check !== null);
}

const listReturnableOrders = defineTool({
  name: "list_returnable_orders",
  description:
    "For a shopper who wants to return something and has not said which order: checks, right now, which of their own orders have items that can be returned, and why each of the others cannot. Call it before asking which order, and offer only the orders it lists as returnable.",
  audiences: ["shopper"],
  schema: z.object({}),
  // Only for orders already known to be theirs: on their account, placed or proved in this chat.
  isAvailable: (context) =>
    Boolean(context.admin) && context.settings.allowReturns && Boolean(context.knownOrders?.length),
  async run(_input, context) {
    const checks = await checkReturnable(context.admin!, context.knownOrders ?? []);
    const returnable = checks.filter((check) => check.items.length > 0);
    context.turn.returnableOrders = returnable.map((check) => check.name);
    return {
      output: {
        returnable: returnable.map((check) => ({ order: check.name, items: check.items })),
        cannotBeReturned: checks
          .filter((check) => check.items.length === 0)
          .map((check) => ({ order: check.name, because: check.reason })),
        note: returnable.length
          ? "Offer only the returnable orders. If the shopper names one of the others, tell them why it cannot be returned."
          : "None of the shopper's orders can be returned right now. Tell them so, with the reasons, instead of asking which order.",
      },
    };
  },
});

const offerChoices = defineTool({
  name: "offer_choices",
  description:
    "Show the possible answers to the question you are about to ask as buttons under your reply, so the shopper can tap one instead of typing. Use it whenever you ask the shopper to pick from a short fixed list: which of their orders, a reason, a size, yes or no. Then ask the question in one short sentence and do not list the options in your reply. One question at a time.",
  audiences: ["shopper"],
  schema: z.object({
    options: z
      .array(z.string().trim().min(1).max(60))
      .min(2)
      .max(8)
      .describe("The answers to choose from, each a few words, as the shopper would say them."),
    allowOther: z
      .boolean()
      .default(false)
      .describe("True adds an 'Other' button that lets the shopper type their own answer."),
  }),
  // Only for a widget that can draw the buttons; an older one would show nothing.
  isAvailable: (context) => Boolean(context.clientSupports?.includes("choices")),
  async run({ options, allowOther }) {
    // The same answer twice is one button.
    const unique = [...new Map(options.map((option) => [option.toLowerCase(), option])).values()];
    return {
      output: {
        status: "buttons_shown",
        note: "The options are shown as buttons under your reply. Ask the question in one short sentence without listing them. The shopper's next message is the option they pressed, or their own words.",
      },
      actions: [{ type: "choices" as const, options: unique, ...(allowOther ? { other: true } : {}) }],
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
const ORDER_LOOKUPS_PER_TURN = 2; // different orders in one message
const ORDER_CALLS_PER_TURN = 6; // lookups in one message, the same order included
const ORDER_LOOKUPS_PER_ADDRESS = 5; // per 15 minutes
const ORDER_LOOKUPS_PER_EMAIL = 5; // per hour, whoever is asking
const ORDER_LOOKUPS_PER_SHOP = 60; // per hour, all visitors together
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const RETURN_REQUESTS_PER_ORDER_PER_DAY = 3;
const ORDER_LOOKUP_THROTTLED =
  "Too many order lookups. Ask the shopper to try again later or contact the store.";
/** How much looser the lookup limits are on a development store. */
const TEST_STORE_ROOM = 50;

/**
 * One message may look into a couple of orders, and into the same order a few
 * times: its status, then its items, then the change.
 */
function countTurnLookup(context: ToolContext, wantedName: string): void {
  context.turn.orderLookups += 1;
  const names = (context.turn.orderNames ??= []);
  if (!names.includes(wantedName)) names.push(wantedName);
  if (names.length > ORDER_LOOKUPS_PER_TURN || context.turn.orderLookups > ORDER_CALLS_PER_TURN) {
    throw new ToolError(
      "Only a couple of orders can be checked per message. Ask the shopper which single order they mean.",
    );
  }
}

type LookupLimit = [key: string, max: number, windowMs: number];

/**
 * Counts one order lookup against each limit, or throws when one is used up.
 * A development store then gets a second, much larger allowance, so that
 * someone testing the chat is not locked out after a handful of orders.
 * Whether the store is one is asked only when a limit is reached.
 */
async function countLookup(context: ToolContext, limits: LookupLimit[]): Promise<void> {
  const nowMs = context.now().getTime();
  for (const [key, max, windowMs] of limits) {
    if (context.rateLimiter.hit(key, max, windowMs, nowMs).allowed) continue;
    const extra =
      (await context.isTestStore?.()) &&
      context.rateLimiter.hit(`${key}:test`, max * TEST_STORE_ROOM, windowMs, nowMs).allowed;
    if (!extra) throw new ToolError(ORDER_LOOKUP_THROTTLED);
  }
}
const ORDER_NOT_FOUND =
  "No order matches that order number with that email or phone number. Ask the shopper to double-check both, or to contact the store.";

/** A phone number as digits only, without the zeros people put in front. */
function phoneDigits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "").replace(/^0+/, "");
}

/**
 * Whether two phone numbers are the same line. People write the same number
 * with or without the country code ("+92 319 875 4964" and "0319 8754964"),
 * so one may be the other with a country calling code in front. Nothing else
 * may differ: an extra or missing digit anywhere, or digits in front that
 * are not a calling code, is a different number.
 */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const [shorter, longer] = [phoneDigits(a), phoneDigits(b)].sort(
    (left, right) => left.length - right.length,
  );
  if (shorter.length < 7) return false;
  if (shorter === longer) return true;
  return longer.endsWith(shorter) && CALLING_CODES.has(longer.slice(0, longer.length - shorter.length));
}

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
  /**
   * Set when the shopper gave an email that is not the order's, for an order
   * that needed no proof. The tools pass it on, so the assistant never says
   * a wrong email was accepted.
   */
  proofNote?: string;
}

export const orderProofSchema = {
  orderNumber: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^#?[A-Za-z0-9\-_.]+$/, "Order number like 1001 or #1001."),
  // Anything that is not an email address counts as "none given" instead of
  // failing the call. The model sometimes passes the "[email removed]"
  // placeholder it sees in the transcript; for an order this chat already
  // knows that must not matter, and for any other the tool asks for proof.
  email: z
    .preprocess(
      (value) =>
        typeof value === "string" && z.email().max(254).safeParse(value.trim()).success
          ? value.trim()
          : undefined,
      z.string().optional(),
    )
    .describe("The email used at checkout, when the shopper gives one."),
  phone: z
    .string()
    .trim()
    .max(30)
    .optional()
    .describe(
      "The phone number used on the order. Proves the order just as the email does, for shoppers who gave no email.",
    ),
};

const ORDER_NUMBER_NOT_FOUND =
  "No order has that number. Ask the shopper to check it, or to contact the store.";

const ORDER_NEEDS_EMAIL =
  "This order has not been proved in this chat yet, so the email address or the phone number used on the order is needed too. Ask the shopper for either one, then call again with it.";

/**
 * Finds the order only if it is the shopper's: either the server already tied
 * it to this conversation (it was placed here, or proved earlier in the
 * chat), or the shopper gives both the order number and the checkout email.
 * The lookup throttles apply to the second case, which is the one that can be
 * used to guess. It throws the same error for "no such order" and "wrong
 * email", so it cannot be used to discover which order numbers exist.
 */
export async function findVerifiedOrder(
  context: ToolContext,
  orderNumber: string,
  email: string | undefined,
  phone?: string,
): Promise<VerifiedOrder> {
  const wantedName = orderNumber.replace(/^#/, "").toLowerCase();
  const wantedEmail = (email ?? "").trim().toLowerCase();
  const wantedPhone = phoneDigits(phone);

  countTurnLookup(context, wantedName);

  const known = context.knownOrders?.find(
    (order) => order.name.replace(/^#/, "").toLowerCase() === wantedName,
  );
  if (known) {
    const data = await context.admin!<{ orders: { nodes: VerifiedOrder[] } }>(
      ORDER_STATUS_QUERY,
      { query: `name:${wantedName}` },
    );
    // Matched on the id the server recorded, not on the name alone.
    const order = data.orders.nodes.find((candidate) => candidate.id === known.id);
    if (!order) throw new ToolError(ORDER_NOT_FOUND);
    // The order is theirs without any proof. An email or phone number given
    // anyway is still looked at, so a wrong one is never passed off as
    // having been checked.
    let mismatch = wantedEmail ? (order.email ?? "").toLowerCase() !== wantedEmail : false;
    if (!wantedEmail && wantedPhone) {
      // The phone numbers are a separate read; when it is not allowed, nothing is claimed.
      const phones = await context.admin!<{
        orders: {
          nodes: Array<{ id: string; phone?: string | null; shippingAddress?: { phone: string | null } | null }>;
        };
      }>(ORDER_STATUS_WITH_PHONE_QUERY, { query: `name:${wantedName}` }).catch(() => null);
      const withPhones = phones?.orders.nodes.find((candidate) => candidate.id === known.id);
      mismatch = Boolean(
        withPhones &&
          !samePhone(withPhones.phone, wantedPhone) &&
          !samePhone(withPhones.shippingAddress?.phone, wantedPhone),
      );
    }
    if (mismatch) {
      return {
        ...order,
        proofNote: `The ${wantedEmail ? "email address" : "phone number"} the shopper gave is not the one on this order. It was not needed and was not used: the order is known to be theirs because it is ${
          known.source === "customer"
            ? "on the account they are signed in to"
            : known.source === "placed"
              ? "one they placed in this chat"
              : "one they already proved in this chat"
        }. Tell them that plainly, and do not say it was accepted or verified.`,
      };
    }
    return order;
  }
  if (!wantedEmail && !wantedPhone) throw new ToolError(ORDER_NEEDS_EMAIL);
  if (!wantedEmail && wantedPhone.length < 7) {
    throw new ToolError("That phone number looks incomplete. Ask the shopper for the full number.");
  }
  // An email, when given, is what is checked; the phone is the fallback.
  const proof = wantedEmail || wantedPhone;

  await countLookup(context, [
    [
      `order-lookup:ip:${context.shop}:${clientKey(context.buyer.ip)}`,
      ORDER_LOOKUPS_PER_ADDRESS,
      FIFTEEN_MINUTES_MS,
    ],
    [
      `order-lookup:email:${context.shop}:${fingerprint(proof)}`,
      ORDER_LOOKUPS_PER_EMAIL,
      ONE_HOUR_MS,
    ],
    [`order-lookup:shop:${context.shop}`, ORDER_LOOKUPS_PER_SHOP, ONE_HOUR_MS],
  ]);

  const data = await context.admin!<{
    orders: {
      nodes: Array<VerifiedOrder & { phone?: string | null; shippingAddress?: { phone: string | null } | null }>;
    };
  }>(wantedEmail ? ORDER_STATUS_QUERY : ORDER_STATUS_WITH_PHONE_QUERY, {
    query: `name:${wantedName}`,
  });

  // The search is fuzzy, so require an exact match on both fields here.
  const order = data.orders.nodes.find(
    (candidate) =>
      candidate.name.replace(/^#/, "").toLowerCase() === wantedName &&
      (wantedEmail
        ? (candidate.email ?? "").toLowerCase() === wantedEmail
        : samePhone(candidate.phone, wantedPhone) ||
          samePhone(candidate.shippingAddress?.phone, wantedPhone)),
  );
  if (!order) throw new ToolError(ORDER_NOT_FOUND);
  // Proved once: follow-up questions in this chat need no proof again.
  await context.rememberOrder?.({ id: order.id, name: order.name });
  return order;
}

/**
 * Finds an order by its number alone. Only used when the merchant has opted
 * in, and only for the basics: an order number proves nothing about who is
 * asking, so the caller must not hand back anything personal. The per-address
 * and per-shop throttles still apply, which slows down walking through order
 * numbers but does not prevent it. That trade-off is the merchant's choice.
 */
async function findOrderByNumber(
  context: ToolContext,
  orderNumber: string,
): Promise<VerifiedOrder> {
  const wantedName = orderNumber.replace(/^#/, "").toLowerCase();

  countTurnLookup(context, wantedName);
  await countLookup(context, [
    [
      `order-lookup:ip:${context.shop}:${clientKey(context.buyer.ip)}`,
      ORDER_LOOKUPS_PER_ADDRESS,
      FIFTEEN_MINUTES_MS,
    ],
    [`order-lookup:shop:${context.shop}`, ORDER_LOOKUPS_PER_SHOP, ONE_HOUR_MS],
  ]);

  const data = await context.admin!<{ orders: { nodes: VerifiedOrder[] } }>(
    ORDER_STATUS_QUERY,
    { query: `name:${wantedName}` },
  );
  // The search is fuzzy, so require an exact match on the number.
  const order = data.orders.nodes.find(
    (candidate) => candidate.name.replace(/^#/, "").toLowerCase() === wantedName,
  );
  if (!order) throw new ToolError(ORDER_NUMBER_NOT_FOUND);
  return order;
}

const getOrderStatus = defineTool({
  name: "get_order_status",
  description:
    "Check the status of the shopper's order by its order number. Whether proof is also needed (the email address or the phone number used on the order, either one) depends on the store, and your instructions say which. Proof is never needed for an order placed or already proved earlier in this chat. The tracking number and link are only returned for such an order or when proof is given.",
  audiences: ["shopper"],
  schema: z.object(orderProofSchema),
  // Off unless the merchant turned it on in the app settings.
  isAvailable: (context) =>
    Boolean(context.admin) && context.settings.orderLookupEnabled,
  async run({ orderNumber, email, phone }, context) {
    const wantedName = orderNumber.replace(/^#/, "").toLowerCase();
    const proved =
      Boolean(email) ||
      Boolean(phone) ||
      Boolean(
        context.knownOrders?.some(
          (known) => known.name.replace(/^#/, "").toLowerCase() === wantedName,
        ),
      );

    // The merchant's opt-in: the basics from the number alone. No tracking
    // number or link, since those lead to where the parcel is going.
    if (!proved && context.settings.orderLookupByNumber) {
      const order = await findOrderByNumber(context, orderNumber);
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
            carrier: fulfillment.trackingInfo[0]?.company ?? undefined,
          })),
          note: "Basic status only, and nothing else is known about this order: not what is in it, and not whether anything can be returned. Never name its items or say it can be returned from this. The tracking number and link are shared when the shopper also gives the email address or the phone number used on the order: offer that if they want to track the parcel.",
        },
      };
    }

    const order = await findVerifiedOrder(context, orderNumber, email, phone);

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
        aboutProof: order.proofNote,
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
    "Check or ask for a return of the shopper's own order. Call it as soon as you have the order number, with whatever the shopper has given: it answers from the order as it is right now. Without a reason it only checks, and sends nothing: it says whether an email address or phone number is still needed to prove the order is theirs (neither is needed for an order placed or already proved earlier in this chat, or one on the account of a shopper who is signed in), which items on the order can be returned, or exactly why nothing can. With a reason and the items it sends the store a return REQUEST, which the store approves or declines; it does not approve the return or issue a refund. One request can hold one item, several ('items') or everything returnable ('allItems'): send them together, never one call per item.",
  audiences: ["shopper"],
  schema: z.object({
    ...orderProofSchema,
    reason: z
      .string()
      .trim()
      .max(300)
      .optional()
      .describe(
        "Why the shopper wants to return it, in their words. Leave it out to check first: the tool then says whether the order is theirs and what on it can be returned, and sends nothing.",
      ),
    reasonKind: z
      .enum(Object.keys(RETURN_REASON_HANDLES) as [ReturnReasonKind, ...ReturnReasonKind[]])
      .default("other")
      .describe("The category closest to their reason. Use 'other' when none fits."),
    itemTitle: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe("Which item to return, when it is just one of several on the order."),
    quantity: z.number().int().min(1).max(20).default(1),
    items: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(200),
          quantity: z.number().int().min(1).max(20).default(1),
        }),
      )
      .max(10)
      .optional()
      .describe("Several items to return in this one request, each with how many."),
    allItems: z
      .boolean()
      .default(false)
      .describe("True returns everything on the order that can be returned."),
  }),
  // Off unless the merchant turned it on in the app settings.
  isAvailable: (context) => Boolean(context.admin) && context.settings.allowReturns,
  async run(
    { orderNumber, email, phone, reason, reasonKind, itemTitle, quantity, items: several, allItems },
    context,
  ) {
    const order = await findVerifiedOrder(context, orderNumber, email, phone);

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
      // Say which it is, from the order as it is now, so the shopper is not
      // sent to the store for nothing and the model has nothing to guess.
      const [check] = await checkReturnable(context.admin!, [
        { id: order.id, name: order.name, source: "verified" },
      ]);
      const because =
        check?.reason ??
        (order.cancelledAt
          ? "it was cancelled"
          : order.fulfillments.length === 0
            ? "it has not shipped yet"
            : "nothing on it can be returned");
      throw new ToolError(
        `Order ${order.name} cannot be returned right now because ${because}. Tell the shopper exactly that and give no other reason.${
          because === "it has not shipped yet"
            ? context.settings.allowOrderCancel
              ? " It can still be cancelled: offer to cancel it instead, and do that with your cancel tool if they agree."
              : " A return can be requested once it has arrived."
            : because.startsWith("a return")
              ? " The store will be in touch by email about that return."
              : " Suggest contacting the store."
        }`,
      );
    }

    // Asked only what can be returned: say so, and send nothing yet.
    if (!reason || reason.length < 3) {
      return {
        output: {
          status: "need_reason",
          order: order.name,
          aboutProof: order.proofNote,
          note: "No request was sent. The order is the shopper's and these are the only items on it that can be returned right now: name no others. Ask which of them they want to return (when there are several) and why, then call again once with the reason and the items.",
          returnableItems: items.map((item) => ({ title: item.title, quantity: item.quantity })),
        },
      };
    }

    // What goes into the request: everything, the items named, or the one item.
    const needItem = (candidates: ReturnableItem[]) => ({
      output: {
        status: "need_item",
        aboutProof: order.proofNote,
        note: "No request was sent. Ask the shopper which items they want to return (one, several, or all of them), then call again ONCE with all of them: 'allItems' for everything, 'items' for several, or 'itemTitle' for one.",
        returnableItems: candidates.map((item) => ({ title: item.title, quantity: item.quantity })),
      },
    });
    const find = (title: string) =>
      items.filter((item) => item.title.toLowerCase().includes(title.toLowerCase()));

    let chosen: Array<{ item: ReturnableItem; quantity: number }>;
    if (allItems) {
      chosen = items.map((item) => ({ item, quantity: item.quantity }));
    } else if (several?.length) {
      chosen = [];
      for (const wantedItem of several) {
        const found = find(wantedItem.title);
        // Never guess which item: anything unclear hands the list back.
        if (found.length !== 1 || chosen.some((entry) => entry.item === found[0])) return needItem(items);
        chosen.push({ item: found[0], quantity: Math.min(wantedItem.quantity, found[0].quantity) });
      }
    } else {
      const matches = itemTitle ? find(itemTitle) : items;
      if (matches.length !== 1) return needItem(matches.length ? matches : items);
      chosen = [{ item: matches[0], quantity: Math.min(quantity, matches[0].quantity) }];
    }

    // Shopify wants one of its own reason categories with every request.
    const handle = RETURN_REASON_HANDLES[reasonKind];
    const reasons = await context.admin!<{
      returnReasonDefinitions: { nodes: Array<{ id: string; handle: string }> };
    }>(RETURN_REASONS_QUERY, { handles: [...new Set([handle, RETURN_REASON_HANDLES.other])] });
    const definitions = reasons.returnReasonDefinitions?.nodes ?? [];
    const definition =
      definitions.find((candidate) => candidate.handle === handle) ??
      definitions.find((candidate) => candidate.handle === RETURN_REASON_HANDLES.other);

    // Shopify itself stops the same item being requested twice: an item with
    // a request waiting is no longer returnable. This only keeps one order
    // from being used to pile requests into the merchant's admin. A request
    // that Shopify turns down does not count.
    const onceKey = `return-requested:${context.shop}:${order.id}`;
    const once = context.rateLimiter.hit(
      onceKey,
      RETURN_REQUESTS_PER_ORDER_PER_DAY,
      ONE_DAY_MS,
      context.now().getTime(),
    );
    if (!once.allowed) {
      throw new ToolError(
        "Several return requests were already sent for this order today, and another cannot be sent from the chat today. Nothing was sent now. If more items need returning, the shopper should contact the store. Do not say a return is in progress for items that were not in those requests.",
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
        returnLineItems: chosen.map((entry) => ({
          fulfillmentLineItemId: entry.item.fulfillmentLineItemId,
          quantity: entry.quantity,
          customerNote: reason,
          ...(definition ? { returnReasonDefinitionId: definition.id } : {}),
        })),
      },
    }).catch((error: unknown) => {
      context.rateLimiter.forget(onceKey);
      throw error;
    });

    const created = result.returnRequest?.return;
    if (!created) {
      context.rateLimiter.forget(onceKey);
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
        // One item reads as before; several are listed.
        ...(chosen.length === 1
          ? { item: chosen[0].item.title, quantity: chosen[0].quantity }
          : { items: chosen.map((entry) => ({ title: entry.item.title, quantity: entry.quantity })) }),
        aboutProof: order.proofNote,
        note: "The request has been sent to the store for review. Tell the shopper it is a request, not an approval: the store will reply by email with the decision and return instructions. Do not promise a refund.",
      },
    };
  },
});

export const shopperTools: ToolDefinition[] = [
  offerChoices,
  listReturnableOrders,
  searchProducts,
  getBestSellers,
  getNewestProducts,
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
