const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// 会话 Cookie 名称，登录成功后写入，浏览器同源请求会自动携带。
const COOKIE_NAME = 'ai_ssh_web_session';
// 会话有效期（7 天），到期后需重新登录。
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// 首次启动时使用的默认密码，建议登录后立即修改。
const DEFAULT_PASSWORD = 'admin';
// 存放密码哈希的文件名（位于 data 目录）。
const CREDENTIAL_FILE = 'web-auth.json';
// scrypt 派生密钥长度（字节）。
const KEY_LEN = 32;

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
 * 使用固定长度比较，避免通过响应时间侧信道猜测密文。
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 用 scrypt 加盐派生密码哈希；salt/hash 均以 hex 字符串保存。
 */
function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), useSalt, KEY_LEN).toString('hex');
  return { salt: useSalt, hash: derived };
}

/**
 * 校验明文密码是否匹配已保存的 salt/hash。
 */
function verifyPassword(password, salt, hash) {
  const { hash: derived } = hashPassword(password, salt);
  return safeEqual(derived, hash);
}

/**
 * 基于密码哈希派生会话值：sessionValue = HMAC(hash, "session")。
 * Cookie 中不直接暴露哈希，且密码变更后哈希变化会使旧会话自动失效。
 */
function deriveSessionValue(hash) {
  return crypto.createHmac('sha256', hash).update('session').digest('base64url');
}

/**
 * 读取凭据文件；不存在或损坏时返回 null。
 */
function readCredentialFile(credentialPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
    if (parsed && typeof parsed.salt === 'string' && typeof parsed.hash === 'string') {
      return { salt: parsed.salt, hash: parsed.hash, isDefault: parsed.isDefault === true };
    }
  } catch {
    // 文件不存在或格式错误，交由上层重新初始化。
  }
  return null;
}

/**
 * 写入凭据文件（0600 权限，尽力而为）。
 */
function writeCredentialFile(credentialPath, credential) {
  const payload = JSON.stringify({
    salt: credential.salt,
    hash: credential.hash,
    isDefault: credential.isDefault === true,
  });
  try {
    fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
    fs.writeFileSync(credentialPath, payload, { mode: 0o600 });
  } catch {
    // 无法持久化时仍在内存中保留凭据，仅本次进程有效。
  }
}

/**
 * 解析初始凭据：
 * - 若设置了 WEB_AUTH_PASSWORD，则以该环境变量为准（env 模式，不落盘）；
 * - 否则读取凭据文件；
 * - 都没有则用默认密码 admin 初始化并写盘。
 */
function loadCredential(dataDir) {
  const credentialPath = path.join(dataDir, CREDENTIAL_FILE);
  const fromEnv = process.env.WEB_AUTH_PASSWORD;
  if (fromEnv && fromEnv.trim()) {
    const password = fromEnv.trim();
    const { salt, hash } = hashPassword(password);
    return {
      salt,
      hash,
      source: 'env',
      isDefault: password === DEFAULT_PASSWORD,
      credentialPath,
    };
  }

  const existing = readCredentialFile(credentialPath);
  if (existing) {
    return { ...existing, source: 'file', credentialPath };
  }

  const { salt, hash } = hashPassword(DEFAULT_PASSWORD);
  const credential = { salt, hash, isDefault: true };
  writeCredentialFile(credentialPath, credential);
  return { ...credential, source: 'generated', credentialPath };
}

/**
 * 创建鉴权中间件、登录/登出/改密处理器。
 * 未携带有效会话 Cookie 的请求会被拦截：API 返回 401，页面返回登录页。
 */
