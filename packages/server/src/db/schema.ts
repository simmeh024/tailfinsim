import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Database schema.
 *
 * The real game schema — world, player, airline — arrives in M0-06. This file
 * currently holds only the `health` table, which exists to prove the whole
 * pipeline end to end: schema definition → generated SQL migration → applied
 * migration → a live read and write from the server.
 *
 * Migrations are generated into `drizzle/` and **committed as SQL**. They are
 * never generated at runtime (M0-05).
 */

export const health = pgTable('health', {
  id: serial('id').primaryKey(),

  /**
   * Set by the database, not by the application. A row whose timestamp came
   * from the server process would prove the server's clock works, not that the
   * database is reachable and writable — which is the point of the table.
   */
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),

  note: text('note'),
});

export type HealthRow = typeof health.$inferSelect;
export type NewHealthRow = typeof health.$inferInsert;
