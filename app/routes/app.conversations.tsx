import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { getSettings } from "../assistant/settings.server";
import {
  getConversationTranscript,
  listConversations,
  ratingCounts,
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
    if (!transcript || transcript.audience !== "shopper" || transcript.isPreview) {
      throw new Response("Conversation not found", { status: 404 });
    }
    return {
      view: "transcript" as const,
      transcript: {
        id: transcript.id,
        rating: transcript.rating === "up" || transcript.rating === "down" ? transcript.rating : null,
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

  const [conversations, settings, ratings] = await Promise.all([
    listConversations(db, shop, { audience: "shopper", take: 50 }),
    getSettings(shop),
    ratingCounts(db, shop),
  ]);
  return {
    view: "list" as const,
    retentionDays: settings.retentionDays,
    ratings,
    ratingsOn: settings.chatRatings,
    conversations: conversations.map((conversation) => ({
      id: conversation.id,
      updatedAt: conversation.updatedAt.toISOString(),
      loggedIn: conversation.loggedIn,
      rating: conversation.rating,
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

/** How the shopper rated the chat, as a badge; a dash when they did not. */
function RatingBadge({ rating }: { rating: string | null }) {
  if (rating === "up") return <s-badge tone="success">Thumbs up</s-badge>;
  if (rating === "down") return <s-badge tone="critical">Thumbs down</s-badge>;
  return <s-text color="subdued">Not rated</s-text>;
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
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text color="subdued">Shopper&apos;s rating:</s-text>
              <RatingBadge rating={transcript.rating} />
            </s-stack>
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

  const { conversations, retentionDays, ratings, ratingsOn } = data;
  const rated = ratings.up + ratings.down;

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
              <s-table-header>Rating</s-table-header>
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
                    <RatingBadge rating={conversation.rating} />
                  </s-table-cell>
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

      <s-section slot="aside" heading="Chat ratings">
        <s-stack direction="block" gap="small-200">
          {rated === 0 ? (
            <s-paragraph>
              {ratingsOn
                ? "No shopper has rated a chat yet."
                : "Ratings are switched off, so shoppers are not asked."}
            </s-paragraph>
          ) : (
            <>
              <s-paragraph>
                {ratings.up} thumbs up and {ratings.down} thumbs down, from the {rated}{" "}
                {rated === 1 ? "chat" : "chats"} on record that shoppers rated.
              </s-paragraph>
              <s-paragraph color="subdued">
                {Math.round((ratings.up / rated) * 100)}% of rated chats got a thumbs up.
              </s-paragraph>
            </>
          )}
          <s-link href="/app/settings">{ratingsOn ? "Change this" : "Switch ratings on"}</s-link>
        </s-stack>
      </s-section>

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
