const encoder = new TextEncoder();
const TASKS_KEY = "tasks";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SESSION_TOKEN_PURPOSE = "lexi-workday-edgeone-authorized";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const URGENCIES = new Set(["high", "medium", "low"]);

function getStore(env) {
  if (typeof LEXI_KV !== "undefined") return LEXI_KV;
  return env?.LEXI_KV;
}

async function createSessionToken(secret, expiresAt) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${SESSION_TOKEN_PURPOSE}:${expiresAt}`),
  );
  const encodedSignature = Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${expiresAt}.${encodedSignature}`;
}

function safeEqual(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

async function isAuthorized(request, env) {
  if (!env?.SESSION_SECRET) return false;
  const cookie = request.headers.get("cookie") ?? "";
  const actual = cookie.match(/(?:^|;\s*)lexi_session=([^;]+)/)?.[1] ?? "";
  const separator = actual.indexOf(".");
  if (separator <= 0) return false;
  const expiresAt = Number(actual.slice(0, separator));
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= nowSeconds ||
    expiresAt > nowSeconds + SESSION_TTL_SECONDS + 60
  ) return false;
  return safeEqual(actual, await createSessionToken(env.SESSION_SECRET, expiresAt));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function isSafeLink(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidTask(task, allowUnsafeLinks = false) {
  if (!task || typeof task !== "object") return false;
  const startDate = task.startDate ?? task.date;
  return typeof task.id === "string" && task.id.length > 0 && task.id.length <= 128
    && typeof task.project === "string" && task.project.trim().length > 0 && task.project.length <= 60
    && typeof task.urgency === "string" && URGENCIES.has(task.urgency)
    && typeof task.hours === "number" && Number.isFinite(task.hours) && task.hours >= 0 && task.hours <= 24
    && typeof task.progress === "number" && Number.isInteger(task.progress) && task.progress >= 0 && task.progress <= 100
    && typeof startDate === "string" && ISO_DATE.test(startDate)
    && (task.duration === undefined || (typeof task.duration === "number" && Number.isInteger(task.duration) && task.duration >= 1 && task.duration <= 365))
    && (task.reviewDate === undefined || (typeof task.reviewDate === "string" && (!task.reviewDate || ISO_DATE.test(task.reviewDate))))
    && (task.notes === undefined || (typeof task.notes === "string" && task.notes.length <= 300))
    && (task.reqDoc === undefined || (typeof task.reqDoc === "string" && task.reqDoc.length <= 500 && (allowUnsafeLinks || isSafeLink(task.reqDoc))))
    && (task.createdAt === undefined || (typeof task.createdAt === "number" && Number.isFinite(task.createdAt)));
}

function areValidTasks(tasks, allowUnsafeLinks = false) {
  return Array.isArray(tasks) && tasks.length <= 5000
    && tasks.every((task) => isValidTask(task, allowUnsafeLinks));
}

function parseState(raw) {
  if (!raw) return { tasks: [], updatedAt: null };
  const state = JSON.parse(raw);
  if (!state || !areValidTasks(state.tasks, true) || (state.updatedAt !== null && typeof state.updatedAt !== "string")) {
    throw new Error("stored task data is invalid");
  }
  return state;
}

export async function onRequest({ request, env }) {
  if (!(await isAuthorized(request, env))) {
    return json({ error: "unauthorized" }, 401);
  }

  const store = getStore(env);
  if (!store) return json({ error: "LEXI_KV is not bound" }, 503);

  if (request.method === "GET") {
    const raw = await store.get(TASKS_KEY);
    try {
      return json(parseState(raw));
    } catch {
      return json({ error: "stored task data is invalid" }, 500);
    }
  }

  if (request.method === "PUT") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "request body must be valid JSON" }, 400);
    }
    if (!areValidTasks(body.tasks)) {
      return json({ error: "tasks contain invalid data" }, 400);
    }
    if (!(body.expectedUpdatedAt === null || typeof body.expectedUpdatedAt === "string")) {
      return json({ error: "expectedUpdatedAt is required" }, 428);
    }

    let current;
    try {
      current = parseState(await store.get(TASKS_KEY));
    } catch {
      return json({ error: "stored task data is invalid" }, 500);
    }
    if (current.updatedAt !== body.expectedUpdatedAt) {
      return json({ error: "task state changed", ...current }, 409);
    }
    const state = {
      tasks: body.tasks,
      updatedAt: `${new Date().toISOString()}-${crypto.randomUUID()}`,
    };
    await store.put(TASKS_KEY, JSON.stringify(state));
    return json({ ok: true, updatedAt: state.updatedAt });
  }

  return json({ error: "method not allowed" }, 405);
}
