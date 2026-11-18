import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { getSettings } from "../assistant/settings.server";
import {
  getConversationTranscript,
  listConversations,
} from "../assistant/store.server";
import { RichText } from "../components/RichText";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const selectedId = new URL(request.url).searchParams.get("id");

  if (selectedId) {
    // Scoped to the authenticated shop: another shop's id returns nothing.
    const transcript = await getConversationTranscript(db, shop, selectedId);
    if (!transcript || transcript.audience !== "shopper") {
      throw new Response("Conversation not found", { status: 404 });
    }
    return {
      view: "transcript" as const,
      transcript: {
        id: transcript.id,
        startedAt: transcript.createdAt.toISOString(),
        messages: transcript.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          at: message.createdAt.toISOString(),
        })),
      },
    };
  }

  const [conversations, settings] = await Promise.all([
    listConversations(db, shop, { audience: "shopper", take: 50 }),
    getSettings(shop),
  ]);
  return {
    view: "list" as const,
    retentionDays: settings.retentionDays,
    conversations: conversations.map((conversation) => ({
      id: conversation.id,
      updatedAt: conversation.updatedAt.toISOString(),
      loggedIn: conversation.loggedIn,
      messageCount: conversation.messageCount,
      firstMessage: conversation.firstMessage,
    })),
  };
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function preview(text: string): string {
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

export default function Conversations() {
  const data = useLoaderData<typeof loader>();

  if (data.view === "transcript") {
    const { transcript } = data;
    return (
      <s-page heading="Conversation">
        <s-link slot="breadcrumb-actions" href="/app/conversations">
          Conversations
        </s-link>
        <s-section heading={`Started ${formatWhen(transcript.startedAt)}`}>
          <s-stack direction="block" gap="base">
            {transcript.messages.map((message) => (
              <s-box
                key={message.id}
                padding="base"
                borderRadius="base"
                borderWidth={message.role === "user" ? "none" : "base"}
                background={message.role === "user" ? "subdued" : "base"}
              >
                <s-stack direction="block" gap="small-200">
                  <s-text color="subdued">
                    {message.role === "user" ? "Shopper" : "Assistant"} ·{" "}
                    {formatWhen(message.at)}
                  </s-text>
                  {message.role === "user" ? (
                    <s-paragraph>{message.content}</s-paragraph>
                  ) : (
                    <RichText text={message.content} links="plain" />
                  )}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      </s-page>
    );
  }

  const { conversations, retentionDays } = data;

  return (
    <s-page heading="Conversations">
      {conversations.length === 0 ? (
        <s-section heading="No conversations yet">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Once shoppers start chatting on your storefront, their conversations appear
              here so you can see what they ask about.
            </s-paragraph>
            <s-stack direction="inline" gap="small">
              <s-button href="/app">Check widget setup</s-button>
            </s-stack>
          </s-stack>
        </s-section>
      ) : (
        <s-section padding="none" accessibilityLabel="Shopper conversations">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">First message</s-table-header>
              <s-table-header>Messages</s-table-header>
              <s-table-header>Shopper</s-table-header>
              <s-table-header listSlot="secondary">Last activity</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {conversations.map((conversation) => (
                <s-table-row key={conversation.id}>
                  <s-table-cell>
                    <s-link href={`/app/conversations?id=${conversation.id}`}>
                      {preview(conversation.firstMessage) || "(empty)"}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>{conversation.messageCount}</s-table-cell>
                  <s-table-cell>
                    {conversation.loggedIn ? "Logged-in customer" : "Guest"}
                  </s-table-cell>
                  <s-table-cell>{formatWhen(conversation.updatedAt)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}

      <s-section slot="aside" heading="Retention">
        <s-stack direction="block" gap="small-200">
          <s-paragraph>
            Transcripts are deleted after {retentionDays}{" "}
            {retentionDays === 1 ? "day" : "days"} without activity. Showing the 50 most
            recent.
          </s-paragraph>
          <s-link href="/app/settings">Change retention</s-link>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
