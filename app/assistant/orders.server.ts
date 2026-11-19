/**
 * Pay-on-delivery orders placed from the form in the chat widget.
 *
 * This is the one place where an anonymous storefront visitor makes the app
 * create something real in the store, so it is deliberately not a model tool:
 * the shopper types their details into a form, the form posts here directly,
 * and nothing in this file is reachable by the LLM. Names, phone numbers and
 * addresses therefore never pass through the model or the stored transcript.
 *
 * Two steps:
 *   quote  works out delivery options, tax and the total, and creates nothing.
 *   place  repeats that calculation, checks the shopper saw the same total,
 *          then creates an unpaid order through a draft order.
 *
 * Prices always come from Shopify. The browser only says which variants, how
 * many and where to deliver.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

import prisma from "../db.server";
import { clientKey, rateLimiter as defaultRateLimiter, type RateLimiter } from "./rate-limit";
import { getSettings } from "./settings.server";
import { isDevelopmentStore } from "./shopify-clients.server";
import { fingerprint } from "./tools/shopper";
import {
  DELIVERY_COUNTRIES_QUERY,
  VARIANTS_FOR_ORDER_QUERY,
} from "./tools/storefront-queries";
import type { GraphqlFn, Money } from "./types";

// ---------------------------------------------------------------------------
// Admin API documents
// ---------------------------------------------------------------------------

/** Admin API. Prices a would-be order without creating anything. */
export const DRAFT_ORDER_CALCULATE_MUTATION = `#graphql
  mutation ShopiAssistDraftOrderCalculate($input: DraftOrderInput!) {
    draftOrderCalculate(input: $input) {
      calculatedDraftOrder {
        taxesIncluded
        lineItems {
          title
          variantTitle
          quantity
          requiresShipping
          discountedTotalSet { presentmentMoney { amount currencyCode } }
        }
        availableShippingRates {
          handle
          title
          price { amount currencyCode }
        }
        subtotalPriceSet { presentmentMoney { amount currencyCode } }
        totalShippingPriceSet { presentmentMoney { amount currencyCode } }
        totalTaxSet { presentmentMoney { amount currencyCode } }
        totalPriceSet { presentmentMoney { amount currencyCode } }
      }
      userErrors { field message }
    }
  }
`;

/**
 * Admin API. The "due on fulfillment" payment terms. A draft order completed
 * with payment terms becomes an unpaid order; without them Shopify would mark
 * it as paid, which is wrong for an order that is paid on delivery.
 */
export const PAY_ON_DELIVERY_TERMS_QUERY = `#graphql
  query ShopiAssistPayOnDeliveryTerms {
    paymentTermsTemplates(paymentTermsType: FULFILLMENT) {
      id
      paymentTermsType
    }
  }
`;

export const DRAFT_ORDER_CREATE_MUTATION = `#graphql
  mutation ShopiAssistDraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id }
      userErrors { field message }
    }
  }
`;

export const DRAFT_ORDER_COMPLETE_MUTATION = `#graphql
  mutation ShopiAssistDraftOrderComplete($id: ID!) {
    draftOrderComplete(id: $id) {
      draftOrder {
        order { id name displayFinancialStatus }
      }
      userErrors { field message }
    }
  }
`;

