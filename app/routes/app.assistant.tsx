import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { ChatError, handleChatTurn } from "../assistant/chat.server";
import { getLlmStatus } from "../assistant/llm/index.server";
import { toGraphqlFn } from "../assistant/shopify-clients.server";
import { AssistantChat, type ChatActionData } from "../components/AssistantChat";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const llm = getLlmStatus();
  return { llmReady: llm.ready };
};

export const action = async ({ request }: ActionFunctionArgs): Promise<ChatActionData> => {
  // Shopify verifies the admin session here. Everything below runs with
  // merchant-level tools, so this route must never be reachable unauthenticated.
  const { admin, session, sessionToken } = await authenticate.admin(request);
  const form = await request.formData();
  // Echoed back so the page can pair each answer with its question.
  const turnId = Number(form.get("turnId")) || 0;

  // One conversation thread per staff member where the user id is known.
  const userId = String(sessionToken?.sub ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  const visitorId = `staff-${userId || "shared"}`.slice(0, 64);

  try {
    const result = await handleChatTurn({
      shop: session.shop,
      audience: "merchant",
      visitorId,
      conversationId: form.get("conversationId"),
      message: form.get("message"),
      admin: toGraphqlFn(admin, "Admin"),
    });
    return {
      ok: true,
      turnId,
      reply: result.reply,
      conversationId: result.conversationId,
    };
  } catch (error) {
    if (error instanceof ChatError) {
      return { ok: false, turnId, error: error.message };
    }
    console.error(
      "[shopi-assist] merchant assistant failed:",
      error instanceof Error ? error.name : "unknown error",
    );
    return { ok: false, turnId, error: "Something went wrong. Please try again." };
  }
};

const SUGGESTIONS = [
  "What are my top selling items this month?",
  "Give me a sales summary for the last 7 days",
  "Which products are running low on stock?",
  "Show my unfulfilled orders",
];

export default function StoreAssistant() {
  const { llmReady } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Store assistant">
      {!llmReady && (
        <s-banner tone="warning" heading="The assistant can't answer right now">
          This is a problem on our side, not in your store. Please try again in a little while.
        </s-banner>
      )}

      <s-section heading="Ask about your store">
        <AssistantChat
          action="/app/assistant"
          fetcherKey="store-assistant"
          disabled={!llmReady}
          placeholder="For example: top selling items in the last 30 days"
          pendingText="Checking your store data…"
          suggestions={SUGGESTIONS}
          intro={
            <s-paragraph>
              Ask questions in plain language. Answers come from your live store data: sales,
              top products, recent orders, inventory and catalog. The assistant is read-only
              and can&apos;t change anything in your store.
            </s-paragraph>
          }
        />
      </s-section>

      <s-section slot="aside" heading="What it can look up">
        <s-unordered-list>
          <s-list-item>Top-selling products by units or revenue</s-list-item>
          <s-list-item>Sales totals and average order value</s-list-item>
          <s-list-item>Recent, open and unfulfilled orders</s-list-item>
          <s-list-item>Low-stock variants</s-list-item>
          <s-list-item>Products, including drafts</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="About the numbers">
        <s-paragraph>
          Sales figures use Shopify&apos;s analytics when your app has access to them. If
          not, the assistant totals your most recent orders instead and tells you the figures
          are approximate.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
