/**
 * What the storefront widget asks of the order endpoint, apart from carrying
 * out a confirmed change to an order (see order-actions.server.ts):
 *
 *   - the store's checkout for the items the shopper ticked, and
 *   - what the address form asks for, and the checking of what it collects,
 *     for a change of delivery address on the shopper's own order.
 *
 * Nothing here creates an order. An order is placed and paid for on the
 * store's own checkout page, whichever way the shopper pays, cash on delivery
 * included: the chat takes no orders and no payment details.
 *
 * None of this is reachable by the LLM: the widget posts here directly, so
 * names, phone numbers and addresses never pass through the model or the
 * stored transcript.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

import prisma from "../db.server";
import {
  addressErrors,
  formLayouts,
  onlyFormFields,
  type FormLayout,
  type FormOptions,
} from "./address-rules";
import { clientKey, rateLimiter as defaultRateLimiter, type RateLimiter } from "./rate-limit";
import { getSettings, type AssistantSettings } from "./settings.server";
import { CHECKOUT_CART_MUTATION, DELIVERY_COUNTRIES_QUERY } from "./tools/storefront-queries";
import type { GraphqlFn } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrderErrorCode =
  | "invalid_request"
  | "invalid_order"
  | "disabled"
  | "rate_limited"
  | "unavailable"
  | "order_failed";

/** Which form field a message belongs to. */
export type OrderField =
  | "firstName"
  | "lastName"
  | "phone"
  | "email"
  | "company"
  | "address1"
  | "address2"
  | "city"
  | "province"
  | "zip"
  | "countryCode";

