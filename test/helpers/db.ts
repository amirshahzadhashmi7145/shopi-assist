import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";

/**
 * Creates a throwaway SQLite database with the real migrations applied, so
 * storage tests exercise the same schema the app runs on.
 */
export async function createTestDb(): Promise<{
  db: PrismaClient;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "shopi-assist-test-"));
  const db = new PrismaClient({ datasourceUrl: `file:${join(dir, "test.sqlite")}` });

  const migrationsDir = join(process.cwd(), "prisma", "migrations");
  const migrations = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const migration of migrations) {
    const sql = readFileSync(join(migrationsDir, migration, "migration.sql"), "utf8");
    const statements = sql
      .split(/;\s*(?:\n|$)/)
      .map((statement) => statement.replace(/^\s*--.*$/gm, "").trim())
      .filter(Boolean);
    for (const statement of statements) {
      await db.$executeRawUnsafe(statement);
    }
  }

  return {
    db,
    cleanup: async () => {
      await db.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
