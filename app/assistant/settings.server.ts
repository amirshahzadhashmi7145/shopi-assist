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

export const settingsSchema = z.object({
  enabled: z.boolean(),
  instructions: text(2000, "instructions"),
  orderLookupEnabled: z.boolean(),
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
});

export type AssistantSettings = z.infer<typeof settingsSchema>;
export type SettingsField = keyof AssistantSettings;
export type SettingsErrors = Partial<Record<SettingsField, string>>;

export const DEFAULT_SETTINGS: AssistantSettings = {
  enabled: true,
  instructions: "",
  orderLookupEnabled: false,
  retentionDays: 30,
  businessDescription: "",
  returnPolicy: "",
  shippingInfo: "",
  faq: "",
  assistantName: "",
  greeting: "",
  tone: "friendly",
};

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
    retentionDays: row.retentionDays,
    businessDescription: row.businessDescription,
    returnPolicy: row.returnPolicy,
    shippingInfo: row.shippingInfo,
    faq: row.faq,
    assistantName: row.assistantName,
    greeting: row.greeting,
    tone: (TONES as readonly string[]).includes(row.tone) ? (row.tone as Tone) : "friendly",
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

const BOOLEAN_FIELDS: readonly SettingsField[] = ["enabled", "orderLookupEnabled"];
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
    business: settings.businessDescription.length > 0,
    policies: settings.returnPolicy.length > 0 || settings.shippingInfo.length > 0,
    questions: settings.faq.length > 0,
    personality: settings.assistantName.length > 0 || settings.greeting.length > 0,
  };
}
