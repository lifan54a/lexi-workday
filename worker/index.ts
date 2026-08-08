/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { loginPage as loginPageHTML } from "../edgeone/edge-functions/login.js";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  WEB_PASSWORD: string;
  SESSION_SECRET: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

const encoder = new TextEncoder();
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SESSION_TOKEN_PURPOSE = "lexi-workday-authorized";
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

function loginPage(invalid = false, rateLimited = false): Response {
  return new Response(loginPageHTML(invalid, "/legacy", rateLimited), {
    status: rateLimited ? 429 : invalid ? 401 : 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" },
  });
}

async function sessionToken(secret: string, expiresAt: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${SESSION_TOKEN_PURPOSE}:${expiresAt}`));
  const encodedSignature = Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${expiresAt}.${encodedSignature}`;
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}

async function isSessionTokenValid(token: string, secret: string): Promise<boolean> {
  const separator = token.indexOf(".");
  if (separator <= 0) return false;
  const expiresAt = Number(token.slice(0, separator));
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds || expiresAt > nowSeconds + SESSION_TTL_SECONDS + 60) return false;
  return safeEqual(token, await sessionToken(secret, expiresAt));
}

function isPublicLoginAsset(pathname: string): boolean {
  return pathname === "/favicon.ico"
    || pathname === "/apple-touch-icon.png"
    || pathname === "/legacy/avatar.png"
    || pathname === "/legacy/pixelblast-static.js"
    || pathname.startsWith("/icons/");
}

async function clientKey(request: Request, secret: string): Promise<string> {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = request.headers.get("cf-connecting-ip") ?? forwarded ?? "unknown";
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(address));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

async function reserveLoginAttempt(request: Request, env: Env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS login_rate_limits (
    client_key TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (client_key, window_start)
  )`).run();

  const now = Date.now();
  const fingerprint = await clientKey(request, env.SESSION_SECRET);
  const windowStart = Math.floor(now / LOGIN_WINDOW_MS) * LOGIN_WINDOW_MS;
  const counter = await env.DB.prepare(`INSERT INTO login_rate_limits (client_key, window_start, attempts)
    VALUES (?, ?, 1)
    ON CONFLICT(client_key, window_start) DO UPDATE SET attempts = attempts + 1
    RETURNING attempts`).bind(fingerprint, windowStart).first<{ attempts: number }>();
  await env.DB.prepare("DELETE FROM login_rate_limits WHERE window_start < ?")
    .bind(windowStart - LOGIN_WINDOW_MS).run();
  return {
    limited: (counter?.attempts ?? LOGIN_MAX_ATTEMPTS + 1) > LOGIN_MAX_ATTEMPTS,
    retryAfter: Math.max(1, Math.ceil((windowStart + LOGIN_WINDOW_MS - now) / 1000)),
    markSuccess: () => env.DB.prepare(
      "DELETE FROM login_rate_limits WHERE client_key = ? AND window_start = ?",
    ).bind(fingerprint, windowStart).run(),
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (!env.WEB_PASSWORD || !env.SESSION_SECRET) return new Response("Server authentication is not configured", { status: 503 });

    if (url.pathname === "/login" && request.method === "GET") return loginPage();

    if (isPublicLoginAsset(url.pathname)) return env.ASSETS.fetch(request);

    if (url.pathname === "/login" && request.method === "POST") {
      const attempt = await reserveLoginAttempt(request, env);
      if (attempt.limited) {
        const response = loginPage(false, true);
        response.headers.set("retry-after", String(attempt.retryAfter));
        return response;
      }
      const form = await request.formData();
      const password = String(form.get("password") ?? "");
      if (!safeEqual(password, env.WEB_PASSWORD)) return loginPage(true);
      await attempt.markSuccess();
      const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
      const token = await sessionToken(env.SESSION_SECRET, expiresAt);
      return new Response(null, {
        status: 303,
        headers: { location: "/", "set-cookie": `lexi_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800` },
      });
    }

    const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)lexi_session=([^;]+)/)?.[1] ?? "";
    if (!(await isSessionTokenValid(cookie, env.SESSION_SECRET))) {
      if (url.pathname.startsWith("/api/")) return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.redirect(new URL("/login", url), 303);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
