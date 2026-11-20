import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

import prisma from "../db.server";

export const TONES = ["friendly", "professional", "playful"] as const;
export type Tone = (typeof TONES)[number];

const text = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `Keep ${label} under ${max.toLocaleString("en-US")} characters.`);

/** Dropdown choices. The empty string always means "not set". */
export const POLICY_CHOICES = {
  returnWindow: ["", "none", "7", "14", "30", "60", "90"],
  returnShipping: ["", "customer", "free"],
  processingTime: ["", "same_day", "1_2", "3_5"],
  deliveryTime: ["", "2_4", "3_5", "5_8", "7_14"],
  shipsTo: ["", "domestic", "international"],
} as const;

const choice = <T extends readonly [string, ...string[]]>(values: T) =>
  z.enum(values, "Choose one of the listed options.");

export const settingsSchema = z.object({
  enabled: z.boolean(),
  instructions: text(2000, "instructions"),
  orderLookupEnabled: z.boolean(),
  orderLookupByNumber: z.boolean(),
  retentionDays: z
    .number()
    .int("Use a whole number of days.")
    .min(1, "Keep conversations for at least 1 day.")
    .max(365, "Keep conversations for at most 365 days."),
  // Business knowledge the merchant writes during setup.
  businessDescription: text(1500, "the description"),
  returnPolicy: text(1500, "the returns summary"),
  shippingInfo: text(1500, "the shipping summary"),
  faq: text(3000, "this"),
  // Personality.
  assistantName: text(40, "the name"),
  greeting: text(300, "the welcome message"),
  tone: z.enum(TONES, "Choose one of the listed tones."),
  // What the assistant may do for shoppers.
  allowAddToCart: z.boolean(),
  allowCheckout: z.boolean(),
  allowReturns: z.boolean(),
  allowChatOrders: z.boolean(),
  allowOrderCancel: z.boolean(),
  allowAddressChange: z.boolean(),
  allowOrderEdit: z.boolean(),
  recogniseCustomers: z.boolean(),
  // Quick policy picks.
  returnWindow: choice(POLICY_CHOICES.returnWindow),
  returnShipping: choice(POLICY_CHOICES.returnShipping),
  processingTime: choice(POLICY_CHOICES.processingTime),
  deliveryTime: choice(POLICY_CHOICES.deliveryTime),
  shipsTo: choice(POLICY_CHOICES.shipsTo),
});

export type AssistantSettings = z.infer<typeof settingsSchema>;
export type SettingsField = keyof AssistantSettings;
export type SettingsErrors = Partial<Record<SettingsField, string>>;

export const DEFAULT_SETTINGS: AssistantSettings = {
  enabled: true,
  instructions: "",
  orderLookupEnabled: false,
  orderLookupByNumber: false,
  retentionDays: 30,
  businessDescription: "",
  returnPolicy: "",
  shippingInfo: "",
  faq: "",
  assistantName: "",
  greeting: "",
  tone: "friendly",
  allowAddToCart: true,
  allowCheckout: true,
  allowReturns: false,
  allowChatOrders: false,
  allowOrderCancel: false,
  allowAddressChange: false,
  allowOrderEdit: false,
  recogniseCustomers: false,
  returnWindow: "",
  returnShipping: "",
  processingTime: "",
  deliveryTime: "",
  shipsTo: "",
};

/** Returns the stored value when it is a known choice, otherwise "not set". */
function pick<T extends readonly string[]>(choices: T, value: string): T[number] {
  return (choices as readonly string[]).includes(value) ? (value as T[number]) : "";
}

/** Settings for one shop, falling back to defaults when none are saved yet. */
export async function getSettings(
  shop: string,
  db: PrismaClient = prisma,
): Promise<AssistantSettings> {
  const row = await db.shopSettings.findUnique({ where: { shop } });
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    enabled: row.enabled,
    instructions: row.instructions,
    orderLookupEnabled: row.orderLookupEnabled,
    orderLookupByNumber: row.orderLookupByNumber,
    retentionDays: row.retentionDays,
    businessDescription: row.businessDescription,
    returnPolicy: row.returnPolicy,
    shippingInfo: row.shippingInfo,
    faq: row.faq,
    assistantName: row.assistantName,
    greeting: row.greeting,
    tone: (TONES as readonly string[]).includes(row.tone) ? (row.tone as Tone) : "friendly",
    allowAddToCart: row.allowAddToCart,
    allowCheckout: row.allowCheckout,
    allowReturns: row.allowReturns,
    allowChatOrders: row.allowChatOrders,
    allowOrderCancel: row.allowOrderCancel,
    allowAddressChange: row.allowAddressChange,
    allowOrderEdit: row.allowOrderEdit,
    recogniseCustomers: row.recogniseCustomers,
    returnWindow: pick(POLICY_CHOICES.returnWindow, row.returnWindow),
    returnShipping: pick(POLICY_CHOICES.returnShipping, row.returnShipping),
    processingTime: pick(POLICY_CHOICES.processingTime, row.processingTime),
    deliveryTime: pick(POLICY_CHOICES.deliveryTime, row.deliveryTime),
    shipsTo: pick(POLICY_CHOICES.shipsTo, row.shipsTo),
  };
}

/**
 * Validates and stores some or all settings. Fields that are not passed keep
 * their current value, so each setup step can save just its own fields.
 * `shop` must come from an authenticated session.
 */
