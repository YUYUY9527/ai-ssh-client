const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const totp = require('./totp.cjs');

// 会话 Cookie 名称，登录成功后写入，浏览器同源请求会自动携带。
const COOKIE_NAME = 'ai_ssh_web_session';
// 会话有效期（7 天），到期后需重新登录。
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// 首次启动时使用的默认密码，建议登录后立即修改。
const DEFAULT_PASSWORD = 'admin';
// 存放密码哈希的文件名（位于 data 目录）。
const CREDENTIAL_FILE = 'web-auth.json';
// 可选多用户与 RBAC 存储文件（位于 data 目录）。
const USERS_FILE = 'web-users.json';
const VALID_ROLES = new Set(['admin', 'operator', 'viewer']);
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
    return {
      salt: parsed.salt,
      hash: parsed.hash,
      isDefault: parsed.isDefault === true,
      totpSecret: typeof parsed.totpSecret === 'string' ? parsed.totpSecret : undefined,
      totpEnabled: parsed.totpEnabled === true,
    };
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
    ...(credential.totpSecret ? { totpSecret: credential.totpSecret } : {}),
    ...(credential.totpEnabled ? { totpEnabled: true } : {}),
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
    totpSecret: credential.totpSecret,
    totpEnabled: credential.totpEnabled === true,
  };
  let pendingTotpSecret = null;
  const usersPath = path.join(String(dataDir || '.'), USERS_FILE);

  function loadUsers() {
    try {
      if (!fs.existsSync(usersPath)) return [];
      const raw = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  function saveUsers(list) {
    fs.mkdirSync(path.dirname(usersPath), { recursive: true });
    const tmp = `${usersPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, usersPath);
  }

  function summarizeUser(user) {
    return {
      id: user.id,
      username: user.username,
      role: VALID_ROLES.has(user.role) ? user.role : 'operator',
      allowedConnectionIds: Array.isArray(user.allowedConnectionIds) ? user.allowedConnectionIds : [],
      totpEnabled: user.totpEnabled === true,
      createdAt: Number(user.createdAt) || Date.now(),
    };
  }

  function signUserToken(user) {
    const payload = Buffer.from(JSON.stringify({
      uid: user.id,
      u: user.username,
      r: user.role,
      h: String(user.hash || '').slice(0, 12),
    })).toString('base64url');
    const sig = crypto.createHmac('sha256', current.hash).update(`u1.${payload}`).digest('base64url');
    return `u1.${payload}.${sig}`;
  }

  function verifyUserToken(token) {
    if (typeof token !== 'string' || !token.startsWith('u1.')) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [, payload, sig] = parts;
    const expected = crypto.createHmac('sha256', current.hash).update(`u1.${payload}`).digest('base64url');
    if (!safeEqual(sig, expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      const user = loadUsers().find((item) => item.id === data.uid);
      if (!user) return null;
      if (String(user.hash || '').slice(0, 12) !== data.h) return null;
      return summarizeUser(user);
    } catch {
      return null;
    }
  }

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

  /** 返回当前请求对应的已认证用户（未登录返回 null）。 */
  function getSessionUser(request) {
    const cookies = parseCookies(request.headers?.cookie);
    const provided = cookies[COOKIE_NAME];
    if (!provided) return null;
    if (safeEqual(provided, sessionValue)) {
      return {
        id: 'root',
        username: 'admin',
        role: 'admin',
        allowedConnectionIds: [],
        totpEnabled: current.totpEnabled === true,
      };
    }
    return verifyUserToken(provided);
  }

  // 判断请求是否已通过鉴权。
  function isAuthed(request) {
    return getSessionUser(request) !== null;
  }

  function canAccessConnection(request, connectionId) {
    const user = getSessionUser(request);
    if (!user) return false;
    if (user.role === 'admin' || !Array.isArray(user.allowedConnectionIds) || user.allowedConnectionIds.length === 0) {
      return true;
    }
    return user.allowedConnectionIds.includes(String(connectionId));
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
  function setSessionCookie(request, response, customValue) {
    const secure = request.secure || request.headers['x-forwarded-proto'] === 'https';
    response.cookie(COOKIE_NAME, customValue || sessionValue, {
      httpOnly: true,
      sameSite: 'strict',
      secure,
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
  }

  // Express 中间件：放行登录相关端点和静态资源，其余需鉴权。
  function middleware(request, response, next) {
    const user = getSessionUser(request);
    if (user) {
      request.authUser = user;
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
    response.status(401).type('html').send(loginPage(request.__loginLang, {
      multiUser: loadUsers().length > 0,
      totpEnabled: current.totpEnabled === true,
    }));
  }

  // 处理登录：校验密码（支持多用户与 TOTP 2FA），通过后写入 HttpOnly 会话 Cookie。
  function handleLogin(request, response) {
    if (isLoginBlocked(request)) {
      response.status(429);
      response.setHeader?.('Retry-After', '60');
      response.json({ success: false, error: 'Too many failed login attempts', code: 'LOGIN_RATE_LIMITED' });
      return;
    }
    const username = String(request.body?.username || '').trim();
    const submitted = (request.body && request.body.password) || '';
    const totpCode = String(request.body?.totpCode || '').trim();

    // 若指定了非 admin 用户名，走多用户库校验
    if (username && username.toLowerCase() !== 'admin') {
      const targetUser = loadUsers().find((u) => u.username.toLowerCase() === username.toLowerCase());
      if (!targetUser || !verifyPassword(submitted, targetUser.salt, targetUser.hash)) {
        recordLoginFailure(request);
        response.status(401).json({ success: false, error: 'Invalid credentials' });
        return;
      }
      if (targetUser.totpEnabled && targetUser.totpSecret) {
        if (!totpCode) {
          response.status(401).json({ success: false, error: 'TOTP code required', code: 'TOTP_REQUIRED' });
          return;
        }
        if (!totp.verifyTotpCode(targetUser.totpSecret, totpCode)) {
          recordLoginFailure(request);
          response.status(401).json({ success: false, error: 'Invalid TOTP code', code: 'INVALID_TOTP' });
          return;
        }
      }
      clearLoginFailures(request);
      setSessionCookie(request, response, signUserToken(targetUser));
      response.json({ success: true, user: summarizeUser(targetUser) });
      return;
    }

    if (!verifyPassword(submitted, current.salt, current.hash)) {
      recordLoginFailure(request);
      response.status(401).json({ success: false, error: 'Invalid password' });
      return;
    }
    if (current.totpEnabled && current.totpSecret) {
      if (!totpCode) {
        response.status(401).json({ success: false, error: 'TOTP code required', code: 'TOTP_REQUIRED' });
        return;
      }
      if (!totp.verifyTotpCode(current.totpSecret, totpCode)) {
        recordLoginFailure(request);
        response.status(401).json({ success: false, error: 'Invalid TOTP code', code: 'INVALID_TOTP' });
        return;
      }
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

  function setupTotp() {
    pendingTotpSecret = totp.generateTotpSecret();
    return {
      secret: pendingTotpSecret,
      otpauthUri: totp.buildOtpAuthUri({ secret: pendingTotpSecret, account: 'admin' }),
    };
  }

  function enableTotp(code) {
    if (!pendingTotpSecret) throw new Error('Please initiate TOTP setup first');
    if (!totp.verifyTotpCode(pendingTotpSecret, code)) {
      throw new Error('Invalid verification code');
    }
    const next = { ...current, totpSecret: pendingTotpSecret, totpEnabled: true };
    if (!isEnvManaged) {
      writeCredentialFile(credential.credentialPath, next);
    }
    current = next;
    pendingTotpSecret = null;
    return { totpEnabled: true };
  }

  function disableTotp(code) {
    if (current.totpEnabled && current.totpSecret && !totp.verifyTotpCode(current.totpSecret, code)) {
      throw new Error('Invalid verification code');
    }
    const next = { ...current, totpSecret: undefined, totpEnabled: false };
    if (!isEnvManaged) {
      writeCredentialFile(credential.credentialPath, next);
    }
    current = next;
    return { totpEnabled: false };
  }

  function listUsers() {
    return loadUsers().map(summarizeUser);
  }

  function saveUser(input) {
    const username = String(input?.username || '').trim();
    if (!username || username.length < 2 || username.toLowerCase() === 'admin') {
      throw new Error('Invalid username (min 2 chars, cannot be "admin")');
    }
    const role = VALID_ROLES.has(input?.role) ? input.role : 'operator';
    const allowedConnectionIds = Array.isArray(input?.allowedConnectionIds)
      ? input.allowedConnectionIds.map((id) => String(id).trim()).filter(Boolean)
      : [];
    const users = loadUsers();
    const existing = input?.id
      ? users.find((item) => item.id === input.id)
      : users.find((item) => item.username.toLowerCase() === username.toLowerCase());
    let salt = existing?.salt;
    let hash = existing?.hash;
    if (typeof input?.password === 'string' && input.password.length > 0) {
      if (input.password.length < 4) throw new Error('Password must be at least 4 characters');
      const hashed = hashPassword(input.password);
      salt = hashed.salt;
      hash = hashed.hash;
    }
    if (!salt || !hash) throw new Error('Password is required for new user');
    const record = {
      id: existing?.id || `usr-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      username,
      salt,
      hash,
      role,
      allowedConnectionIds,
      totpSecret: existing?.totpSecret,
      totpEnabled: existing?.totpEnabled === true,
      createdAt: existing?.createdAt || Date.now(),
    };
    const nextList = [...users.filter((item) => item.id !== record.id), record];
    saveUsers(nextList);
    return summarizeUser(record);
  }

  function deleteUser(userId) {
    const users = loadUsers();
    const next = users.filter((item) => item.id !== userId);
    if (next.length === users.length) return false;
    saveUsers(next);
    return true;
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
    getSessionUser,
    canAccessConnection,
    verifyMcpToken,
    isUsingDefaultPassword,
    isTotpEnabled: () => current.totpEnabled === true,
    setupTotp,
    enableTotp,
    disableTotp,
    listUsers,
    saveUser,
    deleteUser,
  };
}

