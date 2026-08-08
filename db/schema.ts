import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const appState = sqliteTable("app_state", {
  id: integer("id").primaryKey(),
  tasks: text("tasks").notNull().default("[]"),
  updatedAt: text("updated_at").notNull(),
});

export const loginRateLimits = sqliteTable(
  "login_rate_limits",
  {
    clientKey: text("client_key").notNull(),
    windowStart: integer("window_start").notNull(),
    attempts: integer("attempts").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.clientKey, table.windowStart] })],
);
