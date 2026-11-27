import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

import prisma from "../db.server";
import { DEFAULT_ASSISTANT_NAME, DEFAULT_GREETING } from "./assistant-defaults";
import {
  ABOUT_STORE_CHOICES,
  CUSTOM_PREFIX,
  MAX_CUSTOM_ANSWER,
  ORDER_FORM_CHOICES,
  POLICY_CHOICES,
  RETURN_CONDITIONS,
  SHIPPING_FEES_WITH_AMOUNT,
  cleanTopicAnswers,
  describeReturnConditions,
  type ReturnCondition,
  type TopicAnswers,
} from "./setting-options";
import type { ShippingPicks } from "./shipping";
import { NO_FACTS, type StoreFacts } from "./store-facts";
import { DEFAULT_ACCENT, WIDGET_POSITIONS, isAccent } from "./widget-look";

// The lists themselves live in setting-options.ts, which the settings pages
// share. Re-exported for the code that has always found them here.
export { ORDER_FORM_CHOICES, POLICY_CHOICES };

const text = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `Keep ${label} under ${max.toLocaleString("en-US")} characters.`);

const choice = <T extends readonly [string, ...string[]]>(values: T) =>
  z.enum(values, "Choose one of the listed options.");

/** An amount of money as typed: "50" or "4.99". Empty means none given. */
const AMOUNT = /^\d{1,7}(?:\.\d{1,2})?$/;

/**
 * Answers to common questions, by topic. A listed answer is stored by its
 * value, the merchant's own words behind "custom:". Anything else (an unknown
 * topic, an answer no longer offered) is dropped rather than refused.
 */
const topicsSchema = z
  .record(z.string(), z.string(), "Choose one of the listed answers.")
  .superRefine((answers, context) => {
    const tooLong = Object.values(answers).some(
      (answer) =>
        answer.startsWith(CUSTOM_PREFIX) &&
        answer.length - CUSTOM_PREFIX.length > MAX_CUSTOM_ANSWER,
    );
    if (tooLong) {
      context.addIssue({
        code: "custom",
        message: `Keep your own answers under ${MAX_CUSTOM_ANSWER} characters.`,
      });
    }
  })
  .transform((answers): TopicAnswers => cleanTopicAnswers(answers));

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
  // What the merchant adds in their own words. All optional.
  aboutStore: choice(ABOUT_STORE_CHOICES),
  businessDescription: text(1500, "the description"),
  returnPolicy: text(1500, "the returns note"),
  shippingInfo: text(1500, "the shipping note"),
  faq: text(3000, "this"),
  topics: topicsSchema,
  // Personality.
  assistantName: text(40, "the name"),
  greeting: text(300, "the welcome message"),
  // How the widget looks on the storefront.
  accentColor: z
    .string()
    .trim()
    .refine(isAccent, "Pick a colour, or enter one like #1F3D2F.")
    .transform((colour) => colour.toUpperCase()),
  widgetPosition: choice(WIDGET_POSITIONS),
  // What the assistant may do with an order that already exists.
  allowReturns: z.boolean(),
  allowOrderCancel: z.boolean(),
  allowAddressChange: z.boolean(),
  allowOrderEdit: z.boolean(),
  recogniseCustomers: z.boolean(),
  chatRatings: z.boolean(),
  // What the form for a change of delivery address asks for.
  orderFirstName: choice(ORDER_FORM_CHOICES.orderFirstName),
  orderCompany: choice(ORDER_FORM_CHOICES.orderCompany),
  orderAddress2: choice(ORDER_FORM_CHOICES.orderAddress2),
  // Policy picks.
  returnWindow: choice(POLICY_CHOICES.returnWindow),
  returnConditions: z
    .array(z.enum(RETURN_CONDITIONS, "Choose from the listed conditions."))
    .transform((picked): ReturnCondition[] =>
      RETURN_CONDITIONS.filter((condition) => picked.includes(condition)),
    ),
  returnShipping: choice(POLICY_CHOICES.returnShipping),
  exchanges: choice(POLICY_CHOICES.exchanges),
  refundMethod: choice(POLICY_CHOICES.refundMethod),
  processingTime: choice(POLICY_CHOICES.processingTime),
  deliveryTime: choice(POLICY_CHOICES.deliveryTime),
  shipsTo: choice(POLICY_CHOICES.shipsTo),
  shippingFee: choice(POLICY_CHOICES.shippingFee),
  shippingAmount: z
    .string()
    .trim()
    .refine((value) => value === "" || AMOUNT.test(value), "Enter an amount like 50 or 4.99."),
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
  aboutStore: "shopify",
  businessDescription: "",
  returnPolicy: "",
  shippingInfo: "",
  faq: "",
  topics: {},
  assistantName: DEFAULT_ASSISTANT_NAME,
  greeting: DEFAULT_GREETING,
  accentColor: DEFAULT_ACCENT,
  widgetPosition: "right",
  allowReturns: false,
  allowOrderCancel: false,
  allowAddressChange: false,
  allowOrderEdit: false,
  recogniseCustomers: false,
  chatRatings: true,
  orderFirstName: "optional",
  orderCompany: "hidden",
  orderAddress2: "optional",
  returnWindow: "",
  returnConditions: [],
  returnShipping: "",
  exchanges: "",
  refundMethod: "",
  processingTime: "",
  deliveryTime: "",
  shipsTo: "",
  shippingFee: "",
  shippingAmount: "",
};

