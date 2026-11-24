/**
 * "Try it as a shopper": lets store staff chat with the storefront assistant
 * from inside the admin, before (or without) switching the widget on.
 *
 * The turn runs with the shopper audience, so it gets exactly the tools and
 * prompt a real shopper would, never the merchant-only ones. It is marked as
 * a preview so it stays out of the shopper conversation log.
 */
import type { ActionFunctionArgs } from "react-router";

import { ChatError, handleChatTurn } from "../assistant/chat.server";
import { toGraphqlFn } from "../assistant/shopify-clients.server";
import type { ChatActionData } from "../components/AssistantChat";
import type { ClientAction } from "../assistant/types";
import { authenticate, unauthenticated } from "../shopify.server";

/**
 * This page has no storefront cart, so it says in words what the widget would
 * do for the shopper after the reply.
 */
function describeAction(action: ClientAction): string {
  if (action.type === "order") {
    const items = action.items.map((item) => `${item.quantity} × ${item.title}`).join(", ");
    return action.replace
      ? `On your storefront, the widget empties the shopper's cart, puts in only this and shows an order summary: ${items}.`
      : `On your storefront, the widget puts this in the shopper's cart and shows an order summary with a Go to checkout button: ${items}.`;
  }
  if (action.type === "clear_cart") return "On your storefront, the widget empties the shopper's cart.";
  if (action.type === "order_action") {
    return `On your storefront, the widget shows a card: "${action.title}" with a "${action.confirmLabel}" button. Nothing changes until the shopper presses it.`;
  }
  if (action.type === "remove_from_cart") {
    return `On your storefront, the widget takes this out of the shopper's cart: ${action.title ?? "the item"}.`;
  }
  if (action.type === "checkout") {
    return "On your storefront, the widget shows a summary of the shopper's cart with a Go to checkout button.";
  }
  if (action.type === "choices") {
    return `On your storefront, the widget shows these answers as buttons: ${action.options.join(", ")}${action.other ? ", and Other to type their own" : ""}.`;
  }
  return `On your storefront, the widget adds this to the shopper's cart: ${action.quantity} × ${action.title ?? "the item"}.`;
}

export const action = async ({ request }: ActionFunctionArgs): Promise<ChatActionData> => {
  const { admin, session, sessionToken } = await authenticate.admin(request);
  const form = await request.formData();
  // Echoed back so the page can pair each answer with its question.
  const turnId = Number(form.get("turnId")) || 0;

  const userId = String(sessionToken?.sub ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  const visitorId = `preview-${userId || "shared"}`.slice(0, 64);

  try {
    // The shop comes from the authenticated admin session above, so this
    // Storefront API client is for the caller's own store.
    const { storefront } = await unauthenticated.storefront(session.shop);

    const result = await handleChatTurn({
      shop: session.shop,
      audience: "shopper",
      preview: true,
      visitorId,
      conversationId: form.get("conversationId"),
      message: form.get("message"),
      admin: toGraphqlFn(admin, "Admin"),
      storefront: toGraphqlFn(storefront, "Storefront"),
    });

    return {
      ok: true,
      turnId,
      reply: result.reply,
      conversationId: result.conversationId,
      cards: result.cards.map((card) => ({
        title: card.title,
        price: card.price ? `${card.price.amount} ${card.price.currencyCode}` : "",
      })),
      widgetNotes: result.actions.map(describeAction),
    };
  } catch (error) {
    if (error instanceof ChatError) {
      return { ok: false, turnId, error: error.message };
    }
    console.error(
      "[shopi-assist] shopper preview failed:",
      error instanceof Error ? error.name : "unknown error",
    );
    return { ok: false, turnId, error: "Something went wrong. Please try again." };
  }
};
