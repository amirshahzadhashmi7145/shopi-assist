/**
 * Shopper tools that start a change to an existing order: cancel it, send it
 * to a new address, or change its items.
 *
 * None of these changes anything. Each one checks that the order is proved
 * to be the shopper's and has not started shipping, then hands the widget a
 * signed grant. The widget shows a card, and the change is carried out by
 * `order-actions.server.ts` only when the shopper presses its button.
 */
import { z } from "zod";

import {
  blocker,
  loadActionOrder,
  type ActionOrder,
  type Blocker,
} from "../order-actions.server";
import type { Money } from "../types";
import { defineTool, ToolError, type ToolContext, type ToolDefinition } from "./registry";
import { findVerifiedOrder, orderProofSchema } from "./shopper";
import { VARIANTS_FOR_ORDER_QUERY } from "./storefront-queries";

const MAX_LINES = 10;
const MAX_QUANTITY = 10;

const money = (value: Money) => `${value.amount} ${value.currencyCode}`;

function decimalPlaces(amount: string): number {
  return (amount.split(".")[1] ?? "").length;
}

/** What to tell the model when the order can no longer be changed. */
function refusal(order: ActionOrder, reason: Blocker, returnsOn: boolean): string {
  if (reason === "cancelled") return `Order ${order.name} has already been cancelled. Tell the shopper.`;
  if (reason === "closed") {
    return `Order ${order.name} is closed and cannot be changed in the chat. Suggest contacting the store.`;
  }
  return `Order ${order.name} is already being prepared or has shipped, so it can no longer be cancelled or changed. Tell the shopper plainly.${
    returnsOn
      ? " Once it arrives they can ask for a return, which you can help with."
      : " Suggest contacting the store."
  }`;
}

/** The shopper's order, proved and still changeable, or a ToolError saying why not. */
async function changeableOrder(
  context: ToolContext,
  proof: { orderNumber: string; email?: string; phone?: string },
): Promise<ActionOrder> {
  // Proof, or an order the server already tied to this chat. A bare order
  // number is never enough to change anything.
  const found = await findVerifiedOrder(context, proof.orderNumber, proof.email, proof.phone);
  const order = await loadActionOrder(context.admin!, found.id);
  const blocked = blocker(order);
  if (blocked) throw new ToolError(refusal(order, blocked, context.settings.allowReturns));
  return order;
}

const available = (context: ToolContext, enabled: boolean | undefined) =>
  Boolean(context.admin) && Boolean(context.grantOrderAction) && Boolean(enabled);

const CONFIRM_NOTE =
  "A card with a confirm button is now shown in the chat. Nothing has been changed yet: it happens only if the shopper presses the button. Tell them to press it, and do not say it is done.";

const cancelOrder = defineTool({
  name: "cancel_order",
  description:
    "Start cancelling the shopper's own order. Works only before the order starts shipping. Needs the order number and proof that it is theirs (the email address or phone number on the order; neither for an order placed or already proved earlier in this chat; when unsure, call anyway and the result says what is missing), and their reason when they gave one. It shows a card with a confirm button; the order is cancelled only when the shopper presses it.",
  audiences: ["shopper"],
  schema: z.object({
    ...orderProofSchema,
    reason: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe(
        "Why the shopper wants to cancel, in their words. Leave it out when they gave no reason; never make one up.",
      ),
  }),
  isAvailable: (context) => available(context, context.settings.allowOrderCancel),
  async run({ orderNumber, email, phone, reason }, context) {
    const order = await changeableOrder(context, { orderNumber, email, phone });
    // Cancelling an unpaid order moves no money. A paid one needs a refund,
    // which is the merchant's to give, so it becomes a request to them.
    const kind = order.nothingPaid ? "cancel" : "cancel_request";
    const token = context.grantOrderAction!({
      orderId: order.id,
      orderName: order.name,
      kind,
      reason: reason || undefined,
    });

    return {
      output: {
        status: "awaiting_confirmation",
        order: order.name,
        paid: !order.nothingPaid,
        note: order.nothingPaid
          ? CONFIRM_NOTE
          : `This order has been paid, so it cannot be cancelled in the chat: pressing the button sends the store a cancellation request, and the store decides on the cancellation and the refund. Say that it is a request, and never promise a refund. ${CONFIRM_NOTE}`,
      },
      actions: [
        {
          type: "order_action" as const,
          kind,
          order: order.name,
          token,
          title: order.nothingPaid
            ? `Cancel order ${order.name}?`
            : `Ask the store to cancel order ${order.name}?`,
          lines: order.lines.map((line) => `${line.quantity} × ${line.title}`),
          note: order.nothingPaid
            ? "Nothing has been charged for this order. Cancelling it cannot be undone."
            : "This order has been paid. The store will confirm the cancellation and the refund.",
          confirmLabel: order.nothingPaid ? "Cancel order" : "Send request",
        },
      ],
    };
  },
});

