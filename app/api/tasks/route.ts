import { env } from "cloudflare:workers";

async function ensureTable() {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY,
    tasks TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  )`).run();
}

export async function GET() {
  await ensureTable();
  const row = await env.DB.prepare("SELECT tasks, updated_at FROM app_state WHERE id = 1").first<{ tasks: string; updated_at: string }>();
  return Response.json({ tasks: row ? JSON.parse(row.tasks) : [], updatedAt: row?.updated_at ?? null });
}

export async function PUT(request: Request) {
  await ensureTable();
  const body = await request.json() as { tasks?: unknown };
  if (!Array.isArray(body.tasks)) return Response.json({ error: "tasks must be an array" }, { status: 400 });
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO app_state (id, tasks, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET tasks = excluded.tasks, updated_at = excluded.updated_at`)
    .bind(JSON.stringify(body.tasks), updatedAt).run();
  return Response.json({ ok: true, updatedAt });
}
