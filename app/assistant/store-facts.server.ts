/**
 * Reads a store's facts from Shopify and keeps them with the shop's settings.
 *
 * Shopify is asked when the merchant has the app open (their own admin
 * session), and again in the background once a day while the store's chat is
 * in use, so an answer never rests on facts older than that. A chat turn
 * itself only ever reads what is stored: it does not wait on Shopify for this.
 *
 * `shop` must always come from an authenticated request.
 */
import type { PrismaClient } from "@prisma/client";

import prisma from "../db.server";
import { cleanStoreFacts, readStoreFacts, type StoreFacts } from "./store-facts";
import { STORE_FACTS_QUERY } from "./tools/storefront-queries";
import type { GraphqlFn } from "./types";

export const STORE_FACTS_ADMIN_QUERY = `#graphql
  query ShopiAssistStoreFacts {
    shop {
      name
      contactEmail
      currencyCode
    }
    productsCount(query: "status:active") {
      count
      precision
    }
    giftCardProducts: products(first: 1, query: "gift_card:true status:active") {
      nodes { id }
    }
  }
`;

interface AdminFacts {
  shop: { name: string | null; contactEmail: string | null; currencyCode: string | null } | null;
  productsCount: { count: number; precision: string } | null;
  giftCardProducts: { nodes: Array<{ id: string }> } | null;
}

interface StorefrontFacts {
  shop: {
    name: string | null;
    description: string | null;
    shipsToCountries: string[] | null;
    paymentSettings: {
      acceptedCardBrands: string[] | null;
      supportedDigitalWallets: string[] | null;
    } | null;
    refundPolicy: { id: string } | null;
    shippingPolicy: { id: string } | null;
    privacyPolicy: { id: string } | null;
    termsOfService: { id: string } | null;
  } | null;
}

export interface FactClients {
  admin?: GraphqlFn;
  storefront?: GraphqlFn;
}

/** Which of Shopify's two APIs answered. False: asked, and it failed. */
export interface FactsReached {
  admin: boolean;
  storefront: boolean;
}

const ADMIN_KEYS = [
  "shopName",
  "contactEmail",
  "currencyCode",
  "products",
  "productsCapped",
  "giftCards",
] as const;
const STOREFRONT_KEYS = ["description", "shipsTo", "cards", "wallets", "policies"] as const;

/** The facts kept for a shop, or an error when the database cannot be read. */
async function readStoredFacts(shop: string, db: PrismaClient): Promise<StoreFacts> {
  const row = await db.shopSettings.findUnique({
    where: { shop },
    select: { storeFacts: true },
  });
  return readStoreFacts(row?.storeFacts);
}

/**
 * The facts kept for a shop. Reads the database only. The facts add to what
 * the assistant knows and nothing depends on them, so a failure to read them
 * counts as "none known" instead of stopping a chat.
 */
export async function getStoredFacts(shop: string, db: PrismaClient = prisma): Promise<StoreFacts> {
  try {
    return await readStoredFacts(shop, db);
  } catch (error) {
    console.error(
      `[shopi-assist] store facts could not be read shop=${shop} error=${error instanceof Error ? error.name : "unknown"}`,
    );
    return readStoreFacts(null);
  }
}

/**
 * Asks Shopify and stores what it answers. Each API is asked on its own: what
 * one of them could not be reached for keeps its last known value, so a
 * passing outage does not make the assistant forget where the store ships.
 * Only an answer from both counts as a full sync; after anything less, the
 * facts are asked for again at the next chance.
 *
 * With `maxAgeMs`, facts synced in full more recently than that are returned
 * as they are and Shopify is not asked (`reached` is then null).
 *
 * Throws when the stored facts cannot be read: merging into facts that were
 * not read would write over them.
 */