/** Admin API. Removes a draft that could not be turned into an order. */
export const DRAFT_ORDER_DELETE_MUTATION = `#graphql
  mutation ShopiAssistDraftOrderDelete($input: DraftOrderDeleteInput!) {
    draftOrderDelete(input: $input) {
      deletedId
      userErrors { field message }
    }
  }
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrderErrorCode =
  | "invalid_request"
  | "invalid_order"
  | "disabled"
  | "rate_limited"
  | "unavailable"
  | "undeliverable"
  | "quote_changed"
  | "order_failed";

/** Which form field a message belongs to. */
export type OrderField =
  | "name"
  | "phone"
  | "email"
  | "address1"
  | "address2"
  | "city"
  | "province"
  | "zip"
  | "countryCode";

export interface OrderQuote {
  lines: Array<{ title: string; quantity: number; total: Money }>;
  subtotal: Money;
  shipping: Money;
  /** Null when prices already include tax, or there is none. */
  tax: Money | null;
  total: Money;
  shippingRates: Array<{ handle: string; title: string; price: Money }>;
  /** The delivery option the totals above include. */
  shippingRateHandle: string;
}

/** An error with a message that is safe to show to the shopper. */
export class OrderError extends Error {
  constructor(
    public readonly code: OrderErrorCode,
    public readonly status: number,
    message: string,
    public readonly extra: {
      fields?: Partial<Record<OrderField, string>>;
      quote?: OrderQuote;
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(message);
    this.name = "OrderError";
  }
}

export type ChatOrderResult =
  | { ok: true; step: "quote"; quote: OrderQuote }
  | { ok: true; step: "place"; order: { name: string; total: Money } };

export interface ChatOrderInput {
  /** Shop domain from the authenticated request. Never from the request body. */
  shop: string;
  /** The untrusted JSON the widget posted. */
  body: Record<string, unknown>;
  ip?: string;
  admin: GraphqlFn;
  storefront: GraphqlFn;
}

/** A finished or in-flight "place" request, kept so a retry returns the same order. */
interface Remembered {
  expiresAt: number;
  result: Promise<ChatOrderResult>;
}

export interface ChatOrderDeps {
  db: PrismaClient;
  rateLimiter: RateLimiter;
  /** Keyed by shop and the widget's idempotency key. */
  placed: Map<string, Remembered>;
  /** Whether the shop exists only for testing. Asked of Shopify. */
  isTestStore: (shop: string, admin: GraphqlFn) => Promise<boolean>;
  now: () => Date;
}

/**
 * How much looser the order limits are on a development store, where a team
 * places the same test order from one office and one phone number all day.
 */
const TEST_STORE_LIMIT_FACTOR = 50;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const MAX_LINES = 10;
const MAX_QUANTITY = 10;

const line = (max: number, tooLong: string) => z.string().trim().max(max, tooLong);

const orderSchema = z.object({
  items: z
    .array(
      z.object({
        variantId: z.string().regex(/^\d{1,20}$/),
        quantity: z.number().int().min(1).max(MAX_QUANTITY),
      }),
    )
    .min(1)
    .max(MAX_LINES),
  contact: z.object({
    name: line(80, "Keep the name under 80 characters.").min(2, "Enter your full name."),
    phone: z
      .string()
      .trim()
      // Spaces, dashes, dots and brackets are how people write phone numbers.
      .transform((value) => value.replace(/[\s().-]/g, ""))
      .pipe(z.string().regex(/^\+?\d{7,15}$/, "Enter a phone number with 7 to 15 digits.")),
    email: z
      .union([z.literal(""), z.email("Enter a valid email address.").max(254)])
      .default(""),
  }),
  address: z.object({
    address1: line(120, "Keep the address under 120 characters.").min(
      3,
      "Enter your street address.",
    ),
    address2: line(120, "Keep this under 120 characters.").default(""),
    city: line(80, "Keep the city under 80 characters.").min(1, "Enter your city."),
    province: line(60, "Keep this under 60 characters.").default(""),
    zip: line(16, "Keep the postal code under 16 characters.").default(""),
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, "Choose a country.")
      .transform((value) => value.toUpperCase()),
  }),
  /**
   * The delivery option the shopper picked. Missing means the cheapest.
   * Shopify's handles are signed tokens of 300-odd characters that grow with
   * the option's name, so the limit is generous. An unknown handle is ignored.
   */
  shippingRateHandle: z.string().max(2000).optional(),
});

const placeSchema = orderSchema.extend({
  /** What the shopper was shown. The order is refused if it no longer holds. */
  expectedTotal: z.object({
    amount: z.string().regex(/^\d{1,12}(\.\d{1,4})?$/),
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
  }),
  /** Chosen by the widget once per order form, so a retry cannot order twice. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
});

type OrderDetails = z.infer<typeof orderSchema>;

const FORM_FIELDS: readonly OrderField[] = [
  "name",
  "phone",
  "email",
  "address1",
  "address2",
  "city",
  "province",
  "zip",
  "countryCode",
];

function parse<Schema extends z.ZodType>(schema: Schema, body: unknown): z.infer<Schema> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;

  const fields: Partial<Record<OrderField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[issue.path.length - 1] as OrderField;
    const inForm = issue.path[0] === "contact" || issue.path[0] === "address";
    if (inForm && FORM_FIELDS.includes(field) && !fields[field]) fields[field] = issue.message;
  }
  if (Object.keys(fields).length) {
    throw new OrderError("invalid_order", 422, "Please check the highlighted details.", { fields });
  }
  // Anything else is not something the shopper typed: the cart or the form
  // state is out of step with what this endpoint expects.
  throw new OrderError(
    "invalid_request",
    400,
    "Something went wrong with this order. Please start it again.",
  );
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const REMEMBER_PLACED_MS = 30 * MINUTE_MS;

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function enforce(
  deps: ChatOrderDeps,
  limits: Array<{ key: string; max: number; windowMs: number }>,
): void {
  for (const limit of limits) {
    const result = deps.rateLimiter.hit(limit.key, limit.max, limit.windowMs, deps.now().getTime());
    if (!result.allowed) {
      throw new OrderError(
        "rate_limited",
        429,
        "Too many orders from here for now. Please try again later or use the checkout.",
        { retryAfterSeconds: Math.ceil(result.retryAfterMs / 1000) },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Shopify calls
// ---------------------------------------------------------------------------

interface UserError {
  field?: string[] | null;
  message: string;
}

interface MoneySet {
  presentmentMoney: Money;
}

interface CalculatedDraftOrder {
  taxesIncluded: boolean;
  lineItems: Array<{
    title: string;
    variantTitle: string | null;
    quantity: number;
    requiresShipping: boolean;
    discountedTotalSet: MoneySet;
  }>;
  availableShippingRates: Array<{ handle: string; title: string; price: Money }>;
  subtotalPriceSet: MoneySet;
  totalShippingPriceSet: MoneySet;
  totalTaxSet: MoneySet;
  totalPriceSet: MoneySet;
}

/** "Ada Lovelace" is first name Ada, last name Lovelace; one word is a last name. */
export function splitName(name: string): { firstName: string | null; lastName: string } {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length < 2) return { firstName: null, lastName: words[0] ?? name };
  return { firstName: words.slice(0, -1).join(" "), lastName: words[words.length - 1] };
}

function draftOrderInput(order: OrderDetails): Record<string, unknown> {
  const { contact, address } = order;
  // People type either "ON" or "Ontario". A short code goes in the code
  // field; a name goes in the older free-text field, which Shopify matches
  // against the country's provinces.
  const province = /^[A-Za-z0-9]{1,3}$/.test(address.province)
    ? { provinceCode: address.province.toUpperCase() }
    : address.province
      ? { province: address.province }
      : {};

  return {
    lineItems: order.items.map((item) => ({
      variantId: `gid://shopify/ProductVariant/${item.variantId}`,
      quantity: item.quantity,
    })),
    shippingAddress: {
      ...splitName(contact.name),
      address1: address.address1,
      address2: address.address2 || null,
      city: address.city,
      zip: address.zip || null,
      countryCode: address.countryCode,
      phone: contact.phone,
      ...province,
    },
    ...(contact.email ? { email: contact.email } : {}),
  };
}