/**
 * 内联登录页 HTML，避免依赖已构建的 SPA 资源。
 * lang 由服务端根据 settings.language 注入，浏览器语言作兜底。
 */
function loginPage(lang, pageOptions = {}) {
  const initialLang = lang === 'en-US' ? 'en-US' : lang === 'zh-CN' ? 'zh-CN' : '';
  const strings = {
    'zh-CN': {
      title: 'AI SSH Client',
      subtitle: '安全、现代的浏览器 SSH 工作台',
      hint: '请输入访问密码以解锁控制台',
      label: '访问密码',
      placeholder: '输入密码...',
      button: '登录工作台',
      signingIn: '验证中...',
      showPw: '显示密码',
      hidePw: '隐藏密码',
      invalid: '密码错误，请重新输入。',
      network: '网络连接异常，请重试。',
      badge: 'AES-GCM 加密 · 本地会话保护',
    },
    'en-US': {
      title: 'AI SSH Client',
      subtitle: 'Secure browser-native SSH workbench',
      hint: 'Enter your access password to unlock the workspace',
      label: 'Access Password',
      placeholder: 'Enter password...',
      button: 'Sign in',
      signingIn: 'Signing in...',
      showPw: 'Show password',
      hidePw: 'Hide password',
      invalid: 'Invalid password. Please try again.',
      network: 'Network error. Please retry.',
      badge: 'AES-GCM Encrypted · Protected Session',
    },
  };
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<title>AI SSH Client — Sign in</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #070b10;
    --surface: rgba(13, 19, 26, 0.84);
    --surface-input: rgba(7, 11, 16, 0.78);
    --border: rgba(45, 65, 82, 0.62);
    --border-accent: rgba(20, 184, 166, 0.45);
    --text: #f1f5f9;
    --text-secondary: #94a3b8;
    --text-muted: #64748b;
    --accent: #14b8a6;
    --accent-hover: #2dd4bf;
    --accent-deep: #0d8a7f;
    --danger: #f87171;
    --danger-bg: rgba(239, 68, 68, 0.12);
    --danger-border: rgba(239, 68, 68, 0.35);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    font-family: Inter, Geist, 'IBM Plex Sans', 'PingFang SC', 'Microsoft YaHei', system-ui, -apple-system, sans-serif;
    background-color: var(--bg);
    background-image:
      radial-gradient(960px 460px at 18% -8%, rgba(20, 184, 166, 0.16), transparent 62%),
      radial-gradient(780px 420px at 86% 108%, rgba(249, 115, 22, 0.09), transparent 58%),
      radial-gradient(rgba(148, 163, 184, 0.11) 1px, transparent 1px);
    background-size: auto, auto, 28px 28px;
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
  }
  .card {
    position: relative;
    width: 100%;
    max-width: 396px;
    padding: 36px 32px 28px;
    background:
      linear-gradient(155deg, rgba(20, 184, 166, 0.09), transparent 44%),
      var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow:
      0 32px 84px rgba(0, 0, 0, 0.56),
      0 0 0 1px rgba(20, 184, 166, 0.08),
      inset 0 1px 0 rgba(255, 255, 255, 0.08);
    backdrop-filter: blur(22px) saturate(140%);
    -webkit-backdrop-filter: blur(22px) saturate(140%);
    animation: card-in 320ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .card.shake {
    animation: card-shake 360ms cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 22px;
  }
  .brand-mark {
    width: 46px;
    height: 46px;
    flex-shrink: 0;
    border-radius: 12px;
    padding: 3px;
    background: linear-gradient(145deg, rgba(45, 212, 191, 0.24), rgba(15, 118, 110, 0.08));
    border: 1px solid rgba(45, 212, 191, 0.36);
    box-shadow: 0 8px 24px rgba(20, 184, 166, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.14);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .brand-mark svg { width: 100%; height: 100%; display: block; }
  .brand-text { min-width: 0; }
  h1 {
    font-size: 19px;
    font-weight: 650;
    letter-spacing: -0.02em;
    margin: 0;
    line-height: 1.25;
  }
  .subtitle {
    font-size: 12px;
    color: var(--text-secondary);
    margin: 3px 0 0;
    line-height: 1.4;
  }
  .hint {
    font-size: 13px;
    color: var(--text-secondary);
    margin: 0 0 20px;
    line-height: 1.5;
  }
  label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    margin-bottom: 8px;
    letter-spacing: 0.01em;
  }
  .input-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }
  .input-icon {
    position: absolute;
    left: 12px;
    width: 16px;
    height: 16px;
    color: var(--text-muted);
    pointer-events: none;
    transition: color 180ms ease;
  }
  input {
    width: 100%;
    height: 44px;
    padding: 0 42px 0 38px;
    font-size: 14px;
    font-family: inherit;
    background: var(--surface-input);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.28);
    transition: border-color 180ms ease, box-shadow 180ms ease, background-color 180ms ease;
  }
  input::placeholder { color: var(--text-muted); }
  input:hover { border-color: rgba(100, 116, 139, 0.72); }
  input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(20, 184, 166, 0.18), inset 0 1px 2px rgba(0, 0, 0, 0.25);
  }
  .input-wrap:focus-within .input-icon { color: var(--accent-hover); }
  .toggle-pw {
    position: absolute;
    right: 6px;
    width: 32px;
    height: 32px;
    padding: 0;
    margin: 0;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: color 160ms ease, background-color 160ms ease;
  }
  .toggle-pw:hover { color: var(--text); background: rgba(148, 163, 184, 0.12); }
  .toggle-pw svg { width: 16px; height: 16px; }
  .submit-btn {
    width: 100%;
    height: 44px;
    margin-top: 18px;
    padding: 0 16px;
    font-size: 14px;
    font-weight: 600;
    font-family: inherit;
    letter-spacing: 0.01em;
    color: #ffffff;
    background: linear-gradient(180deg, #18c4b0 0%, #0d8a7f 100%);
    border: 1px solid rgba(45, 212, 191, 0.55);
    border-radius: 10px;
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.22) inset,
      0 12px 28px rgba(20, 184, 166, 0.26);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    transition: transform 160ms cubic-bezier(0.16, 1, 0.3, 1), filter 160ms ease, box-shadow 160ms ease;
  }
  .submit-btn:hover:not(:disabled) {
    filter: brightness(1.07);
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.26) inset,
      0 14px 32px rgba(20, 184, 166, 0.34);
    transform: translateY(-1px);
  }
  .submit-btn:active:not(:disabled) { transform: translateY(0); filter: brightness(0.98); }
  .submit-btn:disabled { opacity: 0.65; cursor: not-allowed; }
  .error {
    margin-top: 14px;
    font-size: 12px;
    color: var(--danger);
    min-height: 18px;
    line-height: 1.45;
  }
  .error.visible {
    padding: 9px 12px;
    border-radius: 8px;
    background: var(--danger-bg);
    border: 1px solid var(--danger-border);
  }
  .footer-badge {
    margin-top: 18px;
    padding-top: 16px;
    border-top: 1px solid rgba(45, 65, 82, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    font-size: 11px;
    color: var(--text-muted);
  }
  .badge-dot {
    width: 6px;
    height: 6px;
    border-radius: 9999px;
    background: var(--accent);
    box-shadow: 0 0 8px rgba(20, 184, 166, 0.75);
  }
  @keyframes card-in {
    from { opacity: 0; transform: translateY(10px) scale(0.98); }
    to { opacity: 1; transform: none; }
  }
  @keyframes card-shake {
    10%, 90% { transform: translateX(-2px); }
    20%, 80% { transform: translateX(4px); }
    30%, 50%, 70% { transform: translateX(-5px); }
    40%, 60% { transform: translateX(5px); }
  }
  @media (prefers-reduced-motion: reduce) {
    .card, .card.shake { animation: none; }
    .submit-btn:hover:not(:disabled) { transform: none; }
  }
</style>
</head>
<body>
  <form class="card" id="login-form">
    <div class="brand">
      <div class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 256 256">
          <defs>
            <linearGradient id="g-base" x1="42" y1="18" x2="214" y2="238" gradientUnits="userSpaceOnUse">
              <stop offset="0" stop-color="#12343a" />
              <stop offset="0.5" stop-color="#081016" />
              <stop offset="1" stop-color="#020609" />
            </linearGradient>
            <linearGradient id="g-edge" x1="42" y1="24" x2="214" y2="232" gradientUnits="userSpaceOnUse">
              <stop offset="0" stop-color="#2dd4bf" />
              <stop offset="0.58" stop-color="#14b8a6" />
              <stop offset="1" stop-color="#f97316" />
            </linearGradient>
            <linearGradient id="g-bolt" x1="96" y1="58" x2="168" y2="190" gradientUnits="userSpaceOnUse">
              <stop offset="0" stop-color="#a7f3d0" />
              <stop offset="0.42" stop-color="#2dd4bf" />
              <stop offset="1" stop-color="#0f766e" />
            </linearGradient>
          </defs>
          <rect x="18" y="18" width="220" height="220" rx="44" fill="url(#g-base)" />
          <rect x="24" y="24" width="208" height="208" rx="38" fill="none" stroke="url(#g-edge)" stroke-width="8" />
          <path d="M61 78h69l23 50-23 50H61l26-50-26-50Z" fill="#0b1419" stroke="#2dd4bf" stroke-width="10" stroke-linejoin="round" />
          <path d="M91 76l-25 52 25 52" fill="none" stroke="#f5f7f2" stroke-width="14" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M126 62l-21 66h39l-16 66 60-84h-42l20-48h-40Z" fill="url(#g-bolt)" stroke="#ccfbf1" stroke-width="5" stroke-linejoin="round" />
          <path d="M66 202h94" stroke="#f97316" stroke-width="12" stroke-linecap="round" />
        </svg>
      </div>
      <div class="brand-text">
        <h1 id="title"></h1>
        <div class="subtitle" id="subtitle"></div>
      </div>
    </div>
    <p class="hint" id="hint"></p>
    <div id="username-wrap" style="display:${pageOptions.multiUser ? 'block' : 'none'};margin-bottom:12px;">
      <label for="username" id="username-label">Username</label>
      <div class="input-wrap" style="margin-bottom:0;">
        <input id="username" name="username" type="text" autocomplete="username" placeholder="admin" style="padding-left:14px;" />
      </div>
    </div>
    <label for="password" id="label"></label>
    <div class="input-wrap">
      <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
      </svg>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus />
      <button type="button" class="toggle-pw" id="toggle-pw" aria-label="Toggle password visibility">
        <svg id="eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
      </button>
    </div>
    <div id="totp-wrap" style="display:${pageOptions.totpEnabled ? 'block' : 'none'};margin-bottom:14px;">
      <label for="totp" id="totp-label">2FA Code (TOTP)</label>
      <div class="input-wrap" style="margin-bottom:0;">
        <input id="totp" name="totp" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="000000" maxlength="6" style="padding-left:14px;letter-spacing:0.2em;" />
      </div>
    </div>
    <button type="submit" class="submit-btn" id="submit"></button>
    <div class="error" id="error" role="alert"></div>
    <div class="footer-badge">
      <span class="badge-dot" aria-hidden="true"></span>
      <span id="badge"></span>
    </div>
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
  document.getElementById('subtitle').textContent = s.subtitle;
  document.getElementById('hint').textContent = s.hint;
  document.getElementById('label').textContent = s.label;
  document.getElementById('badge').textContent = s.badge;
  var pwInput = document.getElementById('password');
  pwInput.placeholder = s.placeholder;
  var submitBtn = document.getElementById('submit');
  submitBtn.textContent = s.button;
  var toggleBtn = document.getElementById('toggle-pw');
  toggleBtn.title = s.showPw;
  toggleBtn.setAttribute('aria-label', s.showPw);
  toggleBtn.addEventListener('click', function () {
    var hidden = pwInput.type === 'password';
    pwInput.type = hidden ? 'text' : 'password';
    toggleBtn.title = hidden ? s.hidePw : s.showPw;
    toggleBtn.setAttribute('aria-label', hidden ? s.hidePw : s.showPw);
    pwInput.focus();
  });

  var form = document.getElementById('login-form');
  var errorEl = document.getElementById('error');
  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.add('visible');
    form.classList.remove('shake');
    void form.offsetWidth;
    form.classList.add('shake');
  }
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    errorEl.textContent = '';
    errorEl.classList.remove('visible');
    submitBtn.disabled = true;
    submitBtn.textContent = s.signingIn;
    var password = pwInput.value;
    var usernameInput = document.getElementById('username');
    var totpInput = document.getElementById('totp');
    var username = usernameInput ? usernameInput.value.trim() : '';
    var totpCode = totpInput ? totpInput.value.trim() : '';
    try {
      var response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password, username: username || undefined, totpCode: totpCode || undefined }),
      });
      if (response.ok) {
        window.location.reload();
        return;
      } else {
        var errJson = {};
        try { errJson = await response.json(); } catch (ignore) {}
        if (errJson && errJson.code === 'TOTP_REQUIRED') {
          var tw = document.getElementById('totp-wrap');
          if (tw) tw.style.display = 'block';
          if (totpInput) totpInput.focus();
          showError(lang === 'zh-CN' ? '请输入 6 位双因素验证码（TOTP）' : 'Please enter 6-digit 2FA code');
        } else if (errJson && errJson.code === 'INVALID_TOTP') {
          showError(lang === 'zh-CN' ? '双因素验证码错误' : 'Invalid 2FA code');
        } else {
          showError(s.invalid);
        }
      }
    } catch (e) {
      showError(s.network);
    }
    submitBtn.disabled = false;
    submitBtn.textContent = s.button;
  });
</script>
</body>
</html>`;
}

module.exports = { createAuth, COOKIE_NAME, DEFAULT_PASSWORD };
