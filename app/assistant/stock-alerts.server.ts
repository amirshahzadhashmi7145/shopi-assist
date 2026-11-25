/**
 * Back-in-stock alerts: a shopper asks to be told, once, when a sold-out
 * product can be bought again.
 *
 * Asking: a form in the widget posts the product and an email address here,
 * through the app proxy. No model is involved, and the address never goes to
 * one, into a transcript or into a log.
 *
 * Telling: Shopify calls the app whenever a product changes. If anyone is
 * waiting for that product, its availability is read from Shopify and each
 * waiting shopper whose version is back gets one email.
 *
 * Every query on StockAlert filters by the shop, which comes from Shopify's
 * signature on the request: the app proxy's or the webhook's.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

import prisma from "../db.server";
import { ChatError } from "./chat.server";
import { getEmailStatus, sendEmail as defaultSendEmail, type EmailSender } from "./email.server";
import { clientKey, rateLimiter as defaultRateLimiter, type RateLimiter } from "./rate-limit";
import { getSettings } from "./settings.server";
import { fingerprint } from "./tools/shopper";
import { STOCK_ALERT_PRODUCT_QUERY } from "./tools/storefront-queries";
import type { GraphqlFn } from "./types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** After this many failed sends an alert is left alone. */
const MAX_ATTEMPTS = 4;
/** Emails sent for one product in one go; the rest follow on its next change. */
const MAX_PER_RUN = 200;
/** How far back "told" is counted for the merchant: as long as sent alerts are kept. */
const KEEP_SENT_MS = 30 * DAY_MS;

const alertSchema = z.object({
  productId: z.string().regex(/^\d{1,20}$/),
  /** Empty or left out: any version of the product. */
  variantId: z
    .string()
    .regex(/^\d{0,20}$/)
    .default(""),
  email: z
    .string()
    .trim()
    .max(254)
    .pipe(z.email("Enter a valid email address."))
    .transform((value) => value.toLowerCase()),
});

export interface StockAlertInput {
  /** Shop domain from the authenticated request. Never from the request body. */
  shop: string;
  /** The untrusted JSON the widget posted. */
  body: Record<string, unknown>;
  ip?: string;
  storefront: GraphqlFn;
}

export interface StockAlertDeps {
  db: PrismaClient;
  rateLimiter: RateLimiter;
  sendEmail: EmailSender;
  emailReady: () => boolean;
  now: () => Date;
}

function withDefaults(overrides: Partial<StockAlertDeps>): StockAlertDeps {
  return {
    db: overrides.db ?? prisma,
    rateLimiter: overrides.rateLimiter ?? defaultRateLimiter,
    sendEmail: overrides.sendEmail ?? defaultSendEmail,
    emailReady: overrides.emailReady ?? (() => getEmailStatus().ready),
    now: overrides.now ?? (() => new Date()),
  };
}

/** Whether the widget should offer alerts for this shop: switched on, and able to send. */
export async function stockAlertsOffered(
  shop: string,
  overrides: Partial<StockAlertDeps> = {},
): Promise<boolean> {
  const deps = withDefaults(overrides);
  const settings = await getSettings(shop, deps.db);
  return settings.enabled && settings.stockAlerts && deps.emailReady();
}

export type StockAlertResult =
  /** They will get an email when it is back. */
  | { ok: true; status: "subscribed" }
  /** Nothing to wait for: it can be bought now. */
  | { ok: true; status: "in_stock" };