/** Shopify's own wording for a rejected address, mapped back to the form. */
function fieldErrors(errors: UserError[]): Partial<Record<OrderField, string>> {
  const fields: Partial<Record<OrderField, string>> = {};
  const names: Record<string, OrderField> = {
    address1: "address1",
    address2: "address2",
    city: "city",
    zip: "zip",
    province: "province",
    provinceCode: "province",
    countryCode: "countryCode",
    phone: "phone",
    email: "email",
    firstName: "name",
    lastName: "name",
  };
  for (const error of errors) {
    const field = names[error.field?.[error.field.length - 1] ?? ""];
    if (field && !fields[field]) fields[field] = error.message.slice(0, 200);
  }
  return fields;
}

async function calculate(
  admin: GraphqlFn,
  input: Record<string, unknown>,
): Promise<CalculatedDraftOrder> {
  const data = await admin<{
    draftOrderCalculate: {
      calculatedDraftOrder: CalculatedDraftOrder | null;
      userErrors: UserError[];
    } | null;
  }>(DRAFT_ORDER_CALCULATE_MUTATION, { input });

  const payload = data.draftOrderCalculate;
  if (payload?.userErrors.length) {
    const fields = fieldErrors(payload.userErrors);
    if (Object.keys(fields).length) {
      throw new OrderError("invalid_order", 422, "Please check the highlighted details.", {
        fields,
      });
    }
  }
  if (!payload?.calculatedDraftOrder || payload.userErrors.length) {
    throw new OrderError(
      "order_failed",
      502,
      "This order can't be worked out right now. Please use the checkout instead.",
    );
  }
  return payload.calculatedDraftOrder;
}

/**
 * Checks the items against the public catalog, then prices the order.
 *
 * The Admin API would happily sell a draft or unpublished product, so every
 * variant is first resolved through the Storefront API, which only knows what
 * the store has published.
 */
