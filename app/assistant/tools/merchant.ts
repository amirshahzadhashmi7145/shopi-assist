/**
 * Tools for the merchant assistant inside the Shopify admin.
 *
 * These read private store data through the Admin API and must never be
 * offered to the storefront widget. They are read-only: nothing here changes
 * the store. Customer names, emails and addresses are deliberately not
 * selected by any query.
 */
import { z } from "zod";

import type { GraphqlFn } from "../types";
import { defineTool, ToolError, type ToolContext, type ToolDefinition } from "./registry";

// ---------------------------------------------------------------------------
// Admin API documents
// ---------------------------------------------------------------------------

export const SHOPIFYQL_QUERY = `#graphql
  query ShopiAssistShopifyql($query: String!) {
    shopifyqlQuery(query: $query) {
      tableData {
        columns { name dataType displayName }
        rows
      }
      parseErrors
    }
  }
`;

/** Fallback data source when ShopifyQL is not available to the app. */
export const ORDERS_FOR_SALES_QUERY = `#graphql
  query ShopiAssistOrdersForSales($query: String!, $after: String) {
    orders(first: 25, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        cancelledAt
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        lineItems(first: 25) {
          nodes {
            title
            currentQuantity
            discountedTotalSet { shopMoney { amount currencyCode } }
          }
        }
      }
    }
  }
`;

export const RECENT_ORDERS_QUERY = `#graphql
  query ShopiAssistRecentOrders($first: Int!, $query: String) {
    orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        name
        createdAt
        cancelledAt
        displayFinancialStatus
        displayFulfillmentStatus
        currentSubtotalLineItemsQuantity
        currentTotalPriceSet { shopMoney { amount currencyCode } }
      }
    }
  }
`;

export const LOW_STOCK_QUERY = `#graphql
  query ShopiAssistLowStock($first: Int!, $query: String!) {
    productVariants(first: $first, query: $query, sortKey: INVENTORY_QUANTITY) {
      nodes {
        title
        sku
        inventoryQuantity
        product { title handle status }
      }
    }
  }
`;

export const ADMIN_PRODUCT_SEARCH_QUERY = `#graphql
  query ShopiAssistAdminProductSearch($first: Int!, $query: String) {
    products(first: $first, query: $query) {
      nodes {
        title
        handle
        status
        vendor
        productType
        totalInventory
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
      }
    }
  }
`;

export const STORE_OVERVIEW_QUERY = `#graphql
  query ShopiAssistStoreOverview {
    shop {
      name
      myshopifyDomain
      currencyCode
      primaryDomain { url }
    }
    productsCount { count }
    openOrders: ordersCount(query: "status:open") { count }
    unfulfilledOrders: ordersCount(query: "fulfillment_status:unfulfilled AND status:open") { count }
  }
`;

// ---------------------------------------------------------------------------
// ShopifyQL
// ---------------------------------------------------------------------------

interface ShopifyqlResponse {
  shopifyqlQuery: {
    tableData: {
      columns: Array<{ name: string; dataType: string; displayName: string }>;
      rows: unknown;
    } | null;
    parseErrors: string[];
  } | null;
}

/** Normalises ShopifyQL rows to plain objects keyed by column name. */
export function shopifyqlRows(
  tableData: NonNullable<ShopifyqlResponse["shopifyqlQuery"]>["tableData"],
): Array<Record<string, unknown>> {
  if (!tableData || !Array.isArray(tableData.rows)) return [];
  const names = tableData.columns.map((column) => column.name);
  return tableData.rows.map((row) => {
    if (Array.isArray(row)) {
      return Object.fromEntries(names.map((name, index) => [name, row[index]]));
    }
    return (row ?? {}) as Record<string, unknown>;
  });
}

async function runShopifyql(admin: GraphqlFn, shopifyql: string) {
  const data = await admin<ShopifyqlResponse>(SHOPIFYQL_QUERY, { query: shopifyql });
  const result = data.shopifyqlQuery;
  if (!result) throw new Error("ShopifyQL returned no result");
  if (result.parseErrors?.length) {
    throw new Error(`ShopifyQL parse error: ${result.parseErrors.join("; ")}`);
  }
  return shopifyqlRows(result.tableData);
}

