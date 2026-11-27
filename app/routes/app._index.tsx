import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { getLlmStatus } from "../assistant/llm/index.server";
import { getSettings, getSetupState, setupProgress } from "../assistant/settings.server";
import { syncStoreFactsForPage } from "../assistant/store-facts.server";
import { chatAnalytics } from "../assistant/store.server";
import { ChatAnalyticsSection } from "../components/ChatAnalytics";
import { activateWidgetUrl, useEmbedStatus } from "../components/useEmbedStatus";
import db from "../db.server";
import { factClients } from "../facts-clients.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin, redirect } = await authenticate.admin(request);
  const shop = session.shop;

  // First open after install: start with the setup tour.
  const setup = await getSetupState(shop);
  if (!setup.started) throw redirect("/app/setup");

  // Opening the app is a good moment to hear from Shopify again about the
  // store itself. Nothing on this page waits for the answer.
  void factClients(shop, admin)
    .then((clients) => syncStoreFactsForPage(shop, clients, { maxAgeMs: 60 * 1000 }))
    .catch(() => undefined);

  const [settings, analytics] = await Promise.all([getSettings(shop), chatAnalytics(db, shop)]);
  // Which model answers, and how it is connected, is the app operator's
  // business: the merchant is told only whether the assistant can answer.
  const llm = getLlmStatus();
  if (!llm.ready) console.warn(`[shopi-assist] assistant not ready: ${llm.problem}`);

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
    llmReady: llm.ready,
  };
};

const SETUP_ITEMS = [
  { key: "policies", label: "Pick your return and shipping policies" },
  { key: "live", label: "Turn on the chat widget" },
] as const;

export default function Home() {
  const {
    shop,
    apiKey,
    chatEnabled,
    analytics,
    retentionDays,
    llmReady,
    setupCompleted,
    progress,
  } = useLoaderData<typeof loader>();
  const embedStatus = useEmbedStatus();

  // Opens the theme editor with the widget already toggled on; the merchant
  // only has to press Save. Shopify does not let apps do this step for them.
  const activateUrl = activateWidgetUrl(shop, apiKey);
  const storefrontUrl = `https://${shop}`;

  const widgetLive = embedStatus === "active";
  const allSet = widgetLive && llmReady && chatEnabled;

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

      {!llmReady && (
        <s-banner tone="warning" heading="The assistant can't answer right now">
          This is a problem on our side, not in your store, and nothing needs changing in
          your settings. Until it is fixed, shoppers who open the chat see a short message
          saying it is not available.
        </s-banner>
      )}

      <ChatAnalyticsSection analytics={analytics} retentionDays={retentionDays} />

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
              <s-heading>2. Tune how it answers</s-heading>
              {chatEnabled ? (
                <s-badge tone="success">Chat enabled</s-badge>
              ) : (
                <s-badge tone="warning">Chat paused</s-badge>
              )}
            </s-stack>
            <s-paragraph>
              Switch features on or off, and pick your policies and the answers to common
              questions. None of it has to be typed.
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
