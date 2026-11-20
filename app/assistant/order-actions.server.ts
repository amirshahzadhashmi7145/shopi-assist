/**
 * Changes to an order that already exists: cancel it, send it to a new
 * address, or change its items.
 *
 * Three rules hold for all of them:
 *
 *  1. Only before the order starts shipping. Once any part of it is being
 *     fulfilled the change is refused, here and again at the moment it is
 *     carried out. (`blocker` is the one place that decides.)
 *  2. Only for an order proved to be the shopper's. A tool hands out a signed
 *     grant after that proof; an order number alone never gets one.
 *  3. Only when the shopper presses a button. The grant comes back to
 *     `handleOrderAction` from the widget, not from the model, so the model
 *     cannot change an order on its own.
 *
 * Money never moves: an order is cancelled or re-priced here only while
 * nothing has been paid for it. A paid order's cancellation is passed to the
 * merchant as a tagged request.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

import prisma from "../db.server";
import {
  grantSecret,
  readGrant,
  type OrderActionGrant,
  type OrderActionKind,
} from "./action-grant.server";
import {
  deliverySchema,
  fieldErrors,
  OrderError,
  parse,
  shippingAddressInput,
  type UserError,
} from "./orders.server";
import { clientKey, rateLimiter as defaultRateLimiter, type RateLimiter } from "./rate-limit";
import { getSettings, type AssistantSettings } from "./settings.server";
import { appendExchange } from "./store.server";
import type { GraphqlFn, Money } from "./types";

// ---------------------------------------------------------------------------
// Admin API documents
// ---------------------------------------------------------------------------

/** Admin API. What decides whether an order can still be changed, and its items. */
export const ORDER_FOR_ACTION_QUERY = `#graphql
  query ShopiAssistOrderForAction($id: ID!) {
    order(id: $id) {
      id
      name
      note
      cancelledAt
      closed
      displayFulfillmentStatus
      displayFinancialStatus
      fulfillments(first: 10) { status }
      totalReceivedSet { presentmentMoney { amount currencyCode } }
      currentTotalPriceSet { presentmentMoney { amount currencyCode } }
      shippingAddress { countryCodeV2 }
      lineItems(first: 50) {
        nodes {
          title
          variantTitle
          currentQuantity
          variant { id }
          discountedUnitPriceSet { presentmentMoney { amount currencyCode } }
        }
      }
    }
  }
`;

export const ORDER_CANCEL_MUTATION = `#graphql
  mutation ShopiAssistOrderCancel($orderId: ID!, $staffNote: String) {
    orderCancel(
      orderId: $orderId
      reason: CUSTOMER
      restock: true
      notifyCustomer: true
      staffNote: $staffNote
    ) {
      job { id }
      orderCancelUserErrors { field message }
      userErrors { field message }
    }
  }
`;

export const ORDER_UPDATE_MUTATION = `#graphql
  mutation ShopiAssistOrderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id }
      userErrors { field message }
    }
  }
`;

export const ORDER_TAGS_ADD_MUTATION = `#graphql
  mutation ShopiAssistOrderTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

export const ORDER_EDIT_BEGIN_MUTATION = `#graphql
  mutation ShopiAssistOrderEditBegin($id: ID!) {
    orderEditBegin(id: $id) {
      calculatedOrder {
        id
        lineItems(first: 50) {
          nodes { id quantity variant { id } }
        }
      }
      userErrors { field message }
    }
  }
`;

export const ORDER_EDIT_SET_QUANTITY_MUTATION = `#graphql
  mutation ShopiAssistOrderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!) {
    orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity, restock: true) {
      calculatedOrder { id }
      userErrors { field message }
    }
  }
`;

export const ORDER_EDIT_ADD_VARIANT_MUTATION = `#graphql
  mutation ShopiAssistOrderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
    orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, allowDuplicates: false) {
      calculatedOrder { id }
      userErrors { field message }
    }
  }
