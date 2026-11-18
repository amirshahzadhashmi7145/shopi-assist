import { useEffect, useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { getLlmStatus } from "../assistant/llm/index.server";
import { getSettings } from "../assistant/settings.server";
import { countConversationsSince } from "../assistant/store.server";
import db from "../db.server";
import { authenticate } from "../shopify.server";

/** Must match the Liquid file name in extensions/chat-widget/blocks. */
const EMBED_HANDLE = "shopi-assist-chat";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [settings, conversationsThisWeek] = await Promise.all([
    getSettings(shop),
    countConversationsSince(db, shop, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
  ]);
  const llm = getLlmStatus();

  return {
    shop,
    // The app's client id is public; it identifies the app in the deep link.
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
    chatEnabled: settings.enabled,
    conversationsThisWeek,
    llm: { ready: llm.ready, model: llm.model, provider: llm.provider, problem: llm.problem },
  };
};

type EmbedStatus = "checking" | "active" | "inactive" | "unknown";

interface ExtensionInfo {
  type?: string;
  activations?: Array<{ handle?: string; status?: string }>;
}

/**
 * Asks Shopify whether the chat widget is switched on in the published theme.
 * Needs no extra access scope. Falls back to "unknown" when the check is not
 * available, in which case the page still shows how to turn the widget on.
 */
function useEmbedStatus(): EmbedStatus {
  const shopify = useAppBridge();
  const [status, setStatus] = useState<EmbedStatus>("checking");

  useEffect(() => {
    let cancelled = false;
    const appApi = (
      shopify as unknown as {
        app?: { extensions?: () => Promise<ExtensionInfo[]> };
      }
    ).app;

    // Going through a promise gives "API missing" and "call failed" one path,
    // and keeps every state update inside a callback.
    Promise.resolve()
      .then(() => (appApi?.extensions ? appApi.extensions() : null))
      .then((extensions) => {
        if (cancelled) return;
        if (!extensions) {
          setStatus("unknown");
          return;
        }
        const active = extensions
          .filter((extension) => extension.type === "theme_app_extension")
          .some((extension) =>
            (extension.activations ?? []).some(
              (block) => block.handle === EMBED_HANDLE && block.status === "active",
            ),
          );
        setStatus(active ? "active" : "inactive");
      })
      .catch(() => {
        if (!cancelled) setStatus("unknown");
      });

    return () => {
      cancelled = true;
    };
  }, [shopify]);

  return status;
}

export default function Home() {
  const { shop, apiKey, chatEnabled, conversationsThisWeek, llm } =
    useLoaderData<typeof loader>();
  const embedStatus = useEmbedStatus();

  // Opens the theme editor with the widget already toggled on; the merchant
  // only has to press Save. Shopify does not let apps do this step for them.
  const activateUrl = `https://${shop}/admin/themes/current/editor?context=apps&activateAppId=${encodeURIComponent(apiKey)}/${EMBED_HANDLE}`;
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
              Add store-specific guidance (tone, shipping cut-offs, what to recommend), choose
              whether shoppers can check order status, and set how long transcripts are kept.
            </s-paragraph>
            <s-stack direction="inline" gap="small">
              <s-button href="/app/settings">Open settings</s-button>
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

      <s-section slot="aside" heading="Last 7 days">
        <s-stack direction="block" gap="small-200">
          <s-heading>{conversationsThisWeek}</s-heading>
          <s-paragraph>
            {conversationsThisWeek === 1 ? "shopper conversation" : "shopper conversations"}
          </s-paragraph>
          <s-link href="/app/conversations">View conversations</s-link>
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
