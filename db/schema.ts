import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The authenticated Sites user owns each snapshot; the client cannot supply an owner ID.
export const shoppingSnapshots = sqliteTable("shopping_snapshots", {
  userId: text("user_id").primaryKey(),
  stateJson: text("state_json").notNull(),
  revision: integer("revision").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
});

// Kept outside state v4: an older client saving its snapshot cannot erase delivery history/cursors.
export const shoppingCommerceConnections = sqliteTable("shopping_commerce_connections", {
  userId: text("user_id").notNull(),
  integrationId: text("integration_id").notNull(),
  ledgerJson: text("ledger_json").notNull(),
  cursor: integer("cursor").notNull().default(0),
  revision: integer("revision").notNull().default(1),
  lastOperationId: text("last_operation_id").notNull(),
  lastSyncedAt: text("last_synced_at").notNull(),
  hasMore: integer("has_more").notNull().default(0),
  sourceLastSuccessAt: text("source_last_success_at"),
  sourceLimited: integer("source_limited").notNull().default(0),
  authBlocked: integer("auth_blocked").notNull().default(0),
  sourceError: integer("source_error").notNull().default(0),
}, table => [primaryKey({ columns: [table.userId, table.integrationId] })]);
