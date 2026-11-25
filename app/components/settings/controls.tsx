/**
 * The few building blocks every part of Settings is made of: a switch, a
 * list to pick from, a place that stays hidden until it is needed, and a line
 * that says something came from Shopify.
 *
 * The controls keep their own state. They are given the saved value to start
 * from and never pushed a new one, so nothing the merchant has picked is
 * overwritten while they are still choosing.
 */
import type { ReactNode } from "react";

export const errorProp = (message: string | undefined) => (message ? { error: message } : {});

/** A feature the merchant switches on or off. */
export function Toggle({
  name,
  label,
  details,
  on,
}: {
  name: string;
  label: string;
  details: string;
  on: boolean;
}) {
  return (
    <s-switch name={name} label={label} details={details} {...(on ? { defaultChecked: true } : {})} />
  );
}

/** Something the assistant always does: shown switched on, and not a setting. */
export function AlwaysOn({ label, details }: { label: string; details: string }) {
  return <s-switch label={label} details={details} defaultChecked disabled />;
}

/** One answer from a short list. `value` is the saved one. */
export function Pick({
  name,
  label,
  details,
  value,
  options,
  error,
}: {
  name: string;
  label: string;
  details?: string;
  value: string;
  options: ReadonlyArray<readonly [value: string, label: string]>;
  error?: string;
}) {
  return (
    <s-select
      name={name}
      label={label}
      value={value}
      {...(details ? { details } : {})}
      {...errorProp(error)}
    >
      {options.map(([optionValue, optionLabel]) => (
        <s-option key={optionValue} value={optionValue}>
          {optionLabel}
        </s-option>
      ))}
    </s-select>
  );
}

/**
 * Hidden until it applies: a feature's own options while the feature is off,
 * a text box until "Custom" is picked. What is inside stays on the page, so a
 * choice made earlier is kept, and saved, while it is out of sight.
 */
export function Reveal({
  open,
  nested = false,
  children,
}: {
  open: boolean;
  /** Set apart as belonging to the control above it. */
  nested?: boolean;
  children: ReactNode;
}) {
  return (
    <div hidden={!open}>
      {nested ? (
        <s-box padding="base" background="subdued" borderRadius="base">
          <s-stack direction="block" gap="base">
            {children}
          </s-stack>
        </s-box>
      ) : (
        children
      )}
    </div>
  );
}

/** Two columns where there is room, one where there is not. */
export function Columns({
  tight = false,
  children,
}: {
  /** Rows close together, for a group of tick boxes. */
  tight?: boolean;
  children: ReactNode;
}) {
  return (
    <s-query-container>
      <s-grid
        gap={tight ? "small-200 base" : "base"}
        gridTemplateColumns="@container (inline-size > 520px) 1fr 1fr, 1fr"
      >
        {children}
      </s-grid>
    </s-query-container>
  );
}

/**
 * synced: Shopify has it. missing: Shopify has none and the store would do
 * well to add it. none: Shopify has none, which is fine. unknown: Shopify
 * could not be asked.
 */
export type SyncState = "synced" | "missing" | "none" | "unknown";

const SYNC_BADGE: Record<SyncState, { tone: "success" | "warning" | "neutral"; text: string }> = {
  synced: { tone: "success", text: "Synced from Shopify" },
  missing: { tone: "warning", text: "Not set in Shopify" },
  none: { tone: "neutral", text: "Nothing in Shopify" },
  unknown: { tone: "neutral", text: "Couldn't check" },
};

/**
 * One thing the app reads from the store itself, so the merchant does not
 * type it: what it is, what Shopify says, and whether that could be read.
 */
export function SyncedLine({
  label,
  value,
  state,
  children,
}: {
  label: string;
  value: string;
  state: SyncState;
  /** A link to where it is set in Shopify, when there is something to do. */
  children?: ReactNode;
}) {
  const { tone, text } = SYNC_BADGE[state];
  return (
    // A grid, so the badge keeps its corner however long the line beside it is.
    <s-grid gridTemplateColumns="minmax(0, 1fr) auto" gap="base" alignItems="start">
      <s-stack direction="block" gap="small-500">
        <s-text type="strong">{label}</s-text>
        <s-text color="subdued">{value}</s-text>
        {children}
      </s-stack>
      <s-badge tone={tone} {...(state === "synced" ? { icon: "check" as const } : {})}>
        {text}
      </s-badge>
    </s-grid>
  );
}

/** Shows a text box the merchant has not asked for yet. */
export function AddOwnWords({
  open,
  label,
  onOpen,
  children,
}: {
  open: boolean;
  label: string;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <>
      {!open && (
        <s-stack direction="inline">
          <s-button variant="tertiary" icon="plus" onClick={onOpen}>
            {label}
          </s-button>
        </s-stack>
      )}
      <Reveal open={open}>{children}</Reveal>
    </>
  );
}