/** Returns the stored value when it is a known choice, otherwise "not set". */
function pick<T extends readonly string[]>(choices: T, value: unknown): T[number] {
  return (choices as readonly unknown[]).includes(value) ? (value as T[number]) : "";
}

/** Returns the stored value when it is a known choice, otherwise the default (the first). */
function pickOr<T extends readonly string[]>(choices: T, value: unknown): T[number] {
  return (choices as readonly unknown[]).includes(value) ? (value as T[number]) : choices[0];
}

/** A stored comma-separated list, keeping only what is still offered, in the list's own order. */
function pickMany<T extends readonly string[]>(choices: T, value: unknown): Array<T[number]> {
  const stored = typeof value === "string" ? value.split(",") : [];
  return choices.filter((entry) => stored.includes(entry));
}

function storedTopics(value: unknown): TopicAnswers {
  if (typeof value !== "string" || !value) return {};
  try {
    return cleanTopicAnswers(JSON.parse(value));
  } catch {
    return {};
  }
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
    aboutStore: pickOr(ABOUT_STORE_CHOICES, row.aboutStore),
    businessDescription: row.businessDescription,
    returnPolicy: row.returnPolicy,
    shippingInfo: row.shippingInfo,
    faq: row.faq,
    topics: storedTopics(row.topics),
    // Left empty, or never set: the defaults.
    assistantName: row.assistantName || DEFAULT_ASSISTANT_NAME,
    greeting: row.greeting || DEFAULT_GREETING,
    accentColor: isAccent(row.accentColor) ? row.accentColor.toUpperCase() : DEFAULT_ACCENT,
    widgetPosition: pickOr(WIDGET_POSITIONS, row.widgetPosition),
    allowReturns: row.allowReturns,
    allowOrderCancel: row.allowOrderCancel,
    allowAddressChange: row.allowAddressChange,
    allowOrderEdit: row.allowOrderEdit,
    recogniseCustomers: row.recogniseCustomers,
    chatRatings: row.chatRatings ?? true,
    orderFirstName: pickOr(ORDER_FORM_CHOICES.orderFirstName, row.orderFirstName),
    orderCompany: pickOr(ORDER_FORM_CHOICES.orderCompany, row.orderCompany),
    orderAddress2: pickOr(ORDER_FORM_CHOICES.orderAddress2, row.orderAddress2),
    returnWindow: pick(POLICY_CHOICES.returnWindow, row.returnWindow),
    returnConditions: pickMany(RETURN_CONDITIONS, row.returnConditions),
    returnShipping: pick(POLICY_CHOICES.returnShipping, row.returnShipping),
    exchanges: pick(POLICY_CHOICES.exchanges, row.exchanges),
    refundMethod: pick(POLICY_CHOICES.refundMethod, row.refundMethod),
    processingTime: pick(POLICY_CHOICES.processingTime, row.processingTime),
    deliveryTime: pick(POLICY_CHOICES.deliveryTime, row.deliveryTime),
    shipsTo: pick(POLICY_CHOICES.shipsTo, row.shipsTo),
    shippingFee: pick(POLICY_CHOICES.shippingFee, row.shippingFee),
    shippingAmount: AMOUNT.test(row.shippingAmount ?? "") ? row.shippingAmount : "",
  };
}

