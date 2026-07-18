/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

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

function loginPage(invalid = false): Response {
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lexi's workday · 登录</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f1eb;color:#222;font:16px system-ui,sans-serif}.card{width:min(360px,calc(100% - 48px));padding:32px;border-radius:20px;background:#fff;box-shadow:0 16px 50px #0001}h1{margin:0 0 8px;font-size:24px}p{color:#666}input,button{box-sizing:border-box;width:100%;padding:12px 14px;border-radius:10px;font:inherit}input{margin:14px 0;border:1px solid #ccc}button{border:0;background:#222;color:#fff;cursor:pointer}.error{color:#b42318}</style></head><body><form class="card" method="post" action="/login"><h1>Lexi's workday</h1><p>请输入访问密码</p>${invalid ? '<p class="error">密码错误，请重试。</p>' : ""}<input type="password" name="password" autocomplete="current-password" autofocus required><button type="submit">进入排期台</button></form></body></html>`, {
    status: invalid ? 401 : 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" },
  });
}

async function sessionToken(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode("lexi-workday-authorized"));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
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

    if (url.pathname === "/login" && request.method === "POST") {
      const form = await request.formData();
      const password = String(form.get("password") ?? "");
      if (!safeEqual(password, env.WEB_PASSWORD)) return loginPage(true);
      const token = await sessionToken(env.SESSION_SECRET);
      return new Response(null, {
        status: 303,
        headers: { location: "/", "set-cookie": `lexi_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800` },
      });
    }

    const token = await sessionToken(env.SESSION_SECRET);
    const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)lexi_session=([^;]+)/)?.[1] ?? "";
    if (!safeEqual(cookie, token)) {
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
