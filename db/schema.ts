import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The authenticated Sites user owns each snapshot; the client cannot supply an owner ID.
export const shoppingSnapshots = sqliteTable("shopping_snapshots", {
  userId: text("user_id").primaryKey(),
  stateJson: text("state_json").notNull(),
  revision: integer("revision").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
});
