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

function loginPage(invalid = false): Response {
  return new Response(loginPageHTML(invalid), {
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
