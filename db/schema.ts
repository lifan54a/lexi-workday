import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const appState = sqliteTable("app_state", {
  id: integer("id").primaryKey(),
  tasks: text("tasks").notNull().default("[]"),
  updatedAt: text("updated_at").notNull(),
});
