import { env } from "cloudflare:workers";

type StoredState = {
  tasks: unknown[];
  updatedAt: string | null;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const URGENCIES = new Set(["high", "medium", "low"]);

async function ensureTable() {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY,
    tasks TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  )`).run();
}

function isSafeLink(value: string): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidTask(value: unknown, allowUnsafeLinks = false): boolean {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  const startDate = task.startDate ?? task.date;
  return (
    typeof task.id === "string" && task.id.length > 0 && task.id.length <= 128 &&
    typeof task.project === "string" && task.project.trim().length > 0 && task.project.length <= 60 &&
    typeof task.urgency === "string" && URGENCIES.has(task.urgency) &&
    typeof task.hours === "number" && Number.isFinite(task.hours) && task.hours >= 0 && task.hours <= 24 &&
    typeof task.progress === "number" && Number.isInteger(task.progress) && task.progress >= 0 && task.progress <= 100 &&
    typeof startDate === "string" && ISO_DATE.test(startDate) &&
    (task.duration === undefined || (typeof task.duration === "number" && Number.isInteger(task.duration) && task.duration >= 1 && task.duration <= 365)) &&
    (task.reviewDate === undefined || (typeof task.reviewDate === "string" && (!task.reviewDate || ISO_DATE.test(task.reviewDate)))) &&
    (task.notes === undefined || (typeof task.notes === "string" && task.notes.length <= 300)) &&
    (task.reqDoc === undefined || (typeof task.reqDoc === "string" && task.reqDoc.length <= 500 && (allowUnsafeLinks || isSafeLink(task.reqDoc)))) &&
    (task.createdAt === undefined || (typeof task.createdAt === "number" && Number.isFinite(task.createdAt)))
  );
}

function areValidTasks(value: unknown, allowUnsafeLinks = false): value is unknown[] {
  return Array.isArray(value) && value.length <= 5000
    && value.every((task) => isValidTask(task, allowUnsafeLinks));
}

async function readState(): Promise<StoredState> {
  const row = await env.DB.prepare("SELECT tasks, updated_at FROM app_state WHERE id = 1")
    .first<{ tasks: string; updated_at: string }>();
  if (!row) return { tasks: [], updatedAt: null };
  const tasks = JSON.parse(row.tasks) as unknown;
  if (!areValidTasks(tasks, true)) throw new Error("Stored task data is invalid");
  return { tasks, updatedAt: row.updated_at };
}

export async function GET() {
  await ensureTable();
  try {
    return Response.json(await readState(), { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "stored task data is invalid" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  await ensureTable();
  let body: { tasks?: unknown; expectedUpdatedAt?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  if (!areValidTasks(body.tasks)) {
    return Response.json({ error: "tasks contain invalid data" }, { status: 400 });
  }
  if (!(body.expectedUpdatedAt === null || typeof body.expectedUpdatedAt === "string")) {
    return Response.json({ error: "expectedUpdatedAt is required" }, { status: 428 });
  }

  const updatedAt = `${new Date().toISOString()}-${crypto.randomUUID()}`;
  const serializedTasks = JSON.stringify(body.tasks);
  const result = body.expectedUpdatedAt === null
    ? await env.DB.prepare(
        "INSERT OR IGNORE INTO app_state (id, tasks, updated_at) VALUES (1, ?, ?)",
      ).bind(serializedTasks, updatedAt).run()
    : await env.DB.prepare(
        "UPDATE app_state SET tasks = ?, updated_at = ? WHERE id = 1 AND updated_at = ?",
      ).bind(serializedTasks, updatedAt, body.expectedUpdatedAt).run();

  if (result.meta.changes !== 1) {
    return Response.json(
      { error: "task state changed", ...(await readState()) },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }
  return Response.json({ ok: true, updatedAt });
}