`;

export const ORDER_EDIT_COMMIT_MUTATION = `#graphql
  mutation ShopiAssistOrderEditCommit($id: ID!, $staffNote: String) {
    orderEditCommit(id: $id, notifyCustomer: true, staffNote: $staffNote) {
      order {
        name
        currentTotalPriceSet { presentmentMoney { amount currencyCode } }
      }
      userErrors { field message }
    }
  }
`;

// ---------------------------------------------------------------------------
// The order, as far as changing it is concerned
// ---------------------------------------------------------------------------

export interface ActionOrder {
  id: string;
  name: string;
  note: string;
  cancelled: boolean;
  closed: boolean;
  fulfillmentStatus: string;
  /** True while any fulfilment exists that was not itself cancelled. */
  hasFulfillments: boolean;
  /** True while nothing has been paid or authorised: cancelling moves no money. */
  nothingPaid: boolean;
  /** Where it is going. Null for an order with no delivery address. */
  countryCode: string | null;
  total: Money;
  lines: Array<{
    /** Numeric variant id, or null for a custom item. */
    variantId: string | null;
    title: string;
    quantity: number;
    unitPrice: Money;
  }>;
}

interface AdminOrder {
  id: string;
  name: string;
  note: string | null;
  cancelledAt: string | null;
  closed: boolean;
  displayFulfillmentStatus: string;
  displayFinancialStatus: string | null;
  fulfillments: Array<{ status: string }>;
  totalReceivedSet: { presentmentMoney: Money };
  currentTotalPriceSet: { presentmentMoney: Money };
  shippingAddress: { countryCodeV2: string | null } | null;
  lineItems: {
    nodes: Array<{
      title: string;
      variantTitle: string | null;
      currentQuantity: number;
      variant: { id: string } | null;
      discountedUnitPriceSet: { presentmentMoney: Money };
    }>;
  };
}

const numericId = (gid: string) => /(\d+)$/.exec(gid)?.[1] ?? null;

/** Reads the order afresh from Shopify. Throws when it is not there. */
export async function loadActionOrder(admin: GraphqlFn, orderId: string): Promise<ActionOrder> {
  const data = await admin<{ order: AdminOrder | null }>(ORDER_FOR_ACTION_QUERY, { id: orderId });
  const order = data.order;
  if (!order) throw new Error("order not found");

  return {
    id: order.id,
    name: order.name,
    note: order.note ?? "",
    cancelled: Boolean(order.cancelledAt),
    closed: order.closed,
    fulfillmentStatus: order.displayFulfillmentStatus,
    hasFulfillments: order.fulfillments.some((fulfillment) => fulfillment.status !== "CANCELLED"),
    nothingPaid:
      order.displayFinancialStatus === "PENDING" &&
      Number(order.totalReceivedSet.presentmentMoney.amount) === 0,
    countryCode: order.shippingAddress?.countryCodeV2 ?? null,
    total: order.currentTotalPriceSet.presentmentMoney,
    lines: order.lineItems.nodes
      .filter((line) => line.currentQuantity > 0)
      .map((line) => ({
        variantId: line.variant ? numericId(line.variant.id) : null,
        title:
          line.variantTitle && line.variantTitle !== "Default Title"
            ? `${line.title} (${line.variantTitle})`
            : line.title,
        quantity: line.currentQuantity,
        unitPrice: line.discountedUnitPriceSet.presentmentMoney,
      })),
  };
}

export type Blocker = "cancelled" | "shipping_started" | "closed";

/**
 * Why this order can no longer be cancelled or changed, or null when it can.
 *
 * "Unfulfilled" is the only state that allows a change. Anything else means
 * shipping has started in some way: fulfilled, partly fulfilled, handed to a
 * fulfilment service, scheduled or on hold. A parcel that is packed or on its
 * way cannot be un-sent by editing the order, so the answer then is a return.
 */
export function blocker(order: ActionOrder): Blocker | null {
  if (order.cancelled) return "cancelled";
  if (order.fulfillmentStatus !== "UNFULFILLED" || order.hasFulfillments) return "shipping_started";
  if (order.closed) return "closed";
  return null;
}

/** What to tell the shopper, in a sentence that fits after any of the actions. */
export function blockerMessage(order: ActionOrder, reason: Blocker): string {
  if (reason === "cancelled") return `Order ${order.name} has already been cancelled.`;
  if (reason === "shipping_started") {
    return `Order ${order.name} is already being prepared or has shipped, so it can no longer be cancelled or changed here.`;
  }
  return `Order ${order.name} is closed, so it can no longer be changed here.`;
}

// ---------------------------------------------------------------------------
// Carrying out a confirmed action
// ---------------------------------------------------------------------------

export interface OrderActionInput {
  /** Shop domain from the authenticated request. Never from the request body. */
  shop: string;
  /** The untrusted JSON the widget posted. */
  body: Record<string, unknown>;
  ip?: string;
  admin: GraphqlFn;
}

export interface OrderActionDeps {
  db: PrismaClient;
  rateLimiter: RateLimiter;
  /** The app's signing secret. Undefined means nothing can be confirmed. */
  secret: string | undefined;
  now: () => Date;
}

export interface OrderActionResult {
  ok: true;
  step: OrderActionKind;
  order: { name: string };
  /** A sentence for the shopper, shown in the chat. */
  message: string;
}

export const ORDER_ACTION_STEPS: readonly OrderActionKind[] = [
  "cancel",
  "cancel_request",
  "address",
  "edit",
];

const HOUR_MS = 3_600_000;

const SETTING: Record<OrderActionKind, keyof AssistantSettings> = {
  cancel: "allowOrderCancel",
  cancel_request: "allowOrderCancel",
  address: "allowAddressChange",
  edit: "allowOrderEdit",
};

const GONE = "This has expired. Please ask the assistant again.";

function failIfErrors(label: string, errors: UserError[] | undefined | null): void {
  if (errors?.length) throw new Error(`${label} was refused`);
}

async function addTags(admin: GraphqlFn, orderId: string, tags: string[]): Promise<void> {
  // A missing tag never undoes the change it describes, so this cannot fail it.
  await admin(ORDER_TAGS_ADD_MUTATION, { id: orderId, tags }).catch(() => undefined);
}

async function cancelOrder(
  admin: GraphqlFn,
  order: ActionOrder,
  grant: OrderActionGrant,
): Promise<string> {
  if (!order.nothingPaid) {
    throw new OrderError(
      "unavailable",
      409,
      `Order ${order.name} has been paid since you asked, so the store needs to cancel and refund it. Please ask the assistant again.`,
    );
  }
  const data = await admin<{
    orderCancel: { orderCancelUserErrors: UserError[]; userErrors: UserError[] } | null;
  }>(ORDER_CANCEL_MUTATION, {
    orderId: order.id,
    staffNote: `Cancelled by the customer in the Shopi Assist chat.${grant.reason ? ` Reason: ${grant.reason}` : ""}`.slice(0, 255),
  });
  failIfErrors("cancel", data.orderCancel?.orderCancelUserErrors);
  failIfErrors("cancel", data.orderCancel?.userErrors);
  await addTags(admin, order.id, ["cancelled-in-chat"]);
  return `Order ${order.name} is cancelled. Nothing had been charged for it.`;
}

async function requestCancellation(
  admin: GraphqlFn,
  order: ActionOrder,
  grant: OrderActionGrant,
  now: Date,
): Promise<string> {
  const line = `Cancellation requested by the customer in the Shopi Assist chat on ${now.toISOString().slice(0, 10)}.${grant.reason ? ` Reason: ${grant.reason}` : ""}`;
  const data = await admin<{ orderUpdate: { userErrors: UserError[] } | null }>(
    ORDER_UPDATE_MUTATION,
    { input: { id: order.id, note: [order.note, line].filter(Boolean).join("\n").slice(0, 5000) } },
  );
  failIfErrors("cancellation request", data.orderUpdate?.userErrors);
  await addTags(admin, order.id, ["cancellation-requested"]);
  return `Your request to cancel order ${order.name} has been sent to the store. They will confirm the cancellation and the refund.`;
}

const addressSchema = deliverySchema;

async function changeAddress(
  admin: GraphqlFn,
  order: ActionOrder,
  grant: OrderActionGrant,
  body: Record<string, unknown>,
): Promise<string> {
  const details = parse(addressSchema, body);
  // A different country means different delivery charges, duties and tax,
  // none of which this can re-work. That is a conversation with the store.
  if (grant.countryCode && details.address.countryCode !== grant.countryCode) {
    throw new OrderError("invalid_order", 422, "Please check the highlighted details.", {
      fields: {
        countryCode:
          "The country can't be changed here. Please contact the store to send this order to another country.",
      },
    });
  }

  const data = await admin<{ orderUpdate: { userErrors: UserError[] } | null }>(
    ORDER_UPDATE_MUTATION,
    { input: { id: order.id, shippingAddress: shippingAddressInput(details) } },
  );
  const errors = data.orderUpdate?.userErrors ?? [];
  if (errors.length) {
    const fields = fieldErrors(errors);
    if (Object.keys(fields).length) {
      throw new OrderError("invalid_order", 422, "Please check the highlighted details.", { fields });
    }
    throw new Error("address change was refused");
  }
  await addTags(admin, order.id, ["address-changed-in-chat"]);
  return `The delivery address for order ${order.name} is updated.`;
}

const variantGid = (variantId: string) => `gid://shopify/ProductVariant/${variantId}`;

