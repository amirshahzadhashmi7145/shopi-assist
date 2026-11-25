/**
 * The storefront chat as shoppers will see it, inside the admin.
 *
 * Its look follows what the merchant picks before they save: the name and
 * the welcome message. Under it are questions to try, which change with what
 * is switched on (an order question once order status is on, a return once
 * returns are). They are for the merchant: the questions suggested to
 * shoppers are a theme setting. Messages sent here are answered by the real
 * assistant, as a shopper, with the saved settings; these test chats stay out
 * of the conversation log.
 *
 * Drawn to match the widget (extensions/chat-widget) in plain markup: the
 * widget itself is a storefront script and does not run in the admin. The
 * accent colour and position are theme settings, so the default is shown.
 */
import { useEffect, useRef } from "react";
import type { CSSProperties, FormEvent } from "react";

import { DEFAULT_ASSISTANT_NAME, DEFAULT_GREETING } from "../../assistant/assistant-defaults";
import type { AssistantSettings } from "../../assistant/settings.server";
import { RichText } from "../RichText";
import { useChatThread, type ChatEntry } from "../useChatThread";

const ACCENT = "#1f3d2f";
const INK = "#1c1c1a";
const INK_SOFT = "#5f5f5a";
const SURFACE_SOFT = "#f4f4f1";
const LINE = "rgba(28, 28, 26, 0.12)";

const STYLES = {
  frame: {
    display: "flex",
    flexDirection: "column",
    height: 460,
    background: "#ffffff",
    border: `1px solid ${LINE}`,
    borderRadius: 16,
    overflow: "hidden",
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.12)",
    color: INK,
    fontSize: 14,
    lineHeight: 1.45,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "10px 8px 10px 16px",
    background: ACCENT,
    color: "#ffffff",
  },
  title: {
    fontSize: 15,
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  reset: {
    display: "grid",
    placeItems: "center",
    width: 32,
    height: 32,
    padding: 0,
    border: 0,
    borderRadius: 8,
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
  },
  messages: {
    flex: "1 1 auto",
    minHeight: 0,
    overflowY: "auto",
    padding: "14px 12px 8px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  bubble: {
    alignSelf: "flex-start",
    maxWidth: "88%",
    padding: "9px 12px",
    borderRadius: 16,
    borderBottomLeftRadius: 5,
    background: SURFACE_SOFT,
    overflowWrap: "anywhere",
  },
  bubbleUser: {
    alignSelf: "flex-end",
    maxWidth: "88%",
    padding: "9px 12px",
    borderRadius: 16,
    borderBottomRightRadius: 5,
    background: ACCENT,
    color: "#ffffff",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  bubbleError: {
    alignSelf: "flex-start",
    maxWidth: "88%",
    padding: "9px 12px",
    borderRadius: 16,
    background: "#fdf0ee",
    color: "#a12a1f",
  },
  card: {
    alignSelf: "flex-start",
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    width: "88%",
    padding: "8px 12px",
    border: `1px solid ${LINE}`,
    borderRadius: 12,
    fontSize: 13,
  },
  note: { alignSelf: "flex-start", maxWidth: "88%", fontSize: 12, color: INK_SOFT },
  rating: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 14px",
    borderTop: `1px solid ${LINE}`,
    fontSize: 12,
    color: INK_SOFT,
  },
  form: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    margin: 0,
    padding: "8px 10px",
    borderTop: `1px solid ${LINE}`,
  },
  input: {
    flex: "1 1 auto",
    minWidth: 0,
    height: 38,
    padding: "0 12px",
    border: `1px solid ${LINE}`,
    borderRadius: 12,
    background: "#ffffff",
    color: INK,
    font: "inherit",
  },
  send: {
    flex: "0 0 38px",
    display: "grid",
    placeItems: "center",
    width: 38,
    height: 38,
    padding: 0,
    border: 0,
    borderRadius: "50%",
    background: ACCENT,
    color: "#ffffff",
    cursor: "pointer",
  },
  footer: { padding: "0 12px 8px", fontSize: 11, textAlign: "center", color: INK_SOFT },
} satisfies Record<string, CSSProperties>;

/**
 * Questions worth trying, given what the assistant may do. They change as
 * features are switched on and off, so the merchant sees what a setting adds.
 */
export function previewSuggestions(settings: AssistantSettings): string[] {
  const questions = ["What are your best sellers?"];
  if (settings.allowAddToCart) questions.push("Add your best seller to my cart");
  if (settings.orderLookupEnabled) questions.push("Where is my order?");
  if (settings.allowReturns) questions.push("I want to return an item");
  else questions.push("What is your return policy?");
  if (settings.allowOrderCancel) questions.push("Cancel my order");
  return questions.slice(0, 4);
}

interface PreviewWindowProps {
  name: string;
  greeting: string;
  entries: ChatEntry[];
  pending: boolean;
  /** Shoppers can rate the chat. */
  ratings: boolean;
  /** Why nothing can be sent right now, in words. Null: it can. */
  blocked: string | null;
  onSend: (text: string) => void;
  onReset: () => void;
}

