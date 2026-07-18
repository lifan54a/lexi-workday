const encoder = new TextEncoder();

function loginPage(invalid = false) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Lexi's workday · 登录</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f1eb;color:#222;font:16px system-ui,sans-serif}
    .card{width:min(360px,calc(100% - 48px));padding:32px;border-radius:20px;background:#fff;box-shadow:0 16px 50px #0001}
    h1{margin:0 0 8px;font-size:24px}p{color:#666}
    input,button{box-sizing:border-box;width:100%;padding:12px 14px;border-radius:10px;font:inherit}
    input{margin:14px 0;border:1px solid #ccc}button{border:0;background:#222;color:#fff;cursor:pointer}
    .error{color:#b42318}
  </style>
</head>
<body>
  <form class="card" method="post" action="/login">
    <h1>Lexi's workday</h1>
    <p>请输入访问密码</p>
    ${invalid ? '<p class="error">密码错误，请重试。</p>' : ""}
    <input type="password" name="password" autocomplete="current-password" autofocus required>
    <button type="submit">进入排期台</button>
  </form>
</body>
</html>`;
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

export async function onRequest({ request, env }) {
  if (!env.WEB_PASSWORD || !env.SESSION_SECRET) {
    return new Response("Server authentication is not configured", { status: 503 });
  }

  if (request.method === "GET") {
    return new Response(loginPage(), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  if (!safeEqual(password, env.WEB_PASSWORD)) {
    return new Response(loginPage(true), {
      status: 401,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const token = await createSessionToken(env.SESSION_SECRET);
  return new Response(null, {
    status: 303,
    headers: {
      location: "/",
      "set-cookie": `lexi_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`,
      "cache-control": "no-store",
    },
  });
}