async function editItems(
  admin: GraphqlFn,
  order: ActionOrder,
  grant: OrderActionGrant,
): Promise<string> {
  if (!order.nothingPaid) {
    throw new OrderError(
      "unavailable",
      409,
      `Order ${order.name} has been paid, so its items can't be changed here. Please contact the store.`,
    );
  }
  const changes = grant.changes ?? [];
  if (!changes.length) throw new Error("grant has no changes");

  const begun = await admin<{
    orderEditBegin: {
      calculatedOrder: {
        id: string;
        lineItems: { nodes: Array<{ id: string; quantity: number; variant: { id: string } | null }> };
      } | null;
      userErrors: UserError[];
    } | null;
  }>(ORDER_EDIT_BEGIN_MUTATION, { id: order.id });
  failIfErrors("order edit", begun.orderEditBegin?.userErrors);
  const edit = begun.orderEditBegin?.calculatedOrder;
  if (!edit) throw new Error("order edit did not start");

  // Quantities are what each item should end up with, not what to add, so a
  // repeated confirmation finds the order already as asked and changes nothing.
  for (const change of changes) {
    const line = edit.lineItems.nodes.find(
      (candidate) => candidate.variant?.id === variantGid(change.variantId) && candidate.quantity > 0,
    );
    if (line) {
      if (line.quantity === change.quantity) continue;
      const set = await admin<{ orderEditSetQuantity: { userErrors: UserError[] } | null }>(
        ORDER_EDIT_SET_QUANTITY_MUTATION,
        { id: edit.id, lineItemId: line.id, quantity: change.quantity },
      );
      failIfErrors("quantity change", set.orderEditSetQuantity?.userErrors);
    } else if (change.quantity > 0) {
      const added = await admin<{ orderEditAddVariant: { userErrors: UserError[] } | null }>(
        ORDER_EDIT_ADD_VARIANT_MUTATION,
        { id: edit.id, variantId: variantGid(change.variantId), quantity: change.quantity },
      );
      failIfErrors("added item", added.orderEditAddVariant?.userErrors);
    }
  }

  const committed = await admin<{
    orderEditCommit: {
      order: { name: string; currentTotalPriceSet: { presentmentMoney: Money } } | null;
      userErrors: UserError[];
    } | null;
  }>(ORDER_EDIT_COMMIT_MUTATION, {
    id: edit.id,
    staffNote: "Items changed by the customer in the Shopi Assist chat.",
  });
  failIfErrors("order edit", committed.orderEditCommit?.userErrors);
  const updated = committed.orderEditCommit?.order;
  if (!updated) throw new Error("order edit was not saved");

  await addTags(admin, order.id, ["changed-in-chat"]);
  const total = updated.currentTotalPriceSet.presentmentMoney;
  return `Order ${updated.name} is updated. The new total is ${price(total)}, to be paid on delivery.`;
}