/** The chat window itself. Shows what it is given; sends nothing on its own. */
export function PreviewWindow({
  name,
  greeting,
  entries,
  pending,
  ratings,
  blocked,
  onSend,
  onReset,
}: PreviewWindowProps) {
  const log = useRef<HTMLDivElement>(null);
  const busy = pending || blocked !== null;
  const answered = entries.some((entry) => entry.role === "assistant");

  useEffect(() => {
    // Keep the newest message in view, as the widget does.
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [entries.length, pending]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const text = String(new FormData(form).get("message") ?? "");
    if (!text.trim() || busy) return;
    onSend(text);
    form.reset();
  };

  return (
    <div style={STYLES.frame} data-preview>
      <div style={STYLES.header}>
        <span style={STYLES.title}>{name}</span>
        <button
          type="button"
          style={STYLES.reset}
          aria-label="Start a new chat"
          title="Start a new chat"
          onClick={onReset}
          disabled={pending}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M4 12a8 8 0 1 0 2.6-5.9M4 4v4.5h4.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div ref={log} style={STYLES.messages} role="log" aria-live="polite" aria-label="Preview chat">
        <div style={STYLES.bubble}>{greeting}</div>
        {entries.map((entry) =>
          entry.role === "user" ? (
            <div key={entry.id} style={STYLES.bubbleUser}>
              {entry.text}
            </div>
          ) : entry.role === "error" ? (
            <div key={entry.id} style={STYLES.bubbleError} role="alert">
              {entry.text}
            </div>
          ) : (
            <div key={entry.id} style={{ display: "contents" }}>
              <div style={STYLES.bubble}>
                <RichText text={entry.text} />
              </div>
              {entry.cards?.map((card, index) => (
                <div key={index} style={STYLES.card}>
                  <strong>{card.title}</strong>
                  <span>{card.price}</span>
                </div>
              ))}
              {entry.widgetNotes?.map((note) => (
                <div key={note} style={STYLES.note}>
                  {note}
                </div>
              ))}
            </div>
          ),
        )}
        {pending && (
          <div style={STYLES.bubble} aria-label="The assistant is answering">
            …
          </div>
        )}
      </div>

      {ratings && answered && (
        <div style={STYLES.rating}>
          <span>How is this chat going?</span>
          <span aria-hidden="true">👍 👎</span>
        </div>
      )}

      <form style={STYLES.form} onSubmit={handleSubmit}>
        <input
          name="message"
          type="text"
          style={STYLES.input}
          aria-label="Message to the assistant"
          placeholder="Ask a question…"
          autoComplete="off"
          maxLength={2000}
          disabled={blocked !== null}
        />
        <button
          type="submit"
          style={{ ...STYLES.send, ...(busy ? { opacity: 0.5, cursor: "default" } : {}) }}
          aria-label="Send"
          disabled={busy}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 19V5M5 12l7-7 7 7"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </form>
      <div style={STYLES.footer}>AI assistant. Answers can contain mistakes.</div>
    </div>
  );
}

/** Questions to try in the preview, as buttons under it. Not part of the widget. */
export function TryAsking({
  questions,
  disabled,
  onAsk,
}: {
  questions: string[];
  disabled: boolean;
  onAsk: (question: string) => void;
}) {
  return (
    <s-stack direction="block" gap="small-200">
      <s-text color="subdued">Try asking</s-text>
      <s-stack direction="inline" gap="small-200">
        {questions.map((question) => (
          <s-button
            key={question}
            variant="secondary"
            onClick={() => onAsk(question)}
            {...(disabled ? { disabled: true } : {})}
          >
            {question}
          </s-button>
        ))}
      </s-stack>
    </s-stack>
  );
}

/**
 * The preview wired to the real assistant. `settings` are the merchant's
 * picks as they stand; `unsaved` says they differ from what is saved, in
 * which case the look follows the picks but nothing can be sent until they
 * are saved, because the assistant answers with the saved settings.
 */
export function LivePreview({
  settings,
  unsaved,
  ready,
  fetcherKey,
}: {
  settings: AssistantSettings;
  unsaved: boolean;
  /** The assistant can answer at all. */
  ready: boolean;
  fetcherKey: string;
}) {
  const thread = useChatThread("/app/preview", fetcherKey, !ready || unsaved);
  const blocked = !ready
    ? "The assistant can't answer right now. This is a problem on our side, not in your store."
    : unsaved
      ? "Save your changes to chat with them."
      : null;

  return (
    <s-stack direction="block" gap="small">
      <PreviewWindow
        name={settings.assistantName.trim() || DEFAULT_ASSISTANT_NAME}
        greeting={settings.greeting.trim() || DEFAULT_GREETING}
        entries={thread.entries}
        pending={thread.pending}
        ratings={settings.chatRatings}
        blocked={blocked}
        onSend={thread.send}
        onReset={thread.startOver}
      />
      <TryAsking
        questions={previewSuggestions(settings)}
        disabled={blocked !== null || thread.pending}
        onAsk={thread.send}
      />
      {blocked ? (
        <s-text color="subdued">{blocked}</s-text>
      ) : !settings.enabled ? (
        <s-text color="subdued">
          The chat is paused, so shoppers don&apos;t see it. You can still try it here.
        </s-text>
      ) : (
        <s-text color="subdued">
          Answers come from the real assistant, as a shopper would get them, and stay out of
          your conversations. Colours, position and the questions suggested to shoppers are set
          in the theme editor.
        </s-text>
      )}
    </s-stack>
  );
}