const changeDeliveryAddress = defineTool({
  name: "change_delivery_address",
  description:
    "Start changing where the shopper's own order is delivered. Works only before the order starts shipping, and only within the same country. Needs the order number and proof that it is theirs (the email address or phone number on the order; neither for an order placed or already proved earlier in this chat; when unsure, call anyway and the result says what is missing). It shows a form for the new address; never take the address in the chat.",
  audiences: ["shopper"],
  schema: z.object(orderProofSchema),
  isAvailable: (context) => available(context, context.settings.allowAddressChange),
  async run({ orderNumber, email, phone }, context) {
    const order = await changeableOrder(context, { orderNumber, email, phone });
    if (!order.countryCode) {
      throw new ToolError(
        `Order ${order.name} has no delivery address to change. Suggest contacting the store.`,
      );
    }
    const token = context.grantOrderAction!({
      orderId: order.id,
      orderName: order.name,
      kind: "address",
      countryCode: order.countryCode,
    });

    return {
      output: {
        status: "form_shown",
        order: order.name,
        note: "A card with an 'Enter new address' button is now shown. It opens a form; the address changes only when the shopper fills it in and saves. The new address must be in the same country. Do not ask for the address in the chat, and do not say it has been changed.",
      },
      actions: [
        {
          type: "order_action" as const,
          kind: "address" as const,
          order: order.name,
          token,
          title: `Change the delivery address for order ${order.name}`,
          lines: [],
          note: "The new address must be in the same country.",
          confirmLabel: "Enter new address",
          countryCode: order.countryCode,
        },
      ],
    };
  },
});

