import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

import prisma from "../db.server";

export const settingsSchema = z.object({
  enabled: z.boolean(),
  instructions: z.string().trim().max(2000, "Keep instructions under 2,000 characters."),
  orderLookupEnabled: z.boolean(),
  retentionDays: z
    .number()
    .int("Use a whole number of days.")
    .min(1, "Keep conversations for at least 1 day.")
    .max(365, "Keep conversations for at most 365 days."),
});

export type AssistantSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: AssistantSettings = {
  enabled: true,
  instructions: "",
  orderLookupEnabled: false,
  retentionDays: 30,
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
  };
}

/** Validates and stores settings. `shop` must come from an authenticated session. */
export async function saveSettings(
  shop: string,
  input: unknown,
  db: PrismaClient = prisma,
): Promise<
  | { ok: true; settings: AssistantSettings }
  | { ok: false; errors: Partial<Record<keyof AssistantSettings, string>> }
> {
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) {
    const errors: Partial<Record<keyof AssistantSettings, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as keyof AssistantSettings | undefined;
      if (field && !errors[field]) errors[field] = issue.message;
    }
    return { ok: false, errors };
  }

  await db.shopSettings.upsert({
    where: { shop },
    create: { shop, ...parsed.data },
    update: parsed.data,
  });
  return { ok: true, settings: parsed.data };
}
