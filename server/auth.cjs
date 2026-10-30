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
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
// MCP HTTP 端点用 Bearer 令牌（即 Web 登录密码）鉴权。scrypt 每次约几十毫秒，
// 而工具调用是高频请求，因此校验成功后缓存「令牌摘要 → 密码哈希」；
// 改密后哈希变化，旧条目自动失配，无需逐条失效。
const MCP_TOKEN_CACHE_LIMIT = 32;

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
    if (key) {
      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        // Malformed cookie values must not turn authentication into a 500.
        cookies[key] = '';
      }
    }
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

// 凭据文件的备份后缀：改密时把上一份可用凭据备份到 `<file>.bak`，供损坏时恢复。
const CREDENTIAL_BACKUP_SUFFIX = '.bak';

/**
 * 解析凭据 JSON 文本；结构不合法（缺 salt/hash）时也视为无效并返回 null。
 */
function parseCredential(raw) {
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed.salt === 'string' && typeof parsed.hash === 'string') {
    return { salt: parsed.salt, hash: parsed.hash, isDefault: parsed.isDefault === true };
  }
  return null;
}

/**
 * 读取单个凭据文件，明确区分三种状态：
 * - { status: 'ok', value }       解析成功；
 * - { status: 'missing' }         文件不存在（唯一允许首次初始化的情形）；
 * - { status: 'invalid', error }  文件存在但不可读/解析失败。
 */
function readCredentialAt(credentialPath) {
  let raw;
  try {
    raw = fs.readFileSync(credentialPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { status: 'missing' };
    }
    return { status: 'invalid', error };
  }
  try {
    const value = parseCredential(raw);
    if (value) {
      return { status: 'ok', value };
    }
    return { status: 'invalid', error: new Error('凭据文件缺少 salt/hash 字段') };
  } catch (error) {
    return { status: 'invalid', error };
  }
}

/**
 * 读取凭据文件：主文件损坏时尝试 `.bak`；只有主文件与备份都不存在才允许首次初始化。
 *
 * 安全约束：主文件存在但损坏且无可用备份时**抛错拒绝启动**，绝不回退到默认密码——
 * 否则攻击者只要截断/破坏凭据文件，就能把 Web 网关重置成 admin。
 */
function readCredentialFile(credentialPath) {
  const primary = readCredentialAt(credentialPath);
  if (primary.status === 'ok') {
    return primary.value;
  }

  const backupPath = `${credentialPath}${CREDENTIAL_BACKUP_SUFFIX}`;
  const backup = readCredentialAt(backupPath);
  if (backup.status === 'ok') {
    // 主文件不可用但备份可用：用它启动，并尽力把备份写回主文件。
    try {
      fs.writeFileSync(credentialPath, JSON.stringify(backup.value), { mode: 0o600 });
    } catch {
      // 写回失败不影响本次使用内存中的备份凭据。
    }
    console.warn(`[auth] 凭据文件不可用（${primary.status}），已从备份 ${backupPath} 恢复。`);
    return backup.value;
  }

  if (primary.status === 'missing' && backup.status === 'missing') {
    return null; // 首次启动：主文件与备份都不存在时才允许初始化默认密码
  }

  const reason = primary.status === 'invalid'
    ? (primary.error && primary.error.message) || String(primary.error)
    : `备份文件不可用（${backup.status}）`;
  const error = new Error(
    `凭据文件 ${credentialPath} 已损坏且无可用备份（${reason}）。`
      + '为避免被重置为默认密码，已拒绝启动；请修复该文件，或删除它与 .bak 以重新初始化。',
  );
  error.code = 'credential-corrupt';
  throw error;
}

/**
 * 写入凭据文件（0600 权限，先写临时文件再原子 rename）。
 * 覆盖前把当前可用凭据备份为 `.bak`（损坏文件不参与备份）。
 * @returns {boolean} 是否成功持久化。调用方必须据此决定是否提交内存状态。
 */
function writeCredentialFile(credentialPath, credential) {
  const payload = JSON.stringify({
    salt: credential.salt,
    hash: credential.hash,
    isDefault: credential.isDefault === true,
  });
  const tmpPath = `${credentialPath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
    try {
      const currentRaw = fs.readFileSync(credentialPath, 'utf8');
      if (parseCredential(currentRaw)) {
        fs.writeFileSync(`${credentialPath}${CREDENTIAL_BACKUP_SUFFIX}`, currentRaw, { mode: 0o600 });
      }
    } catch {
      // 无现有文件或不可读：无需备份。
    }
    fs.writeFileSync(tmpPath, payload, { mode: 0o600 });
    fs.renameSync(tmpPath, credentialPath);
    return true;
  } catch (error) {
    // 落盘失败必须让调用方知道（不能假装改密成功）。
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // 忽略清理失败。
    }
    console.error(`[auth] 无法写入凭据文件 ${credentialPath}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
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
  const persisted = writeCredentialFile(credentialPath, credential);
  if (!persisted) {
    // 首次初始化写盘失败时仍以内存默认密码启动；但重启后可能再次初始化，需提示运维。
    console.warn('[auth] 默认凭据未能持久化，重启后可能需要重新初始化密码。');
  }
  return { ...credential, source: 'generated', credentialPath };
}

/**
 * 创建鉴权中间件、登录/登出/改密处理器。
 * 未携带有效会话 Cookie 的请求会被拦截：API 返回 401，页面返回登录页。
 */