const changeOrderItems = defineTool({
  name: "change_order_items",
  description:
    "See or change the items in the shopper's own order. Works only before the order starts shipping, and only for an order nothing has been paid for yet. Needs the order number and proof that it is theirs (the email address or phone number on the order; neither for an order placed or already proved earlier in this chat; when unsure, call anyway and the result says what is missing). Call it with no items to get the order's current items with their variantIds. 'One more' or 'another' means a higher quantity of an item the order already holds: never add a different product unless the shopper names it. To change them, pass each item that should change with the quantity it should END UP with: 0 removes it, and an item not yet in the order is added (variantId from get_product_details). It shows a card with a confirm button; the order changes only when the shopper presses it.",
  audiences: ["shopper"],
  schema: z.object({
    ...orderProofSchema,
    items: z
      .array(
        z.object({
          variantId: z.string().trim().regex(/^\d{1,20}$/, "Use a numeric variantId."),
          quantity: z
            .number()
            .int()
            .min(0)
            .max(MAX_QUANTITY)
            .describe("The quantity this item should end up with. 0 removes it."),
        }),
      )
      .max(MAX_LINES)
      .default([])
      .describe("Only the items that change. Leave empty to see the order's current items."),
  }),
  isAvailable: (context) => available(context, context.settings.allowOrderEdit),
  async run({ orderNumber, email, phone, items }, context) {
    const order = await changeableOrder(context, { orderNumber, email, phone });
    const current = order.lines.map((line) => ({
      item: line.title,
      quantity: line.quantity,
      variantId: line.variantId ?? undefined,
      unitPrice: money(line.unitPrice),
    }));

    if (!items.length) {
      return {
        output: {
          order: order.name,
          items: current,
          total: money(order.total),
          canChange: order.nothingPaid,
          note: order.nothingPaid
            ? "These are the order's items now. If the shopper has already said what to change (for example 'one more' of an item listed here), call again now with that item and the quantity it should end up with; otherwise ask them. Send only the items that change. Never show the variantIds."
            : "This order has been paid, so its items cannot be changed in the chat. Tell the shopper and suggest contacting the store.",
        },
      };
    }
    if (!order.nothingPaid) {
      throw new ToolError(
        `Order ${order.name} has been paid, so its items cannot be changed in the chat. Tell the shopper and suggest contacting the store.`,
      );
    }

    // The same variant listed twice: the last word wins.
    const wanted = new Map<string, number>();
    for (const item of items) wanted.set(item.variantId, item.quantity);

    const onOrder = new Map(
      order.lines.filter((line) => line.variantId).map((line) => [line.variantId!, line]),
    );
    const changes = [...wanted]
      .map(([variantId, quantity]) => ({ variantId, quantity }))
      .filter((change) => (onOrder.get(change.variantId)?.quantity ?? 0) !== change.quantity);
    if (!changes.length) {
      throw new ToolError(
        "The order is already like that, so there is nothing to change. Check with the shopper what they want different.",
      );
    }

    // Items that are new to the order must be real, published and in stock.
    const added = changes.filter((change) => !onOrder.has(change.variantId));
    const catalog = new Map<string, { title: string; price: Money }>();
    if (added.length) {
      if (!context.storefront) throw new ToolError("New items cannot be added right now.");
      const data = await context.storefront<{
        nodes: Array<{
          id?: string;
          title?: string;
          availableForSale?: boolean;
          price?: Money;
          product?: { title: string };
        } | null>;
      }>(VARIANTS_FOR_ORDER_QUERY, {
        ids: added.map((change) => `gid://shopify/ProductVariant/${change.variantId}`),
        country: order.countryCode ?? context.buyer.country ?? null,
      });
      added.forEach((change, index) => {
        const variant = data.nodes?.[index];
        if (!variant?.id || !variant.product || !variant.price) {
          throw new ToolError(
            `Variant ${change.variantId} is not in this order and is not a product of this store. Never guess an id. The order holds: ${JSON.stringify(current)}. To change one of those, use its variantId; for a different product, get its variantId from get_product_details first.`,
          );
        }
        const title =
          variant.title && variant.title !== "Default Title"
            ? `${variant.product.title} (${variant.title})`
            : variant.product.title;
        if (!variant.availableForSale) {
          throw new ToolError(`"${title}" is out of stock, so it cannot be added. Tell the shopper.`);
        }
        catalog.set(change.variantId, { title, price: variant.price });
      });
    }

    // What the order would hold afterwards.
    const result: Array<{ title: string; quantity: number; unitPrice: Money; was: number | null }> = [];
    for (const line of order.lines) {
      const quantity = line.variantId && wanted.has(line.variantId) ? wanted.get(line.variantId)! : line.quantity;
      result.push({ title: line.title, quantity, unitPrice: line.unitPrice, was: line.quantity });
    }
    for (const change of added) {
      const item = catalog.get(change.variantId)!;
      result.push({ title: item.title, quantity: change.quantity, unitPrice: item.price, was: null });
    }
    const kept = result.filter((line) => line.quantity > 0);
    if (!kept.length) {
      throw new ToolError(
        "That would leave the order with no items. If the shopper wants none of it, offer to cancel the order instead.",
      );
    }
    if (kept.length > MAX_LINES) {
      throw new ToolError(`An order can hold at most ${MAX_LINES} different items in the chat.`);
    }

    const places = Math.max(...kept.map((line) => decimalPlaces(line.unitPrice.amount)));
    const itemsTotal = kept.reduce((sum, line) => sum + Number(line.unitPrice.amount) * line.quantity, 0);
    const estimate = `${itemsTotal.toFixed(places)} ${kept[0].unitPrice.currencyCode}`;

    const token = context.grantOrderAction!({
      orderId: order.id,
      orderName: order.name,
      kind: "edit",
      changes,
    });

    return {
      output: {
        status: "awaiting_confirmation",
        order: order.name,
        itemsAfterChange: kept.map((line) => ({ item: line.title, quantity: line.quantity })),
        estimatedItemsTotal: estimate,
        note: `The total shown is for the items only; delivery and tax are added when the change is saved, and the confirmation gives the final total. ${CONFIRM_NOTE}`,
      },
      actions: [
        {
          type: "order_action" as const,
          kind: "edit" as const,
          order: order.name,
          token,
          title: `Change order ${order.name} to this?`,
          lines: [
            ...kept.map(
              (line) =>
                `${line.quantity} × ${line.title}${
                  line.was === null ? " (added)" : line.was !== line.quantity ? ` (was ${line.was})` : ""
                }`,
            ),
            ...result
              .filter((line) => line.quantity === 0)
              .map((line) => `Removed: ${line.title}`),
          ],
          note: `Items total about ${estimate}. Delivery and tax are added when you confirm.`,
          confirmLabel: "Confirm change",
        },
      ],
    };
  },
});

export const orderChangeTools: ToolDefinition[] = [
  cancelOrder,
  changeDeliveryAddress,
  changeOrderItems,
];
