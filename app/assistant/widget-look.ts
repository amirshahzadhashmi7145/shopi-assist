/**
 * How the chat widget looks on the storefront: its colour and the corner of
 * the page it sits in. The merchant picks both in the app's Settings; the
 * widget is told them with the rest of its settings, and the admin's preview
 * draws them.
 *
 * The widget carries the same defaults and the same rule for the text on the
 * colour, for the moment before it has heard from the app. Tests keep the
 * two copies equal.
 *
 * Nothing here touches Shopify, the database or an LLM.
 */

/** A colour as the widget takes it: "#" and six hex digits, nothing else. */
const HEX = /^#[0-9a-f]{6}$/i;

export const isAccent = (value: unknown): value is string =>
  typeof value === "string" && HEX.test(value);

export const DEFAULT_ACCENT = "#1F3D2F";

/**
 * The colours offered as swatches, each with the name read out for it. The
 * first is the default. Any other colour is the merchant's own, picked after
 * "Custom".
 */
export const ACCENT_PRESETS = [
  { value: DEFAULT_ACCENT, label: "Forest green" },
  { value: "#111111", label: "Black" },
  { value: "#1E3A5F", label: "Navy" },
  { value: "#2563EB", label: "Blue" },
  { value: "#6D28D9", label: "Purple" },
  { value: "#BE123C", label: "Raspberry" },
  { value: "#C2410C", label: "Burnt orange" },
  { value: "#0F766E", label: "Teal" },
] as const;

/** The preset a stored colour is, whatever its letters' case. Undefined: the merchant's own. */
export const presetFor = (accent: string) =>
  ACCENT_PRESETS.find((preset) => preset.value.toLowerCase() === accent.toLowerCase());

export const WIDGET_POSITIONS = ["right", "left"] as const;
export type WidgetPosition = (typeof WIDGET_POSITIONS)[number];

export const WIDGET_POSITION_LABELS: Record<WidgetPosition, string> = {
  right: "Bottom right",
  left: "Bottom left",
};

/**
 * Black or white, whichever reads better on the colour. The widget works it
 * out the same way (`readableOn` in shopi-assist.js).
 */
export function readableOn(accent: string): "#111111" | "#ffffff" {
  if (!isAccent(accent)) return "#ffffff";
  const value = parseInt(accent.slice(1), 16);
  const [red, green, blue] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
    const share = channel / 255;
    return share <= 0.03928 ? share / 12.92 : Math.pow((share + 0.055) / 1.055, 2.4);
  });
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return luminance > 0.45 ? "#111111" : "#ffffff";
}
