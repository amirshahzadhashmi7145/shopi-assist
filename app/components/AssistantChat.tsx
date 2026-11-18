import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useFetcher } from "react-router";

import { RichText } from "./RichText";

/** What a chat action must return for this component to render it. */
export type ChatActionData =
  | {
      ok: true;
      turnId: number;
      reply: string;
      conversationId: string;
      /** Products the storefront widget would show as cards under the reply. */
      cards?: Array<{ title: string; price: string }>;
    }
  | { ok: false; turnId: number; error: string };

interface ChatEntry {
  id: number;
  role: "user" | "assistant" | "error";
  text: string;
  cards?: Array<{ title: string; price: string }>;
}

interface AssistantChatProps {
  /** Route whose action answers the chat, for example "/app/assistant". */
  action: string;
  /** Keeps separate chats on one page from sharing state. */
  fetcherKey: string;
  intro: ReactNode;
  suggestions: string[];
  placeholder: string;
  pendingText: string;
  userLabel?: string;
  disabled?: boolean;
}

type FormSubmitEvent =
  | FormEvent<HTMLFormElement>
  | (SubmitEvent & { currentTarget: HTMLFormElement });

/**
 * A simple question-and-answer panel for the admin. Finished exchanges live
 * in `history`; the newest one is rendered straight from the fetcher's
 * response, matched to its question by turn id, so nothing is copied into
 * state when an answer arrives.
 */
export function AssistantChat({
  action,
  fetcherKey,
  intro,
  suggestions,
  placeholder,
  pendingText,
  userLabel = "You",
  disabled = false,
}: AssistantChatProps) {
  const fetcher = useFetcher<ChatActionData>({ key: fetcherKey });

  const [history, setHistory] = useState<ChatEntry[]>([]);
  const [active, setActive] = useState<{ id: number; question: string } | null>(null);
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
          ? { id: active.id + 0.5, role: "assistant", text: response.reply, cards: response.cards }
          : { id: active.id + 0.5, role: "error", text: response.error },
      );
    }
  }

  useEffect(() => {
    if (entries.length > 0) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [entries.length, pending]);

  const send = (raw: string) => {
    const question = raw.trim();
    if (!question || pending || disabled) return;

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
      { method: "POST", action },
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
    <s-stack direction="block" gap="base">
      {entries.length === 0 ? (
        <s-stack direction="block" gap="base">
          {intro}
          <s-stack direction="inline" gap="small">
            {suggestions.map((suggestion) => (
              <s-button
                key={suggestion}
                variant="secondary"
                onClick={() => send(suggestion)}
                {...(pending || disabled ? { disabled: true } : {})}
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
                      {entry.role === "user" ? userLabel : "Assistant"}
                    </s-text>
                    {entry.role === "user" ? (
                      <s-paragraph>{entry.text}</s-paragraph>
                    ) : (
                      <RichText text={entry.text} />
                    )}
                    {entry.cards && entry.cards.length > 0 && (
                      <s-text color="subdued">
                        Product cards shown to the shopper:{" "}
                        {entry.cards.map((card) => `${card.title} (${card.price})`).join(", ")}
                      </s-text>
                    )}
                  </s-stack>
                </s-box>
              ),
            )}
            {pending && (
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-spinner size="base" accessibilityLabel="Assistant is working" />
                <s-text color="subdued">{pendingText}</s-text>
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
              label="Your message"
              labelAccessibilityVisibility="exclusive"
              placeholder={placeholder}
              autocomplete="off"
              maxLength={2000}
              {...(disabled ? { disabled: true } : {})}
            />
          </s-box>
          <s-button
            type="submit"
            variant="primary"
            {...(pending ? { loading: true } : {})}
            {...(disabled ? { disabled: true } : {})}
          >
            Send
          </s-button>
          {entries.length > 0 && (
            <s-button
              variant="tertiary"
              onClick={startOver}
              {...(pending ? { disabled: true } : {})}
            >
              Start over
            </s-button>
          )}
        </s-stack>
      </form>
    </s-stack>
  );
}