/** Records a shopper's request to hear when a product, or one version of it, is back. */
export async function handleStockAlert(
  input: StockAlertInput,
  overrides: Partial<StockAlertDeps> = {},
): Promise<StockAlertResult> {
  const deps = withDefaults(overrides);
  const now = deps.now();

  const settings = await getSettings(input.shop, deps.db);
  // An address is only taken where an email can actually be sent to it.
  if (!settings.enabled || !settings.stockAlerts || !deps.emailReady()) {
    throw new ChatError("disabled", 403, "Back-in-stock alerts are not available for this store.");
  }

  const parsed = alertSchema.safeParse(input.body);
  if (!parsed.success) {
    const badEmail = parsed.error.issues.some((issue) => issue.path[0] === "email");
    throw new ChatError(
      "invalid_request",
      400,
      badEmail ? "Enter a valid email address." : "That alert could not be set up.",
    );
  }
  const { productId, variantId, email } = parsed.data;

  // Asking is cheap for a shopper and must not be a way to fill an inbox or
  // this table: limits by visitor, by address and by shop.
  for (const [key, max, windowMs] of [
    [`stock-alert:ip:${input.shop}:${clientKey(input.ip)}`, 10, HOUR_MS],
    [`stock-alert:email:${input.shop}:${fingerprint(email)}`, 10, DAY_MS],
    [`stock-alert:shop:${input.shop}`, 2000, DAY_MS],
  ] as const) {
    const limit = deps.rateLimiter.hit(key, max, windowMs, now.getTime());
    if (!limit.allowed) {
      throw new ChatError(
        "rate_limited",
        429,
        "Too many alerts for now. Please try again later.",
        Math.ceil(limit.retryAfterMs / 1000),
      );
    }
  }

  // What they are waiting for is read from the store, never taken from the
  // request: the titles in the email are Shopify's, and so is "sold out".
  let product: {
    title?: string;
    availableForSale?: boolean;
    variants?: { nodes: Array<{ id: string; title: string; availableForSale: boolean }> };
  } | null;
  try {
    const data = await input.storefront<{ node: typeof product }>(STOCK_ALERT_PRODUCT_QUERY, {
      id: `gid://shopify/Product/${productId}`,
    });
    product = data.node;
  } catch {
    throw new ChatError("assistant_failed", 502, "That alert could not be set up. Please try again.");
  }
  if (!product?.title) {
    throw new ChatError("invalid_request", 404, "That product could not be found.");
  }
  const variant = variantId
    ? product.variants?.nodes.find((candidate) => candidate.id.endsWith(`/${variantId}`))
    : undefined;
  if (variantId && !variant) {
    throw new ChatError("invalid_request", 404, "That product could not be found.");
  }
  if (variant ? variant.availableForSale : product.availableForSale) {
    return { ok: true, status: "in_stock" };
  }

  const titles = {
    productTitle: product.title.slice(0, 200),
    // "Default Title" is Shopify's name for the one version of a product without versions.
    variantTitle: variant && variant.title !== "Default Title" ? variant.title.slice(0, 200) : "",
  };
  await deps.db.stockAlert.upsert({
    where: { shop_email_productId_variantId: { shop: input.shop, email, productId, variantId } },
    create: { shop: input.shop, email, productId, variantId, ...titles },
    // Asked again after being told once: they are waiting again.
    update: { ...titles, notifiedAt: null, attempts: 0, createdAt: now },
  });
  return { ok: true, status: "subscribed" };
}