async function quoteOrder(input: ChatOrderInput, order: OrderDetails): Promise<OrderQuote> {
  const quantities = new Map<string, number>();
  for (const item of order.items) {
    quantities.set(
      item.variantId,
      Math.min(MAX_QUANTITY, (quantities.get(item.variantId) ?? 0) + item.quantity),
    );
  }
  order.items = [...quantities].map(([variantId, quantity]) => ({ variantId, quantity }));

  const catalog = await input.storefront<{
    nodes: Array<{ id?: string; availableForSale?: boolean } | null>;
  }>(VARIANTS_FOR_ORDER_QUERY, {
    ids: order.items.map((item) => `gid://shopify/ProductVariant/${item.variantId}`),
    country: order.address.countryCode,
  });
  const allAvailable = order.items.every((_, index) => {
    const variant = catalog.nodes?.[index];
    return Boolean(variant?.id && variant.availableForSale);
  });
  if (!allAvailable) {
    throw new OrderError(
      "unavailable",
      409,
      "Something in your cart is no longer available. Please check your cart and try again.",
    );
  }

  const draft = draftOrderInput(order);
  const unshipped = await calculate(input.admin, draft);

  if (!unshipped.lineItems.some((item) => item.requiresShipping)) {
    throw new OrderError(
      "undeliverable",
      409,
      "These items are not delivered, so they can't be paid for on delivery. Please use the checkout.",
    );
  }
  const rates = unshipped.availableShippingRates;
  if (!rates.length) {
    // Seen on a real store: Shopify returns no delivery options, and no error,
    // for an address without a state or postal code. Ask for what is missing
    // before telling the shopper the address cannot be delivered to.
    const fields: Partial<Record<OrderField, string>> = {};
    if (!order.address.zip) fields.zip = "Add your postal code so delivery can be worked out.";
    if (!order.address.province) {
      fields.province = "Add your state or province so delivery can be worked out.";
    }
    if (Object.keys(fields).length) {
      throw new OrderError(
        "invalid_order",
        422,
        "We need a bit more of your address to work out delivery.",
        { fields },
      );
    }
    throw new OrderError(
      "undeliverable",
      409,
      "We can't deliver to that address. Please check it, or use the checkout.",
    );
  }

  const cheapest = rates.reduce((best, rate) =>
    Number(rate.price.amount) < Number(best.price.amount) ? rate : best,
  );
  const chosen = rates.find((rate) => rate.handle === order.shippingRateHandle) ?? cheapest;
  const priced = await calculate(input.admin, {
    ...draft,
    shippingLine: { shippingRateHandle: chosen.handle },
  });

  const tax = priced.totalTaxSet.presentmentMoney;
  return {
    lines: priced.lineItems.map((item) => ({
      title:
        item.variantTitle && item.variantTitle !== "Default Title"
          ? `${item.title} (${item.variantTitle})`
          : item.title,
      quantity: item.quantity,
      total: item.discountedTotalSet.presentmentMoney,
    })),
    subtotal: priced.subtotalPriceSet.presentmentMoney,
    shipping: priced.totalShippingPriceSet.presentmentMoney,
    tax: !priced.taxesIncluded && Number(tax.amount) > 0 ? tax : null,
    total: priced.totalPriceSet.presentmentMoney,
    shippingRates: rates,
    shippingRateHandle: chosen.handle,
  };
}

const sameMoney = (a: Money, b: Money) =>
  a.currencyCode === b.currencyCode && Number(a.amount) === Number(b.amount);