/** Settings as the database holds them: lists and answers as text. */
function toRow(settings: Partial<AssistantSettings>) {
  const { returnConditions, topics, ...plain } = settings;
  return {
    ...plain,
    ...(returnConditions ? { returnConditions: returnConditions.join(",") } : {}),
    ...(topics ? { topics: JSON.stringify(topics) } : {}),
  };
}

/**
 * An amount belongs to a shipping pick that takes one. Saved together with
 * any other pick it is dropped: the page hides the amount then, and something
 * left in it must not hold up the save or be said to shoppers later.
 */
function withoutUnusedAmount(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const values = input as Record<string, unknown>;
  return typeof values.shippingFee === "string" &&
    !SHIPPING_FEES_WITH_AMOUNT.includes(values.shippingFee) &&
    "shippingAmount" in values
    ? { ...values, shippingAmount: "" }
    : input;
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
  const parsed = settingsSchema.partial().safeParse(withoutUnusedAmount(input));
  if (!parsed.success) {
    const errors: SettingsErrors = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as SettingsField | undefined;
      if (field && !errors[field]) errors[field] = issue.message;
    }
    return { ok: false, errors };
  }

  const row = toRow(parsed.data);
  await db.shopSettings.upsert({
    where: { shop },
    create: { shop, ...row },
    update: row,
  });
  return { ok: true, settings: await getSettings(shop, db) };
}

const BOOLEAN_FIELDS: readonly SettingsField[] = [
  "enabled",
  "orderLookupEnabled",
  "orderLookupByNumber",
  "allowReturns",
  "allowOrderCancel",
  "allowAddressChange",
  "allowOrderEdit",
  "recogniseCustomers",
  "chatRatings",
];
const NUMBER_FIELDS: readonly SettingsField[] = ["retentionDays"];
/** Several values in one field, comma-separated, as a multiple-choice list submits them. */
const LIST_FIELDS: readonly SettingsField[] = ["returnConditions"];
/** Structured values, submitted as JSON. */
const JSON_FIELDS: readonly SettingsField[] = ["topics"];

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
      // Switches and checkboxes are only present in form data when on.
      values[field] = form.has(field);
    } else if (NUMBER_FIELDS.includes(field)) {
      values[field] = Number(form.get(field));
    } else if (LIST_FIELDS.includes(field)) {
      values[field] = form
        .getAll(field)
        .flatMap((entry) => String(entry).split(","))
        .map((entry) => entry.trim())
        .filter(Boolean);
    } else if (JSON_FIELDS.includes(field)) {
      try {
        values[field] = JSON.parse(String(form.get(field) ?? "") || "{}");
      } catch {
        // Not readable: left for validation to refuse.
        values[field] = null;
      }
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
        settings.exchanges,
        settings.refundMethod,
        settings.processingTime,
        settings.deliveryTime,
        settings.shipsTo,
        settings.shippingFee,
        settings.returnPolicy,
        settings.shippingInfo,
      ].some((value) => value.length > 0) || settings.returnConditions.length > 0,
    details:
      (settings.aboutStore === "custom" && settings.businessDescription.length > 0) ||
      Object.keys(settings.topics).length > 0 ||
      settings.faq.length > 0 ||
      settings.instructions.length > 0,
  };
}

// ---------------------------------------------------------------------------
// In words, for the assistant
// ---------------------------------------------------------------------------

const DAYS: Record<string, string> = {
  "1_2": "1 to 2",
  "2_4": "2 to 4",
  "3_5": "3 to 5",
  "5_8": "5 to 8",
  "7_14": "7 to 14",
};

/**
 * Turns the policy picks into plain sentences for the assistant. Only what
 * the merchant actually chose is stated; unset picks say nothing.
 *
 * Nothing about delivery is here (where the store delivers, what it costs,
 * how soon orders leave, how long they take): that is read from Shopify when
 * a shopper asks, by the shipping tool, and the merchant's picks for it are
 * only that tool's fallback. See describeShippingPicks.
 */
