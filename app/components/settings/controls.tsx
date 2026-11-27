/**
 * The few building blocks every part of Settings is made of: a switch, a
 * list to pick from, a row of colours, a place that stays hidden until it is
 * needed, and a line that says something came from Shopify.
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

/** A colour not in the row of swatches: any at all, so it is drawn as every colour. */
const ANY_COLOUR =
  "conic-gradient(#ef4444, #f59e0b, #eab308, #22c55e, #06b6d4, #3b82f6, #a855f7, #ec4899, #ef4444)";

/**
 * The radio button under each swatch is kept, clear of the eye, so the row
 * works as any group of radio buttons does: arrow keys, the form's reset,
 * the unsaved-changes bar. Only the keyboard's place in it needs drawing.
 */
const SWATCH_CSS = `
.shopi-swatch-input:focus-visible + .shopi-swatch {
  outline: 2px solid #005bd3;
  outline-offset: 3px;
}`;

/**
 * A colour picked by eye from a row of swatches, with one more for a colour
 * of the merchant's own. Plain radio buttons drawn as circles: Shopify's own
 * list of choices shows text only.
 */
export function Swatches({
  name,
  label,
  value,
  picked,
  options,
  other,
}: {
  name: string;
  label: string;
  /** The saved pick, which the row starts from. */
  value: string;
  /** The pick as it stands now, which gets the ring. */
  picked: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  /** The last swatch: any other colour. */
  other: { value: string; label: string };
}) {
  const swatches = [
    ...options.map((option) => ({ ...option, fill: option.value })),
    { ...other, fill: ANY_COLOUR },
  ];
  return (
    <s-stack direction="block" gap="small-200">
      <style>{SWATCH_CSS}</style>
      <s-text>{label}</s-text>
      <div role="radiogroup" aria-label={label} style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {swatches.map((swatch) => (
          <label
            key={swatch.value}
            title={swatch.label}
            style={{ position: "relative", display: "inline-flex", width: 32, height: 32 }}
          >
            <input
              type="radio"
              className="shopi-swatch-input"
              name={name}
              value={swatch.value}
              aria-label={swatch.label}
              defaultChecked={swatch.value === value}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                margin: 0,
                opacity: 0,
                cursor: "pointer",
              }}
            />
            <span
              className="shopi-swatch"
              aria-hidden="true"
              style={{
                width: "100%",
                height: "100%",
                borderRadius: "50%",
                background: swatch.fill,
                boxShadow:
                  swatch.value === picked
                    ? "0 0 0 2px #ffffff, 0 0 0 4px #303030"
                    : "inset 0 0 0 1px rgba(0, 0, 0, 0.18)",
              }}
            />
          </label>
        ))}
      </div>
    </s-stack>
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
 * synced: Shopify has it. live: Shopify has it and it is read again every
 * time it is used. missing: Shopify has none and the store would do well to
 * add it. blocked: Shopify will not say until the merchant approves a
 * permission. unknown: Shopify could not be asked.
 */
export type SyncState = "synced" | "live" | "missing" | "blocked" | "unknown";

const SYNC_BADGE: Record<SyncState, { tone: "success" | "warning" | "neutral"; text: string }> = {
  synced: { tone: "success", text: "Synced from Shopify" },
  live: { tone: "success", text: "Live from Shopify" },
  missing: { tone: "warning", text: "Not set in Shopify" },
  blocked: { tone: "warning", text: "Needs your approval" },
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
      <s-badge
        tone={tone}
        {...(state === "synced" || state === "live" ? { icon: "check" as const } : {})}
      >
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