export async function syncStoreFacts(
  shop: string,
  clients: FactClients,
  options: { db?: PrismaClient; now?: Date; maxAgeMs?: number } = {},
): Promise<{ facts: StoreFacts; reached: FactsReached | null }> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const stored = await readStoredFacts(shop, db);

  if (
    options.maxAgeMs &&
    stored.syncedAt &&
    now.getTime() - Date.parse(stored.syncedAt) < options.maxAgeMs
  ) {
    return { facts: stored, reached: null };
  }

  const [admin, storefront] = await Promise.all([
    clients.admin
      ? clients.admin<AdminFacts>(STORE_FACTS_ADMIN_QUERY).catch(() => null)
      : Promise.resolve(null),
    clients.storefront
      ? clients.storefront<StorefrontFacts>(STORE_FACTS_QUERY).catch(() => null)
      : Promise.resolve(null),
  ]);
  const reached: FactsReached = { admin: Boolean(admin), storefront: Boolean(storefront) };
  if (!reached.admin && !reached.storefront) return { facts: stored, reached };

  const next: Record<string, unknown> = { ...stored };
  if (admin) {
    for (const key of ADMIN_KEYS) delete next[key];
    next.shopName = admin.shop?.name ?? undefined;
    next.contactEmail = admin.shop?.contactEmail ?? undefined;
    next.currencyCode = admin.shop?.currencyCode ?? undefined;
    if (admin.productsCount) {
      next.products = admin.productsCount.count;
      next.productsCapped = admin.productsCount.precision !== "EXACT";
    }
    if (admin.giftCardProducts) next.giftCards = admin.giftCardProducts.nodes.length > 0;
  }
  if (storefront?.shop) {
    for (const key of STOREFRONT_KEYS) delete next[key];
    const found = storefront.shop;
    next.description = found.description ?? undefined;
    next.shipsTo = found.shipsToCountries ?? [];
    next.cards = found.paymentSettings?.acceptedCardBrands ?? [];
    next.wallets = found.paymentSettings?.supportedDigitalWallets ?? [];
    next.policies = {
      refund: Boolean(found.refundPolicy),
      shipping: Boolean(found.shippingPolicy),
      privacy: Boolean(found.privacyPolicy),
      terms: Boolean(found.termsOfService),
    };
    if (!next.shopName && found.name) next.shopName = found.name;
  }
  if (reached.admin && reached.storefront) next.syncedAt = now.toISOString();

  const facts = cleanStoreFacts(next);
  const serialised = JSON.stringify(facts);
  await db.shopSettings.upsert({
    where: { shop },
    create: { shop, storeFacts: serialised },
    update: { storeFacts: serialised },
  });
  return { facts, reached };
}

/**
 * For the admin pages: the same, but a page never fails because of it. When
 * nothing could be read or stored, the page is told that Shopify was not
 * reached and shows what it has.
 */
export async function syncStoreFactsForPage(
  shop: string,
  clients: FactClients,
  options: { db?: PrismaClient; now?: Date; maxAgeMs?: number } = {},
): Promise<{ facts: StoreFacts; reached: FactsReached | null }> {
  try {
    return await syncStoreFacts(shop, clients, options);
  } catch (error) {
    console.error(
      `[shopi-assist] store facts sync failed shop=${shop} error=${error instanceof Error ? error.name : "unknown"}`,
    );
    return { facts: readStoreFacts(null), reached: { admin: false, storefront: false } };
  }
}

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_MS = 60 * 60 * 1000;
const lastAttempt = new Map<string, number>();

/**
 * For the chat: starts a refresh in the background when the stored facts are
 * more than a day old, at most once an hour per shop. Never waited on, and a
 * store that has never been synced is left alone (the merchant opening the
 * app does the first sync).
 */
export function refreshStoreFactsIfStale(
  shop: string,
  facts: StoreFacts,
  clients: FactClients,
  options: { db?: PrismaClient; now?: Date } = {},
): Promise<void> | null {
  const now = options.now ?? new Date();
  if (!facts.syncedAt || now.getTime() - Date.parse(facts.syncedAt) < STALE_AFTER_MS) return null;
  if (now.getTime() - (lastAttempt.get(shop) ?? 0) < RETRY_AFTER_MS) return null;
  if (!clients.admin && !clients.storefront) return null;
  lastAttempt.set(shop, now.getTime());

  return syncStoreFacts(shop, clients, { db: options.db, now })
    .then(() => undefined)
    .catch((error: unknown) => {
      console.error(
        `[shopi-assist] store facts refresh failed shop=${shop} error=${error instanceof Error ? error.name : "unknown"}`,
      );
    });
}