/** "$27.90", or "27.90 XYZ" for a currency this server cannot format. */
function price(money: { amount: string; currencyCode: string }): string {
  const amount = Number(money.amount);
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: money.currencyCode }).format(amount);
  } catch {
    return `${Number.isFinite(amount) ? amount.toFixed(2) : money.amount} ${money.currencyCode}`;
  }
}

/** What the shopper did, for the chat's own record of it. */
const PRESSED: Record<OrderActionKind, string> = {
  cancel: "(I confirmed cancelling the order with the button.)",
  cancel_request: "(I confirmed the cancellation request with the button.)",
  address: "(I entered a new delivery address in the form.)",
  edit: "(I confirmed the change to my order with the button.)",
};

const actionSchema = z.object({ token: z.string().min(20).max(8000) });

export async function handleOrderAction(
  input: OrderActionInput,
  overrides: Partial<OrderActionDeps> = {},
): Promise<OrderActionResult> {
  const deps: OrderActionDeps = {
    db: overrides.db ?? prisma,
    rateLimiter: overrides.rateLimiter ?? defaultRateLimiter,
    secret: "secret" in overrides ? overrides.secret : grantSecret(),
    now: overrides.now ?? (() => new Date()),
  };
  const now = deps.now();
  const step = input.body.step as OrderActionKind;

  const token = actionSchema.safeParse(input.body);
  const grant =
    deps.secret && token.success
      ? readGrant(token.data.token, { shop: input.shop, secret: deps.secret, now: now.getTime() })
      : null;
  // One answer for every way a grant can be wrong, so nothing is learned by trying.
  if (!grant || grant.kind !== step) throw new OrderError("invalid_request", 410, GONE);

  const settings = await getSettings(input.shop, deps.db);
  if (!settings.enabled || !settings[SETTING[grant.kind]]) {
    throw new OrderError("disabled", 403, "This is not available for this store any more.");
  }

  for (const [key, max] of [
    [`order-action:ip:${input.shop}:${clientKey(input.ip)}`, 20],
    [`order-action:order:${input.shop}:${grant.orderId}`, 8],
  ] as const) {
    const result = deps.rateLimiter.hit(key, max, HOUR_MS, now.getTime());
    if (!result.allowed) {
      throw new OrderError("rate_limited", 429, "Too many changes for now. Please try again later.", {
        retryAfterSeconds: Math.ceil(result.retryAfterMs / 1000),
      });
    }
  }

  try {
    // Read again now: the order may have started shipping since the card was shown.
    const order = await loadActionOrder(input.admin, grant.orderId);
    const blocked = blocker(order);
    if (blocked) throw new OrderError("unavailable", 409, blockerMessage(order, blocked));

    const message =
      grant.kind === "cancel"
        ? await cancelOrder(input.admin, order, grant)
        : grant.kind === "cancel_request"
          ? await requestCancellation(input.admin, order, grant, now)
          : grant.kind === "address"
            ? await changeAddress(input.admin, order, grant, input.body)
            : await editItems(input.admin, order, grant);

    console.info(`[shopi-assist] order action done shop=${input.shop} kind=${grant.kind}`);
    if (grant.conversationId) {
      // So the assistant knows what happened. The change stands either way.
      await appendExchange(
        deps.db,
        input.shop,
        grant.conversationId,
        PRESSED[grant.kind],
        message,
        { now },
      ).catch(() => undefined);
    }
    return { ok: true, step: grant.kind, order: { name: order.name }, message };
  } catch (error) {
    if (error instanceof OrderError) throw error;
    console.error(
      `[shopi-assist] order action failed shop=${input.shop} kind=${grant.kind} error=${error instanceof Error ? error.name : "unknown"}`,
    );
    throw new OrderError(
      "order_failed",
      502,
      "That couldn't be done right now. Nothing was changed. Please try again or contact the store.",
    );
  }
}
