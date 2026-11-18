import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { ChatError, handleChatTurn } from "../assistant/chat.server";
import { getLlmStatus } from "../assistant/llm/index.server";
import { toGraphqlFn } from "../assistant/shopify-clients.server";
import { RichText } from "../components/RichText";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const llm = getLlmStatus();
  return { llmReady: llm.ready, llmProblem: llm.problem ?? null };
};

export const action = async ({ request }: ActionFunctionArgs) => {
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
      ok: true as const,
      turnId,
      reply: result.reply,
      conversationId: result.conversationId,
    };
  } catch (error) {
    if (error instanceof ChatError) {
      return { ok: false as const, turnId, error: error.message };
    }
    console.error(
      "[shopi-assist] merchant assistant failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return {
      ok: false as const,
      turnId,
      error: "Something went wrong. Please try again.",
    };
  }
};

interface ChatEntry {
  id: number;
  role: "user" | "assistant" | "error";
  text: string;
}

/** The question currently being asked, or the latest one answered. */
interface ActiveTurn {
  id: number;
  question: string;
}

const SUGGESTIONS = [
  "What are my top selling items this month?",
  "Give me a sales summary for the last 7 days",
  "Which products are running low on stock?",
  "Show my unfulfilled orders",
];

type FormSubmitEvent =
  | FormEvent<HTMLFormElement>
  | (SubmitEvent & { currentTarget: HTMLFormElement });

export default function StoreAssistant() {
  const { llmReady, llmProblem } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  // Finished exchanges live in `history`. The newest exchange is not copied
  // into state when its answer arrives; it is rendered straight from the
  // fetcher's response, matched to the question by turn id.
  const [history, setHistory] = useState<ChatEntry[]>([]);
  const [active, setActive] = useState<ActiveTurn | null>(null);
  const [conversationId, setConversationId] = useState("");
  const nextId = useRef(1);
  const bottomRef = useRef<HTMLDivElement>(null);

  const response =
    active && fetcher.state === "idle" && fetcher.data?.turnId === active.id
      ? fetcher.data
      : null;
  const pending = Boolean(active) && !response;

  const entries: ChatEntry[] = [...history];
  if (active) {
    entries.push({ id: active.id, role: "user", text: active.question });
    if (response) {
      entries.push(
        response.ok
          ? { id: active.id + 0.5, role: "assistant", text: response.reply }
          : { id: active.id + 0.5, role: "error", text: response.error },
      );
    }
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries.length, pending]);

  const send = (raw: string) => {
    const question = raw.trim();
    if (!question || pending) return;

    // Fold the previous exchange into history before starting the next one.
    let threadId = conversationId;
    if (active && response) {
      setHistory(entries);
      if (response.ok) {
        threadId = response.conversationId;
        setConversationId(threadId);
      }
    }

    const id = nextId.current;
    nextId.current += 1;
    setActive({ id, question });
    fetcher.submit(
      { message: question, conversationId: threadId, turnId: String(id) },
      { method: "POST" },
    );
  };

  const handleSubmit = (event: FormSubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget;
    send(String(new FormData(form).get("message") ?? ""));
    form.reset();
  };

  const startOver = () => {
    setHistory([]);
    setActive(null);
    setConversationId("");
  };

  return (
    <s-page heading="Store assistant">
      {entries.length > 0 && (
        <s-button slot="secondary-actions" onClick={startOver} {...(pending ? { disabled: true } : {})}>
          New conversation
        </s-button>
      )}

      {!llmReady && (
        <s-banner tone="warning" heading="The assistant can't answer yet">
          {llmProblem} Add it to the app server&apos;s environment and restart the app.
        </s-banner>
      )}

      <s-section heading="Ask about your store">
        <s-stack direction="block" gap="base">
          {entries.length === 0 ? (
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Ask questions in plain language. Answers come from your live store data:
                sales, top products, recent orders, inventory and catalog. The assistant is
                read-only and can&apos;t change anything in your store.
              </s-paragraph>
              <s-stack direction="inline" gap="small">
                {SUGGESTIONS.map((suggestion) => (
                  <s-button
                    key={suggestion}
                    variant="secondary"
                    onClick={() => send(suggestion)}
                    {...(pending || !llmReady ? { disabled: true } : {})}
                  >
                    {suggestion}
                  </s-button>
                ))}
              </s-stack>
            </s-stack>
          ) : (
            <div role="log" aria-live="polite" aria-label="Conversation">
              <s-stack direction="block" gap="base">
                {entries.map((entry) =>
                  entry.role === "error" ? (
                    <s-banner key={entry.id} tone="critical">
                      {entry.text}
                    </s-banner>
                  ) : (
                    <s-box
                      key={entry.id}
                      padding="base"
                      borderRadius="base"
                      borderWidth={entry.role === "user" ? "none" : "base"}
                      background={entry.role === "user" ? "subdued" : "base"}
                    >
                      <s-stack direction="block" gap="small-200">
                        <s-text color="subdued">
                          {entry.role === "user" ? "You" : "Assistant"}
                        </s-text>
                        {entry.role === "user" ? (
                          <s-paragraph>{entry.text}</s-paragraph>
                        ) : (
                          <RichText text={entry.text} />
                        )}
                      </s-stack>
                    </s-box>
                  ),
                )}
                {pending && (
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-spinner size="base" accessibilityLabel="Assistant is working" />
                    <s-text color="subdued">Checking your store data…</s-text>
                  </s-stack>
                )}
              </s-stack>
            </div>
          )}

          <div ref={bottomRef} />

          <form onSubmit={handleSubmit}>
            <s-stack direction="inline" gap="small" alignItems="end">
              <s-box inlineSize="100%">
                <s-text-field
                  name="message"
                  label="Your question"
                  labelAccessibilityVisibility="exclusive"
                  placeholder="For example: top selling items in the last 30 days"
                  autocomplete="off"
                  maxLength={2000}
                  {...(!llmReady ? { disabled: true } : {})}
                />
              </s-box>
              <s-button
                type="submit"
                variant="primary"
                {...(pending ? { loading: true } : {})}
                {...(!llmReady ? { disabled: true } : {})}
              >
                Send
              </s-button>
            </s-stack>
          </form>
        </s-stack>
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
