const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// 会话 Cookie 名称，登录成功后写入，浏览器同源请求会自动携带。
const COOKIE_NAME = 'ai_ssh_web_session';
// 会话有效期（7 天），到期后需重新登录。
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 解析请求头中的 Cookie 字符串，返回键值对。
 */
function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

/**
 * 使用固定长度比较，避免通过响应时间侧信道猜测令牌。
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 解析或生成访问令牌：优先取 WEB_AUTH_TOKEN 环境变量；
 * 否则在 data 目录持久化一个随机令牌，重启后保持不变。
 */
function resolveAccessToken(dataDir) {
  const fromEnv = process.env.WEB_AUTH_TOKEN;
  if (fromEnv && fromEnv.trim()) {
    return { token: fromEnv.trim(), source: 'env' };
  }
  const tokenPath = path.join(dataDir, 'web-access-token');
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing) return { token: existing, source: 'file' };
  } catch {
    // 文件不存在，继续生成新令牌。
  }
  const token = crypto.randomBytes(24).toString('base64url');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  } catch {
    // 无法持久化时仍返回令牌，仅在本次进程内有效。
  }
  return { token, source: 'generated' };
}

/**
 * 基于访问令牌派生会话值：sessionValue = HMAC(token, "session")。
 * 这样 Cookie 中不直接暴露原始令牌，且服务端无需存储会话表。
 */
function deriveSessionValue(token) {
  return crypto.createHmac('sha256', token).update('session').digest('base64url');
}

/**
 * 创建鉴权中间件与登录/登出处理器。
 * 未携带有效会话 Cookie 的请求会被拦截：API 返回 401，页面返回登录页。
 */
function createAuth(dataDir) {
  const { token, source } = resolveAccessToken(dataDir);
  const sessionValue = deriveSessionValue(token);

  // 判断请求是否已通过鉴权。
  function isAuthed(request) {
    const cookies = parseCookies(request.headers.cookie);
    const provided = cookies[COOKIE_NAME];
    return Boolean(provided) && safeEqual(provided, sessionValue);
  }

  // Express 中间件：放行登录相关端点和静态资源，其余需鉴权。
  function middleware(request, response, next) {
    if (isAuthed(request)) {
      next();
      return;
    }
    if (request.path === '/api/login' || request.path === '/api/auth-status') {
      next();
      return;
    }
    // API 请求返回 401，页面请求返回登录页。
    if (request.path.startsWith('/api/')) {
      response.status(401).json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }
    response.status(401).type('html').send(loginPage());
  }

  // 处理登录：校验令牌，通过后写入 HttpOnly 会话 Cookie。
  function handleLogin(request, response) {
    const submitted = (request.body && request.body.token) || '';
    if (!safeEqual(submitted, token)) {
      response.status(401).json({ success: false, error: 'Invalid access token' });
      return;
    }
    const secure = request.secure || request.headers['x-forwarded-proto'] === 'https';
    response.cookie(COOKIE_NAME, sessionValue, {
      httpOnly: true,
      sameSite: 'strict',
      secure,
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
    response.json({ success: true });
  }

  // 处理登出：清除会话 Cookie。
  function handleLogout(_request, response) {
    response.clearCookie(COOKIE_NAME, { path: '/' });
    response.json({ success: true });
  }

  // WebSocket 升级握手时复用同一鉴权判断。
  function verifyUpgrade(request) {
    return isAuthed(request);
  }

  return {
    token,
    source,
    middleware,
    handleLogin,
    handleLogout,
    verifyUpgrade,
    isAuthed,
  };
}

/**
 * 内联登录页 HTML，避免依赖已构建的 SPA 资源。
 */
function loginPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AI SSH Client — Sign in</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: #0f1115; color: #e6e8eb;
  }
  .card {
    width: 100%; max-width: 340px; padding: 32px;
    background: #171a21; border: 1px solid #262b36; border-radius: 12px;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p { font-size: 13px; color: #9aa4b2; margin: 0 0 20px; }
  label { display: block; font-size: 12px; color: #9aa4b2; margin-bottom: 6px; }
  input {
    width: 100%; padding: 10px 12px; font-size: 14px;
    background: #0f1115; color: #e6e8eb; border: 1px solid #2f3540; border-radius: 8px;
  }
  input:focus { outline: none; border-color: #3b82f6; }
  button {
    width: 100%; margin-top: 16px; padding: 10px 12px; font-size: 14px; font-weight: 600;
    background: #3b82f6; color: #fff; border: none; border-radius: 8px; cursor: pointer;
  }
  button:hover { background: #2f6fe0; }
  .error { margin-top: 12px; font-size: 12px; color: #f87171; min-height: 16px; }
</style>
</head>
<body>
  <form class="card" id="login-form">
    <h1>AI SSH Client</h1>
    <p>Enter the access token to continue.</p>
    <label for="token">Access token</label>
    <input id="token" name="token" type="password" autocomplete="current-password" autofocus />
    <button type="submit">Sign in</button>
    <div class="error" id="error"></div>
  </form>
<script>
  const form = document.getElementById('login-form');
  const errorEl = document.getElementById('error');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';
    const token = document.getElementById('token').value;
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (response.ok) {
        window.location.reload();
      } else {
        errorEl.textContent = 'Invalid access token.';
      }
    } catch {
      errorEl.textContent = 'Network error, please retry.';
    }
  });
</script>
</body>
</html>`;
}

module.exports = { createAuth, COOKIE_NAME };
