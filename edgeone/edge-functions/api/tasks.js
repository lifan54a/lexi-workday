const encoder = new TextEncoder();
const TASKS_KEY = "tasks";

function getStore(env) {
  if (typeof LEXI_KV !== "undefined") return LEXI_KV;
  return env?.LEXI_KV;
}

async function createSessionToken(secret) {
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
    encoder.encode("lexi-workday-edgeone-authorized"),
  );
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
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
  const expected = await createSessionToken(env.SESSION_SECRET);
  return safeEqual(actual, expected);
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

export async function onRequest({ request, env }) {
  if (!(await isAuthorized(request, env))) {
    return json({ error: "unauthorized" }, 401);
  }

  const store = getStore(env);
  if (!store) return json({ error: "LEXI_KV is not bound" }, 503);

  if (request.method === "GET") {
    const raw = await store.get(TASKS_KEY);
    if (!raw) return json({ tasks: [], updatedAt: null });
    try {
      return json(JSON.parse(raw));
    } catch {
      return json({ error: "stored task data is invalid" }, 500);
    }
  }

  if (request.method === "PUT") {
    const body = await request.json();
    if (!Array.isArray(body.tasks)) {
      return json({ error: "tasks must be an array" }, 400);
    }
    const state = { tasks: body.tasks, updatedAt: new Date().toISOString() };
    await store.put(TASKS_KEY, JSON.stringify(state));
    return json({ ok: true, updatedAt: state.updatedAt });
  }

  return json({ error: "method not allowed" }, 405);
}