/** Admin API. A product's availability now, and what the email needs to say where to buy it. */
export const STOCK_ALERT_AVAILABILITY_QUERY = `#graphql
  query ShopiAssistStockAlertAvailability($id: ID!) {
    product(id: $id) {
      title
      handle
      status
      onlineStoreUrl
      variants(first: 100) {
        nodes { id availableForSale }
      }
    }
    shop {
      name
      contactEmail
      primaryDomain { url }
    }
  }
`;

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** The one email an alert leads to. Plain, short, and clear about why it was sent. */
export function backInStockEmail(details: {
  shopName: string;
  productTitle: string;
  variantTitle: string;
  url: string;
}): { subject: string; text: string; html: string } {
  const item = details.variantTitle
    ? `${details.productTitle} (${details.variantTitle})`
    : details.productTitle;
  const why = `You asked ${details.shopName} to tell you when this was back in stock. This is the only email you will get about it.`;
  return {
    subject: `Back in stock: ${item}`,
    text: `Good news: ${item} is back in stock at ${details.shopName}.\n\nSee it here: ${details.url}\n\nIt may sell out again, so it is not held for you.\n\n${why}\n`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;max-width:520px">
<p>Good news: <strong>${escapeHtml(item)}</strong> is back in stock at ${escapeHtml(details.shopName)}.</p>
<p><a href="${escapeHtml(details.url)}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#1a1a1a;color:#ffffff;text-decoration:none">See it in the store</a></p>
<p>It may sell out again, so it is not held for you.</p>
<p style="font-size:12.5px;color:#666666">${escapeHtml(why)}</p>
</div>`,
  };
}

/**
 * Tells everyone waiting for a product whose version can be bought again.
 * Called when Shopify says the product changed. Resolves with how many
 * emails went out.
 */
export async function notifyBackInStock(
  input: { shop: string; productId: string; admin: GraphqlFn },
  overrides: Partial<StockAlertDeps> = {},
): Promise<number> {
  const deps = withDefaults(overrides);
  if (!/^\d{1,20}$/.test(input.productId)) return 0;

  const waiting = await deps.db.stockAlert.findMany({
    where: {
      shop: input.shop,
      productId: input.productId,
      notifiedAt: null,
      attempts: { lt: MAX_ATTEMPTS },
    },
    orderBy: { createdAt: "asc" },
    take: MAX_PER_RUN,
  });
  // Most product changes are for products nobody is waiting on.
  if (!waiting.length || !deps.emailReady()) return 0;

  const data = await input.admin<{
    product: {
      title: string;
      handle: string;
      status: string;
      onlineStoreUrl: string | null;
      variants: { nodes: Array<{ id: string; availableForSale: boolean }> };
    } | null;
    shop: { name: string; contactEmail: string | null; primaryDomain: { url: string } | null };
  }>(STOCK_ALERT_AVAILABILITY_QUERY, { id: `gid://shopify/Product/${input.productId}` });
  const product = data.product;
  // Not on sale at all (a draft, archived, deleted): nothing to announce.
  if (!product || product.status !== "ACTIVE") return 0;

  const back = new Set(
    product.variants.nodes
      .filter((variant) => variant.availableForSale)
      .map((variant) => variant.id.replace(/^.*\//, "")),
  );
  if (!back.size) return 0;
  const url =
    product.onlineStoreUrl ??
    `${(data.shop.primaryDomain?.url ?? `https://${input.shop}`).replace(/\/$/, "")}/products/${product.handle}`;

  let sent = 0;
  for (const alert of waiting) {
    if (alert.variantId ? !back.has(alert.variantId) : false) continue;

    // Claimed first, so a second call for the same change cannot send it too.
    const now = deps.now();
    const claimed = await deps.db.stockAlert.updateMany({
      where: { id: alert.id, shop: input.shop, notifiedAt: null },
      data: { notifiedAt: now },
    });
    if (!claimed.count) continue;

    try {
      await deps.sendEmail({
        to: alert.email,
        fromName: data.shop.name,
        replyTo: data.shop.contactEmail ?? undefined,
        ...backInStockEmail({
          shopName: data.shop.name,
          productTitle: product.title,
          variantTitle: alert.variantTitle,
          url,
        }),
      });
      sent += 1;
    } catch (error) {
      // Not sent: they are still waiting, and it is tried again next time.
      await deps.db.stockAlert.updateMany({
        where: { id: alert.id, shop: input.shop },
        data: { notifiedAt: null, attempts: { increment: 1 } },
      });
      console.error(
        `[shopi-assist] back-in-stock email failed shop=${input.shop} error=${error instanceof Error ? error.name : "unknown"}`,
      );
    }
  }
  if (sent) console.info(`[shopi-assist] back-in-stock emails sent shop=${input.shop} count=${sent}`);
  return sent;
}

/** True when anyone is waiting to hear about this product. */
export async function hasWaitingAlerts(
  db: PrismaClient,
  shop: string,
  productId: string,
): Promise<boolean> {
  const waiting = await db.stockAlert.count({
    where: { shop, productId, notifiedAt: null, attempts: { lt: MAX_ATTEMPTS } },
  });
  return waiting > 0;
}

/** Removes a person's alerts for a shop: Shopify's request to erase a customer. */
export async function deleteStockAlertsForEmail(
  db: PrismaClient,
  shop: string,
  email: string,
): Promise<number> {
  const removed = await db.stockAlert.deleteMany({
    where: { shop, email: email.trim().toLowerCase() },
  });
  return removed.count;
}

/** For the merchant: how many shoppers are waiting, for which products, and how many were told. */
export async function stockAlertSummary(
  db: PrismaClient,
  shop: string,
  now: Date = new Date(),
): Promise<{ waiting: number; sent: number; products: Array<{ title: string; waiting: number }> }> {
  const [waiting, sent, byProduct] = await Promise.all([
    db.stockAlert.count({ where: { shop, notifiedAt: null } }),
    db.stockAlert.count({
      where: { shop, notifiedAt: { gte: new Date(now.getTime() - KEEP_SENT_MS) } },
    }),
    db.stockAlert.groupBy({
      by: ["productId", "productTitle"],
      where: { shop, notifiedAt: null },
      _count: { _all: true },
    }),
  ]);
  const products = byProduct
    .map((row) => ({ title: row.productTitle, waiting: row._count._all }))
    .sort((a, b) => b.waiting - a.waiting)
    .slice(0, 5);
  return { waiting, sent, products };
}
