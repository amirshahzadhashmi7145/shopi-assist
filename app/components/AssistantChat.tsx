import { useEffect, useRef } from "react";
import type { FormEvent, ReactNode } from "react";

import { RichText } from "./RichText";
import { useChatThread } from "./useChatThread";

export type { ChatActionData } from "./useChatThread";

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

/** A simple question-and-answer panel for the admin, drawn with Polaris. */
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
  const { entries, pending, send, startOver } = useChatThread(action, fetcherKey, disabled);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (entries.length > 0) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [entries.length, pending]);

  const handleSubmit = (event: FormSubmitEvent) => {
    event.preventDefault();
    // Nothing is sent while an answer is on its way, so what was typed stays.
    if (pending) return;
    const form = event.currentTarget;
    send(String(new FormData(form).get("message") ?? ""));
    form.reset();
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
                    {entry.widgetNotes?.map((note) => (
                      <s-text key={note} color="subdued">
                        {note}
                      </s-text>
                    ))}
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
