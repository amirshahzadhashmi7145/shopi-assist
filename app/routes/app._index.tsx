import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { getLlmStatus } from "../assistant/llm/index.server";
import { getSettings, getSetupState, setupProgress } from "../assistant/settings.server";
import { chatAnalytics } from "../assistant/store.server";
import { activateWidgetUrl, useEmbedStatus } from "../components/useEmbedStatus";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const shop = session.shop;

  // First open after install: start with the setup tour.
  const setup = await getSetupState(shop);
  if (!setup.started) throw redirect("/app/setup");

  const [settings, analytics] = await Promise.all([getSettings(shop), chatAnalytics(db, shop)]);
  const llm = getLlmStatus();

  return {
    shop,
    // The app's client id is public; it identifies the app in the deep link.
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
    chatEnabled: settings.enabled,
    setupCompleted: setup.completed,
    progress: setupProgress(settings),
    analytics,
    retentionDays: settings.retentionDays,
    chatOrders: settings.allowChatOrders,
    llm: { ready: llm.ready, model: llm.model, provider: llm.provider, problem: llm.problem },
  };
};

const SETUP_ITEMS = [
  { key: "policies", label: "Pick your return and shipping policies" },
  { key: "personality", label: "Name your assistant" },
  { key: "live", label: "Turn on the chat widget" },
] as const;

type AnalyticsData = Awaited<ReturnType<typeof chatAnalytics>>;

/** One number with what it counts under it. */
function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-300">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        {note ? <s-text color="subdued">{note}</s-text> : null}
      </s-stack>
    </s-box>
  );
}

/** How the storefront chat has been used lately, from the chats on record. */
function Analytics({
  analytics,
  retentionDays,
  chatOrders,
}: {
  analytics: AnalyticsData;
  retentionDays: number;
  chatOrders: boolean;
}) {
  const { conversations, shopperMessages, signedIn, ratings, ordersPlaced, perDay } = analytics;
  const rated = ratings.up + ratings.down;
  const busiest = Math.max(1, ...perDay.map((day) => day.count));
  const share = (part: number, whole: number) =>
    whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%";
  const weekday = (date: string) =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });

  return (
    <s-section heading="How the chat is doing">
      <s-stack direction="block" gap="base">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))" gap="base">
          <Stat
            label="Conversations, last 7 days"
            value={String(conversations.last7)}
            note={`${conversations.last30} in the last 30 days`}
          />
          <Stat
            label="Shopper messages, 30 days"
            value={String(shopperMessages)}
            note={
              conversations.last30 > 0
                ? `${(shopperMessages / conversations.last30).toFixed(1)} per conversation`
                : undefined
            }
          />
          <Stat
            label="Thumbs up, 30 days"
            value={rated > 0 ? share(ratings.up, rated) : "No ratings"}
            note={rated > 0 ? `${ratings.up} up, ${ratings.down} down` : "Nobody has rated a chat yet"}
          />
          <Stat
            label="Signed-in customers, 30 days"
            value={share(signedIn, conversations.last30)}
            note={`${signedIn} of ${conversations.last30} conversations`}
          />
          {chatOrders || ordersPlaced > 0 ? (
            <Stat
              label="Orders placed in chat, 30 days"
              value={String(ordersPlaced)}
              note="Pay on delivery"
            />
          ) : null}
        </s-grid>

        <s-stack direction="block" gap="small-200">
          <s-text color="subdued">Conversations started each day</s-text>
          <div
            role="img"
            aria-label={`Conversations started each day: ${perDay
              .map((day) => `${weekday(day.date)} ${day.count}`)
              .join(", ")}`}
            style={{ display: "flex", alignItems: "flex-end", gap: "8px", height: "96px" }}
          >
            {perDay.map((day) => (
              <div
                key={day.date}
                title={`${day.date}: ${day.count}`}
                style={{
                  flex: "1 1 0",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  gap: "4px",
                  height: "100%",
                  fontSize: "12px",
                  color: "#616161",
                }}
              >
                <span>{day.count}</span>
                <div
                  style={{
                    width: "100%",
                    maxWidth: "48px",
                    height: `${Math.max(2, Math.round((day.count / busiest) * 52))}px`,
                    borderRadius: "4px 4px 0 0",
                    background: day.count > 0 ? "#303030" : "#d4d4d4",
                  }}
                />
                <span>{weekday(day.date)}</span>
              </div>
            ))}
          </div>
        </s-stack>

        <s-stack direction="inline" gap="base" alignItems="center">
          <s-link href="/app/conversations">View conversations</s-link>
          <s-text color="subdued">
            Counted from the chats on record, which are kept for {retentionDays}{" "}
            {retentionDays === 1 ? "day" : "days"}. Days are in UTC.
          </s-text>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