function createAuth(dataDir) {
  const credential = loadCredential(dataDir);
  // 可变状态：改密后原地更新，无需重启进程。
  let current = {
    salt: credential.salt,
    hash: credential.hash,
    isDefault: credential.isDefault,
  };
  const isEnvManaged = credential.source === 'env';
  let sessionValue = deriveSessionValue(current.hash);

  // 判断请求是否已通过鉴权。
  function isAuthed(request) {
    const cookies = parseCookies(request.headers.cookie);
    const provided = cookies[COOKIE_NAME];
    return Boolean(provided) && safeEqual(provided, sessionValue);
  }

  // 是否仍在使用默认密码（用于前端提示尽快修改）。
  function isUsingDefaultPassword() {
    return current.isDefault === true;
  }

  // 写入会话 Cookie 的公共逻辑。
  function setSessionCookie(request, response) {
    const secure = request.secure || request.headers['x-forwarded-proto'] === 'https';
    response.cookie(COOKIE_NAME, sessionValue, {
      httpOnly: true,
      sameSite: 'strict',
      secure,
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
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
    response.status(401).type('html').send(loginPage(request.__loginLang));
  }

  // 处理登录：校验密码，通过后写入 HttpOnly 会话 Cookie。
  function handleLogin(request, response) {
    const submitted = (request.body && request.body.password) || '';
    if (!verifyPassword(submitted, current.salt, current.hash)) {
      response.status(401).json({ success: false, error: 'Invalid password' });
      return;
    }
    setSessionCookie(request, response);
    response.json({ success: true });
  }

  // 处理登出：清除会话 Cookie。
  function handleLogout(_request, response) {
    response.clearCookie(COOKIE_NAME, { path: '/' });
    response.json({ success: true });
  }

  // 修改密码：校验旧密码，写入新哈希，刷新会话值并让当前会话保持登录。
  function changePassword(request, response) {
    if (isEnvManaged) {
      response.status(400).json({
        success: false,
        error: 'Password is managed via WEB_AUTH_PASSWORD and cannot be changed here',
        code: 'ENV_MANAGED',
      });
      return;
    }
    const oldPassword = (request.body && request.body.oldPassword) || '';
    const newPassword = (request.body && request.body.newPassword) || '';
    if (!verifyPassword(oldPassword, current.salt, current.hash)) {
      response.status(401).json({ success: false, error: 'Current password is incorrect', code: 'BAD_OLD_PASSWORD' });
      return;
    }
    if (typeof newPassword !== 'string' || newPassword.length < 4) {
      response.status(400).json({ success: false, error: 'New password must be at least 4 characters', code: 'WEAK_PASSWORD' });
      return;
    }
    const { salt, hash } = hashPassword(newPassword);
    current = { salt, hash, isDefault: newPassword === DEFAULT_PASSWORD };
    writeCredentialFile(credential.credentialPath, current);
    // 刷新会话值：旧的其它会话失效，随即为当前请求重设 Cookie 以保持登录。
    sessionValue = deriveSessionValue(current.hash);
    setSessionCookie(request, response);
    response.json({ success: true });
  }

  // WebSocket 升级握手时复用同一鉴权判断。
  function verifyUpgrade(request) {
    return isAuthed(request);
  }

  return {
    source: credential.source,
    isEnvManaged,
    middleware,
    handleLogin,
    handleLogout,
    changePassword,
    verifyUpgrade,
    isAuthed,
    isUsingDefaultPassword,
  };
}

/**
 * 内联登录页 HTML，避免依赖已构建的 SPA 资源。
 * lang 由服务端根据 settings.language 注入，浏览器语言作兜底。
 */
function loginPage(lang) {
  const initialLang = lang === 'en-US' ? 'en-US' : lang === 'zh-CN' ? 'zh-CN' : '';
  const strings = {
    'zh-CN': {
      title: 'AI SSH Client',
      hint: '请输入密码以继续。',
      label: '密码',
      button: '登录',
      invalid: '密码错误。',
      network: '网络错误，请重试。',
    },
    'en-US': {
      title: 'AI SSH Client',
      hint: 'Enter your password to continue.',
      label: 'Password',
      button: 'Sign in',
      invalid: 'Invalid password.',
      network: 'Network error, please retry.',
    },
  };
  return `<!doctype html>
<html>
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
    <h1 id="title"></h1>
    <p id="hint"></p>
    <label for="password" id="label"></label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus />
    <button type="submit" id="submit"></button>
    <div class="error" id="error"></div>
  </form>
<script>
  var STRINGS = ${JSON.stringify(strings)};
  var INITIAL_LANG = ${JSON.stringify(initialLang)};
  // 优先用服务端注入的语言；否则依据浏览器语言在中/英之间选择。
  function pickLang() {
    if (INITIAL_LANG && STRINGS[INITIAL_LANG]) return INITIAL_LANG;
    var nav = (navigator.language || 'en').toLowerCase();
    return nav.indexOf('zh') === 0 ? 'zh-CN' : 'en-US';
  }
  var lang = pickLang();
  var s = STRINGS[lang];
  document.documentElement.lang = lang;
  document.getElementById('title').textContent = s.title;
  document.getElementById('hint').textContent = s.hint;
  document.getElementById('label').textContent = s.label;
  document.getElementById('submit').textContent = s.button;

  var form = document.getElementById('login-form');
  var errorEl = document.getElementById('error');
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    errorEl.textContent = '';
    var password = document.getElementById('password').value;
    try {
      var response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password }),
      });
      if (response.ok) {
        window.location.reload();
      } else {
        errorEl.textContent = s.invalid;
      }
    } catch (e) {
      errorEl.textContent = s.network;
    }
  });
</script>
</body>
</html>`;
}

module.exports = { createAuth, COOKIE_NAME, DEFAULT_PASSWORD };