/** An error with a message that is safe to show to the shopper. */
export class OrderError extends Error {
  constructor(
    public readonly code: OrderErrorCode,
    public readonly status: number,
    message: string,
    public readonly extra: {
      fields?: Partial<Record<OrderField, string>>;
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(message);
    this.name = "OrderError";
  }
}

/** Where to pay for the ticked items on the store's own checkout. */
export interface CheckoutResult {
  ok: true;
  step: "checkout";
  checkoutUrl: string;
}

export interface OrderRequestInput {
  /** Shop domain from the authenticated request. Never from the request body. */
  shop: string;
  /** The untrusted JSON the widget posted. */
  body: Record<string, unknown>;
  ip?: string;
  storefront: GraphqlFn;
}

export interface OrderDeps {
  db: PrismaClient;
  rateLimiter: RateLimiter;
  now: () => Date;
}

const withDefaults = (overrides: Partial<OrderDeps>): OrderDeps => ({
  db: overrides.db ?? prisma,
  rateLimiter: overrides.rateLimiter ?? defaultRateLimiter,
  now: overrides.now ?? (() => new Date()),
});

// ---------------------------------------------------------------------------
// The address form: what it sends, and the checking of it
// ---------------------------------------------------------------------------

const line = (max: number, tooLong: string) => z.string().trim().max(max, tooLong);

/** Who and where, as the address form collects them. */
export const deliverySchema = z.object({
  contact: z.object({
    // Whether a first name is needed is the store's choice: see checkDelivery.
    firstName: line(40, "Keep the first name under 40 characters.").default(""),
    lastName: line(40, "Keep the last name under 40 characters.").min(1, "Enter your last name."),
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
  // Only the limits are checked here. What each country and store needs
  // filled in, and what a postal code looks like, is checked by checkDelivery.
  address: z.object({
    company: line(80, "Keep the company name under 80 characters.").default(""),
    address1: line(120, "Keep the address under 120 characters.").min(
      3,
      "Enter your street address.",
    ),
    address2: line(120, "Keep this under 120 characters.").default(""),
    city: line(80, "Keep the city under 80 characters.").default(""),
    province: line(60, "Keep this under 60 characters.").default(""),
    zip: line(16, "Keep the postal code under 16 characters.").default(""),
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, "Choose a country.")
      .transform((value) => value.toUpperCase()),
  }),
});
export type DeliveryDetails = z.infer<typeof deliverySchema>;

const FORM_FIELDS: readonly OrderField[] = [
  "firstName",
  "lastName",
  "phone",
  "email",
  "company",
  "address1",
  "address2",
  "city",
  "province",
  "zip",
  "countryCode",
];

export function parse<Schema extends z.ZodType>(schema: Schema, body: unknown): z.infer<Schema> {
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
  // Anything else is not something the shopper typed: the form's state is
  // out of step with what this endpoint expects.
  throw new OrderError("invalid_request", 400, "Something went wrong. Please start again.");
}

/** The store's choices for the address form, as the address rules take them. */
export function orderFormOptions(
  settings: Pick<AssistantSettings, "orderFirstName" | "orderCompany" | "orderAddress2">,
): FormOptions {
  return {
    firstName: settings.orderFirstName,
    company: settings.orderCompany,
    address2: settings.orderAddress2,
  };
}

/**
 * Checks who and where against what the delivery country and the store ask
 * for, the way Shopify's checkout does: every needed field filled in, and a
 * postal code that looks like one. Returns the details with anything the
 * form does not show for that country blanked.
 */
export function checkDelivery<Details extends DeliveryDetails>(
  details: Details,
  options: FormOptions,
): Details {
  const { contact, address } = details;
  const typed = {
    firstName: contact.firstName,
    lastName: contact.lastName,
    phone: contact.phone,
    company: address.company,
    address1: address.address1,
    address2: address.address2,
    city: address.city,
    province: address.province,
    zip: address.zip,
  };
  const fields = addressErrors(address.countryCode, typed, options);
  if (Object.keys(fields).length) {
    throw new OrderError("invalid_order", 422, "Please check the highlighted details.", { fields });
  }
  const kept = onlyFormFields(address.countryCode, typed, options);
  return {
    ...details,
    contact: { ...contact, firstName: kept.firstName },
    address: {
      ...address,
      company: kept.company,
      address2: kept.address2,
      city: kept.city,
      province: kept.province,
      zip: kept.zip,
    },
  };
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

function enforce(
  deps: OrderDeps,
  limits: Array<{ key: string; max: number; windowMs: number }>,
): void {
  for (const limit of limits) {
    const result = deps.rateLimiter.hit(limit.key, limit.max, limit.windowMs, deps.now().getTime());
    if (!result.allowed) {
      throw new OrderError(
        "rate_limited",
        429,
        "Too many requests from here for now. Please try again in a little while.",
        { retryAfterSeconds: Math.ceil(result.retryAfterMs / 1000) },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Shopify's shapes
// ---------------------------------------------------------------------------

export interface UserError {
  field?: string[] | null;
  message: string;
}

/** The delivery address in the shape Shopify's Admin API takes. */
export function shippingAddressInput({ contact, address }: DeliveryDetails): Record<string, unknown> {
  // People type either "ON" or "Ontario". A short code goes in the code
  // field; a name goes in the older free-text field, which Shopify matches
  // against the country's provinces.
  const province = /^[A-Za-z0-9]{1,3}$/.test(address.province)
    ? { provinceCode: address.province.toUpperCase() }
    : address.province
      ? { province: address.province }
      : {};

  return {
    firstName: contact.firstName || null,
    lastName: contact.lastName,
    company: address.company || null,
    address1: address.address1,
    address2: address.address2 || null,
    city: address.city,
    zip: address.zip || null,
    countryCode: address.countryCode,
    phone: contact.phone,
    ...province,
  };
}

/** Shopify's own wording for a rejected address, mapped back to the form. */
export function fieldErrors(errors: UserError[]): Partial<Record<OrderField, string>> {
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
    firstName: "firstName",
    lastName: "lastName",
  };
  for (const error of errors) {
    const field = names[error.field?.[error.field.length - 1] ?? ""];
    if (field && !fields[field]) fields[field] = error.message.slice(0, 200);
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Checkout for part of the cart
// ---------------------------------------------------------------------------

// A cart, not an order: nothing is created in the store.
const checkoutSchema = z.object({
  items: z
    .array(
      z.object({
        variantId: z.string().regex(/^\d{1,20}$/),
        quantity: z.number().int().min(1).max(999),
        /** A subscription the line was added with. */
        sellingPlanId: z.string().regex(/^\d{1,20}$/).optional(),
        /** What the shopper chose or typed for the line, such as an engraving. */
        properties: z.record(z.string().min(1).max(100), z.string().max(500)).optional(),
      }),
    )
    .min(1)
    .max(50),
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .optional(),
  discountCodes: z.array(z.string().min(1).max(100)).max(5).optional(),
});

/**
 * The store's checkout for just the items the shopper ticked. Shopify's
 * checkout always takes a whole cart, so these go into a cart of their own;
 * the cart on the storefront, with whatever was not ticked, stays as it is.
 * Everything else (delivery, tax, how to pay) is the checkout's business.
 */
export async function openCheckout(
  input: OrderRequestInput,
  overrides: Partial<OrderDeps> = {},
): Promise<CheckoutResult> {
  const deps = withDefaults(overrides);
  const settings = await getSettings(input.shop, deps.db);
  if (!settings.enabled) {
    throw new OrderError("disabled", 403, "Checkout from the chat is not available for this store.");
  }
  const parsed = checkoutSchema.safeParse(input.body);
  if (!parsed.success) {
    throw new OrderError("invalid_request", 400, "Something went wrong. Please try again.");
  }
  enforce(deps, [
    {
      key: `order:checkout:ip:${input.shop}:${clientKey(input.ip)}`,
      max: 30,
      windowMs: 10 * MINUTE_MS,
    },
    { key: `order:checkout:shop:${input.shop}`, max: 1200, windowMs: HOUR_MS },
  ]);

  const { items, country, discountCodes } = parsed.data;
  const unavailable = new OrderError(
    "unavailable",
    409,
    "The checkout couldn't be opened for these items. Please try again.",
  );
  let created: {
    cart: { checkoutUrl: string; totalQuantity: number } | null;
    userErrors: Array<{ code: string | null }>;
  } | null;
  try {
    const data = await input.storefront<{ cartCreate: typeof created }>(CHECKOUT_CART_MUTATION, {
      country: country?.toUpperCase() ?? null,
      input: {
        lines: items.map((item) => ({
          merchandiseId: `gid://shopify/ProductVariant/${item.variantId}`,
          quantity: item.quantity,
          ...(item.sellingPlanId
            ? { sellingPlanId: `gid://shopify/SellingPlan/${item.sellingPlanId}` }
            : {}),
          ...(item.properties && Object.keys(item.properties).length
            ? {
                attributes: Object.entries(item.properties)
                  .slice(0, 25)
                  .map(([key, value]) => ({ key, value })),
              }
            : {}),
        })),
        ...(discountCodes?.length ? { discountCodes } : {}),
      },
    });
    created = data.cartCreate;
  } catch (error) {
    console.error(
      `[shopi-assist] checkout cart failed shop=${input.shop} error=${error instanceof Error ? error.name : "unknown"}`,
    );
    throw unavailable;
  }

  const cart = created?.cart;
  if (!cart || created?.userErrors.length || !/^https:\/\/[^\s]+$/.test(cart.checkoutUrl)) {
    const codes = (created?.userErrors ?? []).map((error) => error.code ?? "unknown").join(",");
    console.error(`[shopi-assist] checkout cart refused shop=${input.shop} codes=${codes || "none"}`);
    throw unavailable;
  }
  if (cart.totalQuantity < 1) {
    throw new OrderError("unavailable", 409, "These items are sold out, so they can't be bought right now.");
  }
  return { ok: true, step: "checkout", checkoutUrl: cart.checkoutUrl };
}

// ---------------------------------------------------------------------------
// What the address form asks for
// ---------------------------------------------------------------------------

export interface DeliveryCountry {
  code: string;
  name: string;
  /** Which of the `forms` sent with the countries this one uses. */
  form: number;
}

/** What the address form needs before it can be drawn. */
export interface DeliveryOptions {
  countries: DeliveryCountry[];
  /** Each distinct layout once; a country points at its own by position. */
  forms: FormLayout[];
}

/**
 * The countries the store sells to, each with the address form its addresses
 * take. An empty list is a valid answer; the widget then offers only the
 * country of the order whose address is being changed.
 */
export async function listDeliveryCountries(
  input: { shop: string; language?: string | null; ip?: string; storefront: GraphqlFn },
  overrides: Partial<OrderDeps> = {},
): Promise<DeliveryOptions> {
  const deps = withDefaults(overrides);
  const settings = await getSettings(input.shop, deps.db);
  // The form is for changing an order's delivery address, and for nothing else.
  if (!settings.enabled || !settings.allowAddressChange) {
    throw new OrderError("disabled", 403, "Address changes in the chat are not available for this store.");
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
    const countries = (data.localization?.availableCountries ?? [])
      .filter((country) => /^[A-Z]{2}$/.test(country.isoCode) && country.name)
      .map((country) => ({ code: country.isoCode, name: country.name.slice(0, 80) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const { forms, index } = formLayouts(
      countries.map((country) => country.code),
      orderFormOptions(settings),
    );
    return {
      countries: countries.map((country) => ({ ...country, form: index[country.code] })),
      forms,
    };
  } catch (error) {
    console.error(
      `[shopi-assist] delivery countries failed shop=${input.shop} error=${error instanceof Error ? error.name : "unknown"}`,
    );
    return { countries: [], forms: [] };
  }
}

/** Turns any thrown value into a JSON error response for the widget. */
export function orderErrorResponse(error: unknown): Response {
  if (error instanceof OrderError) {
    return Response.json(
      { error: { code: error.code, message: error.message, fields: error.extra.fields } },
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
    "[shopi-assist] unexpected order endpoint error:",
    error instanceof Error ? error.name : "unknown error",
  );
  return Response.json(
    { error: { code: "order_failed", message: "Something went wrong. Please try again." } },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}