export default function Home() {
  const {
    shop,
    apiKey,
    chatEnabled,
    analytics,
    retentionDays,
    chatOrders,
    llm,
    setupCompleted,
    progress,
  } = useLoaderData<typeof loader>();
  const embedStatus = useEmbedStatus();

  // Opens the theme editor with the widget already toggled on; the merchant
  // only has to press Save. Shopify does not let apps do this step for them.
  const activateUrl = activateWidgetUrl(shop, apiKey);
  const storefrontUrl = `https://${shop}`;

  const widgetLive = embedStatus === "active";
  const allSet = widgetLive && llm.ready && chatEnabled;

  return (
    <s-page heading="Shopi Assist">
      {!widgetLive && (
        <s-button slot="primary-action" variant="primary" href={activateUrl} target="_top">
          Turn on chat widget
        </s-button>
      )}

      {!setupCompleted && (
        <s-section heading="Finish setting up your assistant">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              A few quick picks teach the assistant about your store. Skip any you like; it
              already knows your products and published policies.
            </s-paragraph>
            <s-unordered-list>
              {SETUP_ITEMS.map((item) => (
                <s-list-item key={item.key}>
                  {item.label}{" "}
                  {(item.key === "live" ? widgetLive : progress[item.key]) ? (
                    <s-badge tone="success">Done</s-badge>
                  ) : (
                    <s-badge tone="neutral">Not yet</s-badge>
                  )}
                </s-list-item>
              ))}
            </s-unordered-list>
            <s-stack direction="inline" gap="small">
              <s-button href="/app/setup" variant="primary">
                Continue setup
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      )}

      {allSet && (
        <s-banner tone="success" heading="Your chat assistant is live">
          Shoppers can open the chat bubble on your storefront and ask about products,
          best sellers and store policies.
        </s-banner>
      )}

      {!llm.ready && (
        <s-banner tone="warning" heading="The assistant can't answer yet">
          {llm.problem} Add it to the app server&apos;s environment and restart the app.
          Until then, shoppers who open the chat see a short &quot;not set up yet&quot; message.
        </s-banner>
      )}

      <Analytics analytics={analytics} retentionDays={retentionDays} chatOrders={chatOrders} />

      <s-section heading="Setup">
        <s-stack direction="block" gap="base">
          <s-stack direction="block" gap="small-200">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-heading>1. Turn on the chat widget</s-heading>
              {embedStatus === "checking" && (
                <s-spinner size="base" accessibilityLabel="Checking widget status" />
              )}
              {embedStatus === "active" && <s-badge tone="success">On</s-badge>}
              {embedStatus === "inactive" && <s-badge tone="warning">Off</s-badge>}
              {embedStatus === "unknown" && <s-badge tone="neutral">Status unavailable</s-badge>}
            </s-stack>
            <s-paragraph>
              The widget is installed with the app but starts switched off, because Shopify
              requires store owners to approve changes to their storefront. The button opens
              your theme editor with Shopi Assist already toggled on. Press{" "}
              <s-text type="strong">Save</s-text> there and the chat bubble appears on every
              page.
            </s-paragraph>
            <s-stack direction="inline" gap="small">
              <s-button
                href={activateUrl}
                target="_top"
                variant={widgetLive ? "secondary" : "primary"}
              >
                {widgetLive ? "Open widget settings in theme editor" : "Turn on chat widget"}
              </s-button>
              <s-button href={storefrontUrl} target="_blank" variant="tertiary">
                View storefront
              </s-button>
            </s-stack>
          </s-stack>

          <s-divider />

          <s-stack direction="block" gap="small-200">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-heading>2. Connect the AI model</s-heading>
              {llm.ready ? (
                <s-badge tone="success">Connected</s-badge>
              ) : (
                <s-badge tone="critical">Not connected</s-badge>
              )}
            </s-stack>
            <s-paragraph>
              {llm.ready
                ? llm.provider === "mock"
                  ? "Running in mock mode: replies are canned test responses, not real AI answers."
                  : `Using ${llm.model}.`
                : "The model's API key is set on the app server, not on this page, so it is never exposed to browsers."}
            </s-paragraph>
          </s-stack>

          <s-divider />

          <s-stack direction="block" gap="small-200">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-heading>3. Tune how it answers</s-heading>
              {chatEnabled ? (
                <s-badge tone="success">Chat enabled</s-badge>
              ) : (
                <s-badge tone="warning">Chat paused</s-badge>
              )}
            </s-stack>
            <s-paragraph>
              Choose what the assistant can do (cart, checkout, order status, returns), pick
              your return and shipping policies, give it a name, and set how long transcripts
              are kept.
            </s-paragraph>
            <s-stack direction="inline" gap="small">
              <s-button href="/app/settings">Open settings</s-button>
              <s-button href="/app/setup" variant="tertiary">
                Run the setup tour again
              </s-button>
            </s-stack>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Ask about your store">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            The store assistant answers staff questions from live store data: top-selling
            products, sales totals, recent orders and low stock.
          </s-paragraph>
          <s-stack direction="inline" gap="small">
            <s-button href="/app/assistant">Open store assistant</s-button>
          </s-stack>
        </s-stack>
      </s-section>


      <s-section slot="aside" heading="What shoppers can ask">
        <s-unordered-list>
          <s-list-item>&quot;What are your best sellers?&quot;</s-list-item>
          <s-list-item>&quot;Do you have this in blue?&quot;</s-list-item>
          <s-list-item>&quot;What&apos;s your return policy?&quot;</s-list-item>
          <s-list-item>&quot;Add the small one to my cart&quot;</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
