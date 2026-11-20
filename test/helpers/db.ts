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
  // One connection only. With several, a migration that drops and re-creates a
  // table can run its next statement on a connection that still remembers the
  // old table, and fail with "there is already another table with this name".
  const db = new PrismaClient({
    datasourceUrl: `file:${join(dir, "test.sqlite")}?connection_limit=1`,
  });

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
