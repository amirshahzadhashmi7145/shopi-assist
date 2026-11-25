import { useRef, useState } from "react";
import { useFetcher } from "react-router";

/** What a chat action must return for a chat panel to render it. */
export type ChatActionData =
  | {
      ok: true;
      turnId: number;
      reply: string;
      conversationId: string;
      /** Products the storefront widget would show as cards under the reply. */
      cards?: Array<{ title: string; price: string }>;
      /** What else the storefront widget would do after this reply, in words. */
      widgetNotes?: string[];
    }
  | { ok: false; turnId: number; error: string };

export interface ChatEntry {
  id: number;
  role: "user" | "assistant" | "error";
  text: string;
  cards?: Array<{ title: string; price: string }>;
  widgetNotes?: string[];
}

/**
 * One conversation with a chat action, for the admin's chat panels. Finished
 * exchanges live in `history`; the newest one is read straight from the
 * fetcher's response, matched to its question by turn id, so nothing is
 * copied into state when an answer arrives.
 */
export function useChatThread(action: string, fetcherKey: string, disabled = false) {
  const fetcher = useFetcher<ChatActionData>({ key: fetcherKey });

  const [history, setHistory] = useState<ChatEntry[]>([]);
  const [active, setActive] = useState<{ id: number; question: string } | null>(null);
  const [conversationId, setConversationId] = useState("");
  const nextId = useRef(1);

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
          ? {
              id: active.id + 0.5,
              role: "assistant",
              text: response.reply,
              cards: response.cards,
              widgetNotes: response.widgetNotes,
            }
          : { id: active.id + 0.5, role: "error", text: response.error },
      );
    }
  }

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

  const startOver = () => {
    setHistory([]);
    setActive(null);
    setConversationId("");
  };

  return { entries, pending, send, startOver };
}