async function placeOrder(
  input: ChatOrderInput,
  order: z.infer<typeof placeSchema>,
  testStore: boolean,
): Promise<ChatOrderResult> {
  const quote = await quoteOrder(input, order);
  if (!sameMoney(quote.total, order.expectedTotal)) {
    throw new OrderError(
      "quote_changed",
      409,
      "The total has changed. Please check the new total and confirm again.",
      { quote },
    );
  }

  const terms = await input.admin<{
    paymentTermsTemplates: Array<{ id: string; paymentTermsType: string }>;
  }>(PAY_ON_DELIVERY_TERMS_QUERY);
  const template = terms.paymentTermsTemplates?.find(
    (candidate) => candidate.paymentTermsType === "FULFILLMENT",
  );
  // Never complete an order without the terms: Shopify would record it as paid.
  if (!template) throw new Error("no pay-on-delivery payment terms template");

  const created = await input.admin<{
    draftOrderCreate: { draftOrder: { id: string } | null; userErrors: UserError[] } | null;
  }>(DRAFT_ORDER_CREATE_MUTATION, {
    input: {
      ...draftOrderInput(order),
      shippingLine: { shippingRateHandle: quote.shippingRateHandle },
      paymentTerms: { paymentTermsTemplateId: template.id },
      note: "Placed in the Shopi Assist chat. To be paid on delivery. The shopper's details were not verified.",
      tags: [
        "shopi-assist",
        "chat-order",
        "pay-on-delivery",
        ...(testStore ? ["shopi-assist-test"] : []),
      ],
    },
  });
  const draftId = created.draftOrderCreate?.draftOrder?.id;
  if (!draftId || created.draftOrderCreate?.userErrors.length) {
    throw new Error("draft order was not created");
  }

  try {
    const completed = await input.admin<{
      draftOrderComplete: {
        draftOrder: {
          order: { id: string; name: string; displayFinancialStatus: string | null } | null;
        } | null;
        userErrors: UserError[];
      } | null;
    }>(DRAFT_ORDER_COMPLETE_MUTATION, { id: draftId });

    const placed = completed.draftOrderComplete?.draftOrder?.order;
    if (!placed || completed.draftOrderComplete?.userErrors.length) {
      throw new Error("draft order was not completed");
    }
    if (placed.displayFinancialStatus === "PAID") {
      // Not expected with payment terms set. Worth a look by the developer.
      console.warn(
        `[shopi-assist] chat order for ${input.shop} was recorded as paid; check the payment terms setup`,
      );
    }
    return { ok: true, step: "place", order: { name: placed.name, total: quote.total } };
  } catch (error) {
    // Do not leave a half-made draft behind in the merchant's admin.
    await input
      .admin(DRAFT_ORDER_DELETE_MUTATION, { input: { id: draftId } })
      .catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const placedOrders = new Map<string, Remembered>();

export async function handleChatOrder(
  input: ChatOrderInput,
  overrides: Partial<ChatOrderDeps> = {},
): Promise<ChatOrderResult> {
  const deps: ChatOrderDeps = {
    db: overrides.db ?? prisma,
    rateLimiter: overrides.rateLimiter ?? defaultRateLimiter,
    placed: overrides.placed ?? placedOrders,
    isTestStore: overrides.isTestStore ?? isDevelopmentStore,
    now: overrides.now ?? (() => new Date()),
  };
  const now = deps.now().getTime();

  const settings = await getSettings(input.shop, deps.db);
  if (!settings.enabled || !settings.allowChatOrders || !settings.allowCheckout) {
    throw new OrderError("disabled", 403, "Ordering in the chat is not available for this store.");
  }

  const step = input.body.step;
  if (step !== "quote" && step !== "place") {
    throw new OrderError("invalid_request", 400, "Something went wrong. Please reload the page.");
  }
  const address = clientKey(input.ip);

  try {
    if (step === "quote") {
      const order = parse(orderSchema, input.body);
      enforce(deps, [
        { key: `order:quote:ip:${input.shop}:${address}`, max: 30, windowMs: 10 * MINUTE_MS },
        { key: `order:quote:shop:${input.shop}`, max: 600, windowMs: HOUR_MS },
      ]);
      return { ok: true, step: "quote", quote: await quoteOrder(input, order) };
    }

    const order = parse(placeSchema, input.body);

    // A retry of a request that already went through gets the same answer
    // and does not count against the limits again.
    for (const [key, remembered] of deps.placed) {
      if (remembered.expiresAt <= now) deps.placed.delete(key);
    }
    const rememberKey = `${input.shop}:${order.idempotencyKey}`;
    const remembered = deps.placed.get(rememberKey);
    if (remembered) return await remembered.result;

    const testStore = await deps.isTestStore(input.shop, input.admin);
    const perVisitor = testStore ? TEST_STORE_LIMIT_FACTOR : 1;
    enforce(deps, [
      {
        key: `order:place:ip:${input.shop}:${address}`,
        max: envNumber("CHAT_ORDERS_PER_IP_PER_HOUR", 10) * perVisitor,
        windowMs: HOUR_MS,
      },
      {
        key: `order:place:phone:${input.shop}:${fingerprint(order.contact.phone)}`,
        max: envNumber("CHAT_ORDERS_PER_PHONE_PER_DAY", 3) * perVisitor,
        windowMs: DAY_MS,
      },
      {
        key: `order:place:shop-hour:${input.shop}`,
        max: envNumber("CHAT_ORDERS_PER_SHOP_PER_HOUR", 60),
        windowMs: HOUR_MS,
      },
      {
        key: `order:place:shop-day:${input.shop}`,
        max: envNumber("CHAT_ORDERS_PER_SHOP_PER_DAY", 300),
        windowMs: DAY_MS,
      },
    ]);

    const result = placeOrder(input, order, testStore);
    deps.placed.set(rememberKey, { expiresAt: now + REMEMBER_PLACED_MS, result });
    // A failed attempt is forgotten, so the shopper can correct and resend.
    result.catch(() => deps.placed.delete(rememberKey));
    const placed = await result;
    console.info(`[shopi-assist] chat order placed shop=${input.shop}`);
    return placed;
  } catch (error) {
    if (error instanceof OrderError) throw error;
    // Log the kind of failure only: Shopify's messages can echo the address.
    console.error(
      `[shopi-assist] chat order failed shop=${input.shop} step=${step} error=${error instanceof Error ? error.name : "unknown"}${accessHint(error)}`,
    );
    throw new OrderError(
      "order_failed",
      502,
      "We couldn't place this order right now. Nothing was ordered. Please try again or use the checkout.",
    );
  }
}

export interface DeliveryCountry {
  code: string;
  name: string;
}

/**
 * The countries the order form offers: the ones the store sells to. An empty
 * list is a valid answer; the widget then offers only the country the shopper
 * is browsing in.
 */
export async function listDeliveryCountries(
  input: { shop: string; language?: string | null; ip?: string; storefront: GraphqlFn },
  overrides: Partial<ChatOrderDeps> = {},
): Promise<DeliveryCountry[]> {
  const deps: ChatOrderDeps = {
    db: overrides.db ?? prisma,
    rateLimiter: overrides.rateLimiter ?? defaultRateLimiter,
    placed: overrides.placed ?? placedOrders,
    isTestStore: overrides.isTestStore ?? isDevelopmentStore,
    now: overrides.now ?? (() => new Date()),
  };
  const settings = await getSettings(input.shop, deps.db);
  if (!settings.enabled || !settings.allowChatOrders || !settings.allowCheckout) {
    throw new OrderError("disabled", 403, "Ordering in the chat is not available for this store.");
  }
  enforce(deps, [
    {
      key: `order:countries:ip:${input.shop}:${clientKey(input.ip)}`,
      max: 30,
      windowMs: 10 * MINUTE_MS,
    },
  ]);

  const language = /^[A-Za-z]{2}$/.test(input.language ?? "") ? input.language!.toUpperCase() : null;
  try {
    const data = await input.storefront<{
      localization: { availableCountries: Array<{ isoCode: string; name: string }> } | null;
    }>(DELIVERY_COUNTRIES_QUERY, { language });
    return (data.localization?.availableCountries ?? [])
      .filter((country) => /^[A-Z]{2}$/.test(country.isoCode) && country.name)
      .map((country) => ({ code: country.isoCode, name: country.name.slice(0, 80) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    console.error(
      `[shopi-assist] delivery countries failed shop=${input.shop} error=${error instanceof Error ? error.name : "unknown"}`,
    );
    return [];
  }
}

/**
 * Shopify refuses draft orders until the app has been given protected
 * customer data access, and the refusal looks like any other failure. This
 * names it in the log, since it is the first thing to go wrong on a new app.
 */
function accessHint(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/not approved to access|protected-customer-data/i.test(message)) {
    return " reason=protected_customer_data (in the Dev Dashboard: app > Settings > Access requests > Protected customer data; select customer data plus name, address, phone and email)";
  }
  if (/access denied|ACCESS_DENIED/i.test(message)) {
    return " reason=access_denied (check that the app's scopes were approved on this store)";
  }
  return "";
}

/** Turns any thrown value into a JSON error response for the widget. */
export function orderErrorResponse(error: unknown): Response {
  if (error instanceof OrderError) {
    return Response.json(
      {
        error: { code: error.code, message: error.message, fields: error.extra.fields },
        quote: error.extra.quote,
      },
      {
        status: error.status,
        headers: {
          "Cache-Control": "no-store",
          ...(error.extra.retryAfterSeconds
            ? { "Retry-After": String(error.extra.retryAfterSeconds) }
            : {}),
        },
      },
    );
  }
  console.error(
    "[shopi-assist] unexpected chat order error:",
    error instanceof Error ? error.name : "unknown error",
  );
  return Response.json(
    { error: { code: "order_failed", message: "Something went wrong. Please try again." } },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}