function createAuth(dataDir, options = {}) {
  const credential = loadCredential(dataDir);
  // 改密成功后的外部回调：供 Web 服务层撤销改密前建立的所有 WebSocket 连接。
  // 旧 socket 在建立时只鉴权一次，改密后必须主动失效，否则被盗密码连接的攻击者仍可继续操作 SSH。
  const onPasswordChanged = typeof options.onPasswordChanged === 'function'
    ? options.onPasswordChanged
    : null;
  // 可变状态：改密后原地更新，无需重启进程。
  let current = {
    salt: credential.salt,
    hash: credential.hash,
    isDefault: credential.isDefault,
  };
  const isEnvManaged = credential.source === 'env';
  let sessionValue = deriveSessionValue(current.hash);
  const loginFailures = new Map();

  // 限流的客户端标识：只使用真实连接地址，绝不直接信任客户端自报的 X-Forwarded-For。
  // 反向代理场景下由 Express 的 trust proxy（WEB_TRUSTED_PROXIES）决定 request.ip；
  // 未声明可信代理时 request.ip 就是 socket 直连地址，伪造转发头无法绕过限流。
  function loginClientKey(request) {
    const address = request.ip
      || request.socket?.remoteAddress
      || request.connection?.remoteAddress
      || 'unknown';
    return String(address).slice(0, 200);
  }

  function isLoginBlocked(request) {
    const entry = loginFailures.get(loginClientKey(request));
    if (!entry) return false;
    if (entry.resetAt <= Date.now()) {
      loginFailures.delete(loginClientKey(request));
      return false;
    }
    return entry.count >= LOGIN_MAX_FAILURES;
  }

  function recordLoginFailure(request) {
    const key = loginClientKey(request);
    const currentEntry = loginFailures.get(key);
    const entry = currentEntry && currentEntry.resetAt > Date.now()
      ? currentEntry
      : { count: 0, resetAt: Date.now() + LOGIN_WINDOW_MS };
    entry.count += 1;
    loginFailures.set(key, entry);
  }

  function clearLoginFailures(request) {
    loginFailures.delete(loginClientKey(request));
  }

  // 判断请求是否已通过鉴权。
  function isAuthed(request) {
    const cookies = parseCookies(request.headers.cookie);
    const provided = cookies[COOKIE_NAME];
    return Boolean(provided) && safeEqual(provided, sessionValue);
  }

  // MCP 令牌缓存：sha256(令牌) → 校验时的密码哈希。
  const mcpTokenCache = new Map();

  function digestToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  }

  /** 从 Authorization: Bearer / x-mcp-token 中取出令牌。 */
  function extractMcpToken(request) {
    const authorization = request.headers?.authorization;
    if (typeof authorization === 'string') {
      const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
      if (match && match[1].trim()) {
        return match[1].trim();
      }
    }
    const headerToken = request.headers?.['x-mcp-token'];
    if (typeof headerToken === 'string' && headerToken.trim()) {
      return headerToken.trim();
    }
    return '';
  }

  /**
   * MCP HTTP 端点的鉴权：复用 Web 登录密码、登录失败限流与改密后的自动失效。
   * 返回 { ok } 或 { ok:false, status, message }，由调用方决定 HTTP 状态码。
   */
  function verifyMcpToken(request) {
    if (isLoginBlocked(request)) {
      return { ok: false, status: 429, message: 'Too many failed authentication attempts' };
    }
    const token = extractMcpToken(request);
    if (!token) {
      recordLoginFailure(request);
      return { ok: false, status: 401, message: 'Unauthorized' };
    }
    const digest = digestToken(token);
    if (mcpTokenCache.get(digest) === current.hash) {
      return { ok: true };
    }
    if (!verifyPassword(token, current.salt, current.hash)) {
      recordLoginFailure(request);
      return { ok: false, status: 401, message: 'Unauthorized' };
    }
    clearLoginFailures(request);
    if (mcpTokenCache.size >= MCP_TOKEN_CACHE_LIMIT) {
      mcpTokenCache.clear();
    }
    mcpTokenCache.set(digest, current.hash);
    return { ok: true };
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
    if (isLoginBlocked(request)) {
      response.status(429);
      response.setHeader?.('Retry-After', '60');
      response.json({ success: false, error: 'Too many failed login attempts', code: 'LOGIN_RATE_LIMITED' });
      return;
    }
    const submitted = (request.body && request.body.password) || '';
    if (!verifyPassword(submitted, current.salt, current.hash)) {
      recordLoginFailure(request);
      response.status(401).json({ success: false, error: 'Invalid password' });
      return;
    }
    clearLoginFailures(request);
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
    const next = { salt, hash, isDefault: newPassword === DEFAULT_PASSWORD };
    // 先持久化：只有成功写盘才提交内存状态、刷新会话并撤销旧会话。
    // 写盘失败时若仍返回成功，用户会误以为旧密码已失效（重启后旧密码仍可登录）。
    if (!writeCredentialFile(credential.credentialPath, next)) {
      response.status(500).json({
        success: false,
        error: 'Failed to persist new password',
        code: 'CREDENTIAL_WRITE_FAILED',
      });
      return;
    }
    current = next;
    // 改密后令牌缓存里的哈希已失配，直接清空，避免残留条目占内存。
    mcpTokenCache.clear();
    // 刷新会话值：旧的其它会话失效，随即为当前请求重设 Cookie 以保持登录。
    sessionValue = deriveSessionValue(current.hash);
    setSessionCookie(request, response);
    // 撤销改密前建立的所有 WebSocket 授权并关闭连接（旧 socket 不会因 Cookie 变化而失效）。
    if (onPasswordChanged) {
      try {
        onPasswordChanged();
      } catch {
        // 撤销失败不应回滚已成功的改密，但也不能让异常冒泡成 500。
      }
    }
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
    verifyMcpToken,
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
