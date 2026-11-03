import { isSessionTokenValid } from "../../cloud-functions/login.js";

export async function onRequest({ request, env }) {
  const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)lexi_session=([^;]+)/)?.[1] ?? "";
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (!env?.SESSION_SECRET || !(await isSessionTokenValid(cookie, env.SESSION_SECRET))) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers });
  }
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { ...headers, allow: "GET" } });
  const store = typeof LEXI_KV !== "undefined" ? LEXI_KV : env?.LEXI_KV;
  if (!store) return new Response(JSON.stringify({ tasks: [], updatedAt: null }), { headers });
  const raw = await store.get("tasks");
  return new Response(raw || JSON.stringify({ tasks: [], updatedAt: null }), { headers });
}
