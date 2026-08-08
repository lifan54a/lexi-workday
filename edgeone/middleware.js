const encoder = new TextEncoder();
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SESSION_TOKEN_PURPOSE = "lexi-workday-edgeone-authorized";

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

async function isSessionTokenValid(token, secret) {
  const separator = token.indexOf(".");
  if (separator <= 0) return false;
  const expiresAt = Number(token.slice(0, separator));
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= nowSeconds ||
    expiresAt > nowSeconds + SESSION_TTL_SECONDS + 60
  ) return false;
  return safeEqual(token, await createSessionToken(secret, expiresAt));
}

function readCookie(request, name) {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] ?? "";
}

function isPublicLoginAsset(pathname) {
  return pathname === "/favicon.ico"
    || pathname === "/apple-touch-icon.png"
    || pathname === "/avatar.png"
    || pathname === "/pixelblast-static.js"
    || pathname.startsWith("/icons/");
}

export async function middleware(context) {
  const { request, next, env } = context;
  const url = new URL(request.url);

  if (url.pathname === "/login" || isPublicLoginAsset(url.pathname)) return next();

  if (!env.WEB_PASSWORD || !env.SESSION_SECRET) {
    return new Response("Server authentication is not configured", { status: 503 });
  }

  const actual = readCookie(request, "lexi_session");
  if (await isSessionTokenValid(actual, env.SESSION_SECRET)) return next();

  if (url.pathname.startsWith("/api/")) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return Response.redirect(new URL("/login", url), 303);
}

export const config = {
  matcher: ["/", "/:path*"],
};
