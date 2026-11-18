import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

/** Must match the Liquid file name in extensions/chat-widget/blocks. */
export const EMBED_HANDLE = "shopi-assist-chat";

export type EmbedStatus = "checking" | "active" | "inactive" | "unknown";

interface ExtensionInfo {
  type?: string;
  activations?: Array<{ handle?: string; status?: string }>;
}

/** Theme editor link that opens with the chat widget already toggled on. */
export function activateWidgetUrl(shop: string, apiKey: string): string {
  return `https://${shop}/admin/themes/current/editor?context=apps&activateAppId=${encodeURIComponent(apiKey)}/${EMBED_HANDLE}`;
}

/**
 * Asks Shopify whether the chat widget is switched on in the published theme.
 * Needs no extra access scope. Falls back to "unknown" when the check is not
 * available, in which case the page still shows how to turn the widget on.
 */
export function useEmbedStatus(): EmbedStatus {
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