export function describeQuickPolicies(settings: AssistantSettings): string {
  const lines: string[] = [];
  const noReturns = settings.returnWindow === "none";

  if (noReturns) {
    lines.push("Returns: this store does not accept returns.");
  } else if (settings.returnWindow) {
    lines.push(`Returns: accepted within ${settings.returnWindow} days of delivery.`);
  }
  if (!noReturns) {
    const conditions = describeReturnConditions(settings.returnConditions);
    if (conditions) lines.push(conditions);
    if (settings.returnShipping === "customer") {
      lines.push("Return shipping: paid by the customer.");
    } else if (settings.returnShipping === "free") {
      lines.push("Return shipping: free for the customer.");
    }
    if (settings.refundMethod === "original") {
      lines.push("Refunds: paid back to the original payment method once the store approves the return.");
    } else if (settings.refundMethod === "credit") {
      lines.push("Refunds: given as store credit once the store approves the return.");
    } else if (settings.refundMethod === "either") {
      lines.push(
        "Refunds: the customer chooses between the original payment method and store credit, once the store approves the return.",
      );
    }
  }
  if (settings.exchanges === "yes") {
    lines.push("Exchanges: the store exchanges items. The shopper contacts the store to arrange one.");
  } else if (settings.exchanges === "no") {
    lines.push("Exchanges: not offered.");
  }

  return lines.join("\n");
}

/**
 * The merchant's own picks about delivery, each as a plain sentence: where
 * the store delivers, what delivery costs, how soon orders leave and how long
 * they take. Each is used only for what Shopify does not answer: with
 * Shopify's own answer, that is the one given and the pick is left out.
 */
export function describeShippingPicks(
  settings: AssistantSettings,
  facts: StoreFacts = NO_FACTS,
): ShippingPicks {
  const picks: ShippingPicks = {};
  if (settings.shipsTo === "domestic") {
    picks.area = "Shipping area: the store's home country only. No international shipping.";
  } else if (settings.shipsTo === "international") {
    picks.area = "Shipping area: ships internationally.";
  }

  const amount =
    SHIPPING_FEES_WITH_AMOUNT.includes(settings.shippingFee) && settings.shippingAmount
      ? `${settings.shippingAmount}${facts.currencyCode ? ` ${facts.currencyCode}` : " in the store's currency"}`
      : "";
  if (settings.shippingFee === "free") {
    picks.cost = "Shipping cost: free on every order.";
  } else if (settings.shippingFee === "free_over") {
    picks.cost = amount
      ? `Shipping cost: free on orders over ${amount}. Below that, the checkout shows the cost.`
      : "Shipping cost: free above a minimum order value. The checkout shows that value and the cost below it.";
  } else if (settings.shippingFee === "flat") {
    picks.cost = amount
      ? `Shipping cost: a flat ${amount} per order.`
      : "Shipping cost: one flat rate per order, shown at checkout.";
  } else if (settings.shippingFee === "calculated") {
    picks.cost = "Shipping cost: calculated at checkout from the delivery address.";
  }

  if (settings.processingTime === "same_day") {
    picks.dispatch = "Dispatch: orders usually ship the same business day.";
  } else if (settings.processingTime) {
    picks.dispatch = `Dispatch: orders usually ship within ${DAYS[settings.processingTime]} business days.`;
  }
  if (settings.deliveryTime) {
    picks.deliveryTime = `Delivery: usually ${DAYS[settings.deliveryTime]} business days after the order ships.`;
  }
  return picks;
}

/** The picks as lines of text, for an assistant that has no shipping tool to ask. */
export function shippingPicksText(picks: ShippingPicks): string {
  return [picks.area, picks.cost, picks.dispatch, picks.deliveryTime].filter(Boolean).join("\n");
}

/**
 * What the assistant is told the business is: the merchant's own words, or
 * the store's description in Shopify, or nothing, as the merchant chose.
 */
export function aboutBusiness(settings: AssistantSettings, facts: StoreFacts = NO_FACTS): string {
  if (settings.aboutStore === "custom") return settings.businessDescription;
  if (settings.aboutStore === "shopify") return facts.description ?? "";
  return "";
}