export async function saveSettings(
  shop: string,
  input: unknown,
  db: PrismaClient = prisma,
): Promise<{ ok: true; settings: AssistantSettings } | { ok: false; errors: SettingsErrors }> {
  const parsed = settingsSchema.partial().safeParse(input);
  if (!parsed.success) {
    const errors: SettingsErrors = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as SettingsField | undefined;
      if (field && !errors[field]) errors[field] = issue.message;
    }
    return { ok: false, errors };
  }

  await db.shopSettings.upsert({
    where: { shop },
    create: { shop, ...parsed.data },
    update: parsed.data,
  });
  return { ok: true, settings: await getSettings(shop, db) };
}

const BOOLEAN_FIELDS: readonly SettingsField[] = [
  "enabled",
  "orderLookupEnabled",
  "orderLookupByNumber",
  "allowAddToCart",
  "allowCheckout",
  "allowReturns",
  "allowChatOrders",
  "allowOrderCancel",
  "allowAddressChange",
  "allowOrderEdit",
  "recogniseCustomers",
];
const NUMBER_FIELDS: readonly SettingsField[] = ["retentionDays"];

/**
 * Reads the named settings fields out of a submitted form. Only the listed
 * fields are read, so a page can never change a setting it does not show.
 */
export function settingsFromForm(
  form: FormData,
  fields: readonly SettingsField[],
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (BOOLEAN_FIELDS.includes(field)) {
      // Checkboxes are only present in form data when ticked.
      values[field] = form.has(field);
    } else if (NUMBER_FIELDS.includes(field)) {
      values[field] = Number(form.get(field));
    } else {
      values[field] = String(form.get(field) ?? "");
    }
  }
  return values;
}

// ---------------------------------------------------------------------------
// Setup tour
// ---------------------------------------------------------------------------

export interface SetupState {
  /** The tour has been opened at least once. */
  started: boolean;
  /** The merchant pressed Finish (or chose to skip the tour). */
  completed: boolean;
}

export async function getSetupState(
  shop: string,
  db: PrismaClient = prisma,
): Promise<SetupState> {
  const row = await db.shopSettings.findUnique({
    where: { shop },
    select: { setupStartedAt: true, setupCompletedAt: true },
  });
  return {
    started: Boolean(row?.setupStartedAt),
    completed: Boolean(row?.setupCompletedAt),
  };
}

/** Records that the tour was opened, so the app stops redirecting to it. */
export async function markSetupStarted(
  shop: string,
  db: PrismaClient = prisma,
  now: Date = new Date(),
): Promise<void> {
  await db.shopSettings.upsert({
    where: { shop },
    create: { shop, setupStartedAt: now },
    update: { setupStartedAt: now },
  });
}

export async function markSetupCompleted(
  shop: string,
  db: PrismaClient = prisma,
  now: Date = new Date(),
): Promise<void> {
  await db.shopSettings.upsert({
    where: { shop },
    create: { shop, setupStartedAt: now, setupCompletedAt: now },
    update: { setupCompletedAt: now },
  });
}

/**
 * Which parts of setup have real content. Derived from what is saved rather
 * than from "steps clicked through", so progress is never overstated.
 */
export function setupProgress(settings: AssistantSettings) {
  return {
    policies:
      [
        settings.returnWindow,
        settings.returnShipping,
        settings.processingTime,
        settings.deliveryTime,
        settings.shipsTo,
        settings.returnPolicy,
        settings.shippingInfo,
      ].some((value) => value.length > 0),
    personality: settings.assistantName.length > 0 || settings.greeting.length > 0,
    details:
      settings.businessDescription.length > 0 ||
      settings.faq.length > 0 ||
      settings.instructions.length > 0,
  };
}

const DAYS: Record<string, string> = {
  "1_2": "1 to 2",
  "2_4": "2 to 4",
  "3_5": "3 to 5",
  "5_8": "5 to 8",
  "7_14": "7 to 14",
};

/**
 * Turns the dropdown picks into plain sentences for the assistant. Only what
 * the merchant actually chose is stated; unset picks say nothing.
 */
export function describeQuickPolicies(settings: AssistantSettings): string {
  const lines: string[] = [];

  if (settings.returnWindow === "none") {
    lines.push("Returns: this store does not accept returns.");
  } else if (settings.returnWindow) {
    lines.push(`Returns: accepted within ${settings.returnWindow} days of delivery.`);
  }
  if (settings.returnWindow !== "none") {
    if (settings.returnShipping === "customer") {
      lines.push("Return shipping: paid by the customer.");
    } else if (settings.returnShipping === "free") {
      lines.push("Return shipping: free for the customer.");
    }
  }
  if (settings.processingTime === "same_day") {
    lines.push("Dispatch: orders usually ship the same business day.");
  } else if (settings.processingTime) {
    lines.push(`Dispatch: orders usually ship within ${DAYS[settings.processingTime]} business days.`);
  }
  if (settings.deliveryTime) {
    lines.push(
      `Delivery: usually ${DAYS[settings.deliveryTime]} business days after the order ships.`,
    );
  }
  if (settings.shipsTo === "domestic") {
    lines.push("Shipping area: the store's home country only. No international shipping.");
  } else if (settings.shipsTo === "international") {
    lines.push("Shipping area: ships internationally.");
  }

  return lines.join("\n");
}