// ---------------------------------------------------------------------------
// Orders-based fallback
// ---------------------------------------------------------------------------

const FALLBACK_MAX_PAGES = 10; // 10 x 25 = the 250 most recent orders

interface SalesOrder {
  cancelledAt: string | null;
  currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  lineItems: {
    nodes: Array<{
      title: string;
      currentQuantity: number;
      discountedTotalSet: { shopMoney: { amount: string; currencyCode: string } };
    }>;
  };
}

async function fetchOrdersSince(admin: GraphqlFn, since: Date) {
  const orders: SalesOrder[] = [];
  let after: string | null = null;
  let truncated = false;

  for (let page = 0; page < FALLBACK_MAX_PAGES; page += 1) {
    const data: {
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: SalesOrder[];
      };
    } = await admin(ORDERS_FOR_SALES_QUERY, {
      query: `created_at:>=${since.toISOString().slice(0, 10)}`,
      after,
    });
    orders.push(...data.orders.nodes.filter((order) => !order.cancelledAt));
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
    if (page === FALLBACK_MAX_PAGES - 1) truncated = true;
  }

  return { orders, truncated };
}

const FALLBACK_NOTE =
  "Computed from recent orders because sales analytics (ShopifyQL) is not available to this app. Figures are approximate.";

function daysAgo(context: ToolContext, days: number): Date {
  return new Date(context.now().getTime() - days * 24 * 60 * 60 * 1000);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

const daysSchema = z
  .number()
  .int()
  .min(1)
  .max(365)
  .default(30)
  .describe("Look-back window in days (1-365).");

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const getTopSellingProducts = defineTool({
  name: "get_top_selling_products",
  description:
    "Rank products by actual sales over a recent period. Use for 'top selling items', 'best sellers', 'what sold most' questions from the merchant.",
  audiences: ["merchant"],
  schema: z.object({
    days: daysSchema,
    limit: z.number().int().min(1).max(25).default(10),
    rankBy: z
      .enum(["units", "revenue"])
      .default("units")
      .describe("Rank by units sold or by net sales."),
  }),
  isAvailable: (context) => Boolean(context.admin),
  async run({ days, limit, rankBy }, context) {
    const admin = context.admin!;
    const orderColumn = rankBy === "revenue" ? "net_sales" : "net_items_sold";

    try {
      // `days` and `limit` are validated integers and `orderColumn` is one of
      // two literals, so building the query string here is injection-safe.
      const rows = await runShopifyql(
        admin,
        `FROM sales SHOW net_items_sold, net_sales GROUP BY product_title SINCE -${days}d UNTIL today ORDER BY ${orderColumn} DESC LIMIT ${limit}`,
      );
      return {
        output: {
          periodDays: days,
          rankedBy: rankBy,
          source: "sales analytics",
          products: rows
            .filter((row) => row.product_title)
            .map((row, index) => ({
              rank: index + 1,
              title: String(row.product_title),
              unitsSold: Number(row.net_items_sold ?? 0),
              netSales: round2(Number(row.net_sales ?? 0)),
            })),
        },
      };
    } catch (error) {
      console.warn(
        `[shopi-assist] ShopifyQL unavailable for ${context.shop}, using orders fallback:`,
        error instanceof Error ? error.message : "unknown error",
      );
    }

    const { orders, truncated } = await fetchOrdersSince(admin, daysAgo(context, days));
    const totals = new Map<string, { unitsSold: number; netSales: number }>();
    for (const order of orders) {
      for (const item of order.lineItems.nodes) {
        const entry = totals.get(item.title) ?? { unitsSold: 0, netSales: 0 };
        entry.unitsSold += item.currentQuantity;
        entry.netSales += Number(item.discountedTotalSet.shopMoney.amount);
        totals.set(item.title, entry);
      }
    }

    const ranked = [...totals.entries()]
      .map(([title, entry]) => ({ title, ...entry }))
      .sort((a, b) =>
        rankBy === "revenue" ? b.netSales - a.netSales : b.unitsSold - a.unitsSold,
      )
      .slice(0, limit)
      .map((entry, index) => ({
        rank: index + 1,
        title: entry.title,
        unitsSold: entry.unitsSold,
        netSales: round2(entry.netSales),
      }));

    return {
      output: {
        periodDays: days,
        rankedBy: rankBy,
        source: "recent orders",
        note: truncated
          ? `${FALLBACK_NOTE} Only the ${orders.length} most recent orders were counted.`
          : FALLBACK_NOTE,
        ordersCounted: orders.length,
        products: ranked,
      },
    };
  },
});

const getSalesSummary = defineTool({
  name: "get_sales_summary",
  description:
    "Total sales, order count and average order value over a recent period.",
  audiences: ["merchant"],
  schema: z.object({ days: daysSchema }),
  isAvailable: (context) => Boolean(context.admin),
  async run({ days }, context) {
    const admin = context.admin!;

    try {
      const rows = await runShopifyql(
        admin,
        `FROM sales SHOW total_sales, net_sales, orders, average_order_value, net_items_sold SINCE -${days}d UNTIL today`,
      );
      const row = rows[0] ?? {};
      return {
        output: {
          periodDays: days,
          source: "sales analytics",
          totalSales: round2(Number(row.total_sales ?? 0)),
          netSales: round2(Number(row.net_sales ?? 0)),
          orders: Number(row.orders ?? 0),
          averageOrderValue: round2(Number(row.average_order_value ?? 0)),
          unitsSold: Number(row.net_items_sold ?? 0),
        },
      };
    } catch (error) {
      console.warn(
        `[shopi-assist] ShopifyQL unavailable for ${context.shop}, using orders fallback:`,
        error instanceof Error ? error.message : "unknown error",
      );
    }

    const { orders, truncated } = await fetchOrdersSince(admin, daysAgo(context, days));
    const total = orders.reduce(
      (sum, order) => sum + Number(order.currentTotalPriceSet.shopMoney.amount),
      0,
    );
    const units = orders.reduce(
      (sum, order) =>
        sum + order.lineItems.nodes.reduce((count, item) => count + item.currentQuantity, 0),
      0,
    );

    return {
      output: {
        periodDays: days,
        source: "recent orders",
        note: truncated
          ? `${FALLBACK_NOTE} Only the ${orders.length} most recent orders were counted.`
          : FALLBACK_NOTE,
        currency: orders[0]?.currentTotalPriceSet.shopMoney.currencyCode,
        totalSales: round2(total),
        orders: orders.length,
        averageOrderValue: orders.length ? round2(total / orders.length) : 0,
        unitsSold: units,
      },
    };
  },
});

const ORDER_FILTERS = {
  any: undefined,
  open: "status:open",
  unfulfilled: "fulfillment_status:unfulfilled AND status:open",
  unpaid: "financial_status:pending AND status:open",
  cancelled: "status:cancelled",
} as const;

const listRecentOrders = defineTool({
  name: "list_recent_orders",
  description:
    "List the most recent orders with status and total. Does not include customer details.",
  audiences: ["merchant"],
  schema: z.object({
    limit: z.number().int().min(1).max(25).default(10),
    filter: z
      .enum(["any", "open", "unfulfilled", "unpaid", "cancelled"])
      .default("any"),
  }),
  isAvailable: (context) => Boolean(context.admin),
  async run({ limit, filter }, context) {
    const data = await context.admin!<{
      orders: {
        nodes: Array<{
          name: string;
          createdAt: string;
          cancelledAt: string | null;
          displayFinancialStatus: string | null;
          displayFulfillmentStatus: string;
          currentSubtotalLineItemsQuantity: number;
          currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
        }>;
      };
    }>(RECENT_ORDERS_QUERY, { first: limit, query: ORDER_FILTERS[filter] ?? null });

    return {
      output: {
        filter,
        count: data.orders.nodes.length,
        orders: data.orders.nodes.map((order) => ({
          order: order.name,
          placedAt: order.createdAt,
          total: `${order.currentTotalPriceSet.shopMoney.amount} ${order.currentTotalPriceSet.shopMoney.currencyCode}`,
          items: order.currentSubtotalLineItemsQuantity,
          payment: order.displayFinancialStatus,
          fulfillment: order.displayFulfillmentStatus,
          cancelled: Boolean(order.cancelledAt) || undefined,
        })),
      },
    };
  },
});

const getLowStockProducts = defineTool({
  name: "get_low_stock_products",
  description:
    "List product variants whose inventory is at or below a threshold, lowest first. Use for 'what is running low' or 'what should I restock'.",
  audiences: ["merchant"],
  schema: z.object({
    threshold: z.number().int().min(0).max(1000).default(5),
    limit: z.number().int().min(1).max(25).default(15),
  }),
  isAvailable: (context) => Boolean(context.admin),
  async run({ threshold, limit }, context) {
    const data = await context.admin!<{
      productVariants: {
        nodes: Array<{
          title: string;
          sku: string | null;
          inventoryQuantity: number | null;
          product: { title: string; handle: string; status: string };
        }>;
      };
    }>(LOW_STOCK_QUERY, {
      // Over-fetch a little: archived and draft products are filtered out below.
      first: Math.min(limit * 2, 50),
      query: `inventory_quantity:<=${threshold}`,
    });

    const variants = data.productVariants.nodes
      .filter((variant) => variant.product.status === "ACTIVE")
      .slice(0, limit);

    return {
      output: {
        threshold,
        count: variants.length,
        variants: variants.map((variant) => ({
          product: variant.product.title,
          variant: variant.title === "Default Title" ? undefined : variant.title,
          sku: variant.sku || undefined,
          inStock: variant.inventoryQuantity ?? 0,
        })),
      },
    };
  },
});

const searchCatalog = defineTool({
  name: "search_catalog",
  description:
    "Search all products in the store admin, including drafts and archived ones, with status, inventory and price.",
  audiences: ["merchant"],
  schema: z.object({
    query: z
      .string()
      .trim()
      .max(200)
      .default("")
      .describe("Keywords; leave empty to list products."),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  isAvailable: (context) => Boolean(context.admin),
  async run({ query, limit }, context) {
    const data = await context.admin!<{
      products: {
        nodes: Array<{
          title: string;
          handle: string;
          status: string;
          vendor: string;
          productType: string;
          totalInventory: number | null;
          priceRangeV2: {
            minVariantPrice: { amount: string; currencyCode: string };
            maxVariantPrice: { amount: string; currencyCode: string };
          };
        }>;
      };
    }>(ADMIN_PRODUCT_SEARCH_QUERY, { first: limit, query: query || null });

    return {
      output: {
        query,
        count: data.products.nodes.length,
        products: data.products.nodes.map((product) => {
          const { minVariantPrice: min, maxVariantPrice: max } = product.priceRangeV2;
          return {
            title: product.title,
            handle: product.handle,
            status: product.status,
            vendor: product.vendor || undefined,
            type: product.productType || undefined,
            inventory: product.totalInventory,
            price:
              min.amount === max.amount
                ? `${min.amount} ${min.currencyCode}`
                : `${min.amount}-${max.amount} ${min.currencyCode}`,
          };
        }),
      },
    };
  },
});

const getStoreOverview = defineTool({
  name: "get_store_overview",
  description:
    "Basic facts about the store: name, domain, currency, number of products, open and unfulfilled order counts.",
  audiences: ["merchant"],
  schema: z.object({}),
  isAvailable: (context) => Boolean(context.admin),
  async run(_args, context) {
    const data = await context.admin!<{
      shop: {
        name: string;
        myshopifyDomain: string;
        currencyCode: string;
        primaryDomain: { url: string };
      };
      productsCount: { count: number } | null;
      openOrders: { count: number } | null;
      unfulfilledOrders: { count: number } | null;
    }>(STORE_OVERVIEW_QUERY);

    if (!data.shop) throw new ToolError("Store details are unavailable.");
    return {
      output: {
        name: data.shop.name,
        domain: data.shop.primaryDomain.url,
        currency: data.shop.currencyCode,
        products: data.productsCount?.count ?? null,
        openOrders: data.openOrders?.count ?? null,
        unfulfilledOrders: data.unfulfilledOrders?.count ?? null,
      },
    };
  },
});

export const merchantTools: ToolDefinition[] = [
  getTopSellingProducts,
  getSalesSummary,
  listRecentOrders,
  getLowStockProducts,
  searchCatalog,
  getStoreOverview,
];
