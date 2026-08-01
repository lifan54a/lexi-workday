const encoder = new TextEncoder();

export function loginPage(invalid = false, assetPrefix = "/legacy") {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>Lexi's workday · 登录</title>
  <meta name="theme-color" content="#0a1020">
  <link rel="icon" href="/favicon.ico" sizes="32x32">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">
  <style>
    :root{color-scheme:light;--blue:#1479ff;--blue-2:#4d9cff;--ink:#0b1020;--muted:#778198;--line:rgba(14,28,61,.11)}
    *{box-sizing:border-box}
    html,body{margin:0;min-height:100%}
    body{min-height:100svh;display:grid;grid-template-rows:1fr auto;background:#f4f6fa;color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Display","PingFang SC","Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased}
    button,input{font:inherit}
    main{display:grid;place-items:center;padding:clamp(18px,4vw,52px)}
    .login-shell{position:relative;isolation:isolate;width:min(1080px,100%);min-height:min(640px,calc(100svh - 116px));display:grid;grid-template-columns:minmax(0,1.12fr) minmax(360px,.72fr);overflow:hidden;border:1px solid rgba(13,25,55,.12);border-radius:32px;background:#0a1020;box-shadow:0 32px 90px rgba(17,31,68,.18)}
    .login-shell::before{content:"";position:absolute;inset:0;z-index:-2;background:radial-gradient(circle at 18% 20%,rgba(18,121,255,.24),transparent 31%),radial-gradient(circle at 72% 88%,rgba(82,46,180,.24),transparent 32%),linear-gradient(135deg,#080c16 0%,#111a36 58%,#171235 100%)}
    .login-shell::after{content:"";position:absolute;inset:0;z-index:-1;opacity:.34;background:linear-gradient(118deg,rgba(9,18,42,.08),rgba(29,73,165,.18) 48%,rgba(17,13,54,.2));pointer-events:none}
    .visual{position:relative;min-height:610px;padding:clamp(42px,5vw,62px);overflow:hidden;color:#fff}
    .pixelblast-static{position:absolute;inset:0;z-index:0;width:100%;height:100%;opacity:.7;pointer-events:none}
    .visual-content{position:relative;z-index:2}
    .eyebrow{display:flex;align-items:center;gap:12px;font-size:11px;font-weight:750;letter-spacing:.3em;text-transform:uppercase;color:#4f9dff}
    .eyebrow::before{content:"";width:34px;height:1px;background:currentColor}
    .brand{position:relative;z-index:2;margin:clamp(100px,14vh,130px) 0 0;font-size:clamp(58px,6vw,82px);font-weight:750;line-height:.9;letter-spacing:-.035em}
    .brand span{display:block;margin-top:10px;color:rgba(244,247,255,.78)}
    .random-quote{position:relative;z-index:3;display:flex;align-items:center;gap:16px;max-width:32ch;margin:30px 0 0;padding:0;color:rgba(222,233,255,.82);font-size:14px;line-height:1.75;letter-spacing:.08em;text-align:left}
    .random-quote::before{content:"";width:2px;height:1.6em;flex:0 0 2px;border-radius:2px;background:#3d95ff;box-shadow:0 0 14px rgba(61,149,255,.72)}
    .avatar{position:absolute;z-index:2;right:clamp(24px,3.5vw,40px);bottom:clamp(22px,3vw,30px);width:min(30%,200px);filter:drop-shadow(0 20px 28px rgba(0,0,0,.32));transform-origin:50% 85%;animation:avatarFloat 5.6s ease-in-out infinite;user-select:none;pointer-events:none}
    .login-side{display:grid;place-items:center;padding:28px;background:rgba(248,250,255,.96);backdrop-filter:blur(18px)}
    .card{width:min(390px,100%);padding:clamp(28px,4vw,44px);border:1px solid rgba(255,255,255,.9);border-radius:26px;background:rgba(255,255,255,.78);box-shadow:0 22px 60px rgba(27,42,82,.1)}
    .mark{display:grid;place-items:center;width:48px;height:48px;margin-bottom:28px;border-radius:15px;background:linear-gradient(145deg,#1985ff,#0768e8);box-shadow:0 12px 24px rgba(20,121,255,.26);color:#fff;font-size:25px;font-weight:800}
    .private{margin:0 0 10px;color:var(--blue);font-size:11px;font-weight:750;letter-spacing:.24em;text-transform:uppercase}
    h1{margin:0;font-size:clamp(28px,3vw,36px);line-height:1.15;letter-spacing:.025em}
    .intro{margin:16px 0 30px;color:var(--muted);font-size:14px;line-height:1.8;letter-spacing:.055em}
    label{display:block;margin-bottom:10px;color:#39435a;font-size:13px;font-weight:650;letter-spacing:.08em}
    .password-field{display:flex;align-items:center;height:52px;border:1px solid var(--line);border-radius:14px;background:#fff;box-shadow:0 1px 2px rgba(15,28,60,.03);transition:border-color .2s,box-shadow .2s}
    .password-field:focus-within{border-color:rgba(20,121,255,.68);box-shadow:0 0 0 4px rgba(20,121,255,.11)}
    input{min-width:0;flex:1;height:100%;padding:0 16px;border:0;outline:0;background:transparent;color:var(--ink);letter-spacing:.08em}
    input::placeholder{color:#a3aaba;letter-spacing:0}
    .reveal{width:46px;height:46px;display:grid;place-items:center;flex:0 0 auto;border:0;background:transparent;color:#8a93a6;cursor:pointer;border-radius:11px}
    .reveal:hover,.reveal:focus-visible{color:var(--blue);background:#f1f6ff;outline:0}
    .submit{width:100%;height:52px;margin-top:16px;display:flex;align-items:center;justify-content:center;gap:10px;border:0;border-radius:14px;background:linear-gradient(135deg,#1684ff,#0868e7);color:#fff;font-weight:700;letter-spacing:.1em;cursor:pointer;box-shadow:0 13px 24px rgba(20,121,255,.24);transition:transform .2s,box-shadow .2s,filter .2s}
    .submit:hover{transform:translateY(-2px);box-shadow:0 17px 28px rgba(20,121,255,.3);filter:saturate(1.08)}
    .submit:active{transform:translateY(0)}
    .submit:focus-visible{outline:3px solid rgba(20,121,255,.24);outline-offset:3px}
    .arrow{font-size:19px;transition:transform .2s}.submit:hover .arrow{transform:translateX(3px)}
    .error{margin:0 0 14px;padding:11px 13px;border:1px solid rgba(220,55,66,.14);border-radius:12px;background:#fff1f2;color:#c72d3a;font-size:13px}
    .privacy{display:flex;align-items:center;gap:8px;margin:22px 0 0;color:#9199aa;font-size:12px;letter-spacing:.035em}
    .privacy::before{content:"";width:7px;height:7px;border-radius:50%;background:#38c976;box-shadow:0 0 0 4px rgba(56,201,118,.12)}
    footer{padding:0 24px max(20px,env(safe-area-inset-bottom));text-align:center;font-size:12px}
    footer a{color:#8d96a8;text-decoration:none}footer a:hover,footer a:focus-visible{color:var(--blue);text-decoration:underline}
    @keyframes rise{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
    @keyframes revealVisual{from{opacity:0;transform:scale(1.025)}to{opacity:1;transform:none}}
    @keyframes avatarFloat{0%,100%{transform:translate3d(0,0,0) rotate(-2deg)}35%{transform:translate3d(-3px,-11px,0) rotate(1.2deg)}70%{transform:translate3d(3px,-5px,0) rotate(-.5deg)}}
    @keyframes quoteIn{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}
    .visual{animation:revealVisual .8s cubic-bezier(.16,1,.3,1)}
    .card{animation:rise .72s .08s cubic-bezier(.16,1,.3,1) both}
    .random-quote{animation:quoteIn .72s .34s cubic-bezier(.16,1,.3,1) both}
    @media(max-width:760px){
      body{height:100svh;min-height:0;overflow:hidden;grid-template-rows:minmax(0,1fr) auto;background:#0a1020}
      main{min-height:0;height:100%;padding:0;place-items:stretch;overflow:hidden}
      .login-shell{width:100%;height:100%;min-height:0;grid-template-columns:1fr;grid-template-rows:clamp(232px,38%,320px) minmax(0,1fr);border:0;border-radius:0;box-shadow:none}
      .visual{min-height:0;padding:20px 24px 16px}
      .eyebrow{justify-content:center;font-size:9px}
      .brand{margin-top:22px;text-align:center;font-size:clamp(40px,12vw,52px);line-height:.92}
      .brand span{margin-top:5px}
      .random-quote{max-width:27ch;margin:14px 0 0;gap:11px;font-size:10.5px;line-height:1.55}
      .avatar{right:18px;bottom:10px;width:22%;max-width:88px}
      .login-side{min-height:0;align-items:center;padding:10px 18px 12px;background:transparent;overflow:hidden}
      .card{max-height:100%;margin:0;padding:20px 22px 18px;border-radius:23px;background:rgba(255,255,255,.97);box-shadow:0 18px 42px rgba(0,0,0,.2)}
      .mark{width:40px;height:40px;margin-bottom:14px;border-radius:13px;font-size:22px}
      .private{margin-bottom:6px;font-size:10px}
      h1{font-size:28px;line-height:1.1}
      .intro{margin:8px 0 16px;font-size:13px;line-height:1.6}
      label{margin-bottom:7px;font-size:12px}
      .password-field{height:46px}
      .reveal{width:42px;height:42px}
      .submit{height:46px;margin-top:12px}
      .privacy{margin-top:12px;font-size:10.5px}
      footer{position:static;z-index:5;padding:5px 16px max(7px,env(safe-area-inset-bottom));line-height:16px;background:#0a1020}
      footer a{color:rgba(255,255,255,.5)}
    }
    @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.001ms!important;transition-duration:.001ms!important}}
  </style>
</head>
<body>
  <main>
    <section class="login-shell" aria-label="Lexi's workday 登录">
      <div class="visual hero-editorial" aria-hidden="true">
        <div class="visual-content">
          <div class="eyebrow">Private workspace</div>
          <div class="brand">Lexi's<span>workday</span></div>
          <p class="random-quote"></p>
        </div>
        <img class="avatar" src="${assetPrefix}/avatar.png?v=20260801-1" alt="">
      </div>
      <div class="login-side">
        <form class="card" method="post" action="/login">
          <div class="mark" aria-hidden="true">✓</div>
          <p class="private">Secure access</p>
          <h1>欢迎回来</h1>
          <p class="intro">输入访问密码，继续进入你的排期台。</p>
          ${invalid ? '<p class="error" role="alert">密码错误，请检查后重试。</p>' : ""}
          <label for="password">访问密码</label>
          <div class="password-field">
            <input id="password" type="password" name="password" autocomplete="current-password" placeholder="请输入密码" autofocus required>
            <button class="reveal" type="button" aria-label="显示密码" aria-pressed="false">◉</button>
          </div>
          <button class="submit" type="submit"><span>进入排期台</span><span class="arrow" aria-hidden="true">→</span></button>
          <p class="privacy">私人空间 · 登录状态将安全保留 7 天</p>
        </form>
      </div>
    </section>
  </main>
  <footer>
    <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">粤ICP备2026102963号</a>
  </footer>
  <script src="${assetPrefix}/pixelblast-static.js?v=20260801-1"></script>
  <script>
    const quotes = [
      '答案正在靠近。', '先完成，再完美。', '现在正是好时机。',
      '今天适合迈出第一步。', '把复杂的事拆小一点。', '你已经知道答案了。',
      '去做那件让你眼睛发亮的事。', '允许计划发生一点变化。', '换个角度再看一次。',
      '今天会比想象中顺利。', '把注意力放回当下。', '你的坚持正在积累结果。',
      '继续，你走在正确的路上。', '好消息藏在下一步里。', '慢一点也没关系。',
      '这一次，优先相信自己。', '不要低估微小的进步。', '你可以重新开始。'
    ];
    const quote = document.querySelector('.random-quote');
    quote.textContent = quotes[Math.floor(Math.random() * quotes.length)];

    const reveal = document.querySelector('.reveal');
    const password = document.querySelector('#password');
    reveal.addEventListener('click', () => {
      const visible = password.type === 'text';
      password.type = visible ? 'password' : 'text';
      reveal.setAttribute('aria-pressed', String(!visible));
      reveal.setAttribute('aria-label', visible ? '显示密码' : '隐藏密码');
      reveal.textContent = visible ? '◉' : '—';
      password.focus();
    });
  </script>
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
    return new Response(loginPage(false, ""), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  if (!safeEqual(password, env.WEB_PASSWORD)) {
    return new Response(loginPage(true, ""), {
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
