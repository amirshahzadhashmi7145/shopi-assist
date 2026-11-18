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
import { authenticate, unauthenticated } from "../shopify.server";

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
