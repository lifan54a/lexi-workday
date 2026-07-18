const encoder = new TextEncoder();

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

function readCookie(request, name) {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] ?? "";
}

export async function middleware(context) {
  const { request, next, env } = context;
  const url = new URL(request.url);

  if (url.pathname === "/login") return next();

  if (!env.WEB_PASSWORD || !env.SESSION_SECRET) {
    return new Response("Server authentication is not configured", { status: 503 });
  }

  const expected = await createSessionToken(env.SESSION_SECRET);
  const actual = readCookie(request, "lexi_session");
  if (safeEqual(actual, expected)) return next();

  if (url.pathname.startsWith("/api/")) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return Response.redirect(new URL("/login", url), 303);
}

export const config = {
  matcher: "/:path*",
};
