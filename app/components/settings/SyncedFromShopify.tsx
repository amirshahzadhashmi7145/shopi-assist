/**
 * "From your Shopify store": everything the assistant uses that the merchant
 * never has to enter, with whether Shopify could be read for it just now.
 */
import type { ReactNode } from "react";

import { paymentNames, type StoreFactsView } from "../../assistant/store-facts";
import type { FactsReached } from "../../assistant/store-facts.server";

type Tone = "success" | "warning" | "neutral";

function Row({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    // A grid, so a long line wraps beside its icon and never under it.
    <s-grid gridTemplateColumns="auto minmax(0, 1fr)" gap="small" alignItems="start">
      <s-icon
        type={tone === "success" ? "check-circle" : tone === "warning" ? "alert-circle" : "circle-dashed"}
        tone={tone === "success" ? "success" : tone === "warning" ? "caution" : "neutral"}
        size="small"
      />
      <s-stack direction="block" gap="small-500">
        <s-text type="strong">{label}</s-text>
        <s-text color="subdued">{value}</s-text>
      </s-stack>
    </s-grid>
  );
}

/** What each line says, worked out from the facts alone. */
export function syncedRows(
  facts: StoreFactsView,
): Array<{ label: string; value: string; tone: Tone }> {
  const unknown = "Couldn't check just now";
  const rows: Array<{ label: string; value: string; tone: Tone }> = [];

  rows.push(
    facts.products === undefined
      ? { label: "Catalog", value: unknown, tone: "neutral" }
      : {
          label: "Catalog",
          value: `${facts.products.toLocaleString("en-US")}${facts.productsCapped ? "+" : ""} active ${facts.products === 1 ? "product" : "products"}`,
          tone: facts.products > 0 ? "success" : "warning",
        },
  );

  if (facts.policies === undefined) {
    rows.push({ label: "Policies", value: unknown, tone: "neutral" });
  } else {
    const names = [
      facts.policies.refund ? "Refund" : "",
      facts.policies.shipping ? "Shipping" : "",
      facts.policies.privacy ? "Privacy" : "",
      facts.policies.terms ? "Terms" : "",
    ].filter(Boolean);
    rows.push({
      label: "Policies",
      value: names.length ? `Published: ${names.join(", ")}` : "None published yet",
      tone: facts.policies.refund && facts.policies.shipping ? "success" : "warning",
    });
  }

  if (facts.shipsTo === undefined) {
    rows.push({ label: "Shipping regions", value: unknown, tone: "neutral" });
  } else {
    const { countries } = facts;
    rows.push({
      label: "Shipping regions",
      value:
        countries.length === 0
          ? "No shipping zones yet"
          : countries.length <= 3
            ? countries.join(", ")
            : `${countries.length} countries`,
      tone: countries.length ? "success" : "warning",
    });
  }

  if (facts.cards === undefined) {
    rows.push({ label: "Payment methods", value: unknown, tone: "neutral" });
  } else {
    const { cards, wallets } = paymentNames(facts);
    const all = [...cards, ...wallets];
    rows.push({
      label: "Payment methods",
      value: all.length
        ? all.length <= 4
          ? all.join(", ")
          : `${all.slice(0, 3).join(", ")} and ${all.length - 3} more`
        : "None reported",
      tone: all.length ? "success" : "neutral",
    });
  }

  const details = [
    facts.shopName ? "name" : "",
    facts.currencyCode ? `currency (${facts.currencyCode})` : "",
    facts.contactEmail ? "contact email" : "",
  ].filter(Boolean);
  rows.push(
    details.length
      ? { label: "Store details", value: `Your store's ${details.join(", ")}`, tone: "success" }
      : { label: "Store details", value: unknown, tone: "neutral" },
  );
  return rows;
}

export function SyncedFromShopify({
  facts,
  reached,
  action,
}: {
  facts: StoreFactsView;
  /** What the last attempt reached. Null when Shopify was not asked this time. */
  reached: FactsReached | null;
  /** A "Check again" control, where the page offers one. */
  action?: ReactNode;
}) {
  const failed = reached !== null && (!reached.admin || !reached.storefront);
  return (
    <s-stack direction="block" gap="base">
      <s-paragraph color="subdued">
        Read from your store, so you never type it. The assistant uses it as it is in Shopify.
      </s-paragraph>
      {failed && (
        <s-banner tone="warning">
          {facts.syncedAt
            ? "Shopify couldn't be reached for everything just now. What was found earlier is still in use."
            : "Shopify couldn't be reached just now. Nothing is lost: check again in a moment."}
        </s-banner>
      )}
      {syncedRows(facts).map((row) => (
        <Row key={row.label} {...row} />
      ))}
      {action}
    </s-stack>
  );
}
