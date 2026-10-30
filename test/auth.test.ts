import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// server/auth.cjs 是真实源模块，直接以 CommonJS 方式加载。
const { createAuth, COOKIE_NAME, DEFAULT_PASSWORD } = require(path.join(ROOT, 'server', 'auth.cjs')) as {
  createAuth: (dataDir: string, options?: { onPasswordChanged?: () => void }) => AuthApi;
  COOKIE_NAME: string;
  DEFAULT_PASSWORD: string;
};

interface AuthApi {
  source: string;
  isEnvManaged: boolean;
  middleware: (req: FakeReq, res: FakeRes, next: () => void) => void;
  handleLogin: (req: FakeReq, res: FakeRes) => void;
  handleLogout: (req: FakeReq, res: FakeRes) => void;
  changePassword: (req: FakeReq, res: FakeRes) => void;
  verifyUpgrade: (req: FakeReq) => boolean;
  isAuthed: (req: FakeReq) => boolean;
  isUsingDefaultPassword: () => boolean;
}

interface FakeReq {
  path: string;
  headers: Record<string, string | undefined>;
  body?: Record<string, unknown>;
  secure?: boolean;
  ip?: string;
}

// 最小化的 Express Response 桩，记录状态码、JSON、Cookie 等副作用。
class FakeRes {
  statusCode = 200;
  jsonBody: unknown = undefined;
  cookies: Record<string, { value: string }> = {};
  cleared: string[] = [];
  sentHtml: string | null = null;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  setHeader(_name: string, _value: string): this {
    return this;
  }
  json(body: unknown): this {
    this.jsonBody = body;
    return this;
  }
  cookie(name: string, value: string): this {
    this.cookies[name] = { value };
    return this;
  }
  clearCookie(name: string): this {
    this.cleared.push(name);
    return this;
  }
  type(): this {
    return this;
  }
  send(html: string): this {
    this.sentHtml = html;
    return this;
  }
}

function reqWithCookie(sessionValue: string | null, overrides: Partial<FakeReq> = {}): FakeReq {
  return {
    path: '/api/connections',
    headers: sessionValue ? { cookie: `${COOKIE_NAME}=${sessionValue}` } : {},
    ...overrides,
  };
}

function loginAndGetCookie(auth: AuthApi, password: string): string {
  const res = new FakeRes();
  auth.handleLogin({ path: '/api/login', headers: {}, body: { password } }, res);
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies[COOKIE_NAME];
  expect(cookie, 'login should set session cookie').toBeTruthy();
  return cookie.value;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aissh-auth-'));
  delete process.env.WEB_AUTH_PASSWORD;
});

afterEach(() => {
  delete process.env.WEB_AUTH_PASSWORD;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('web auth — default password bootstrap', () => {
  it('initializes with the default password and persists a credential file', () => {
    const auth = createAuth(tmpDir);
    expect(auth.source).toBe('generated');
    expect(auth.isUsingDefaultPassword()).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'web-auth.json'))).toBe(true);
    // 默认密码不应以明文形式落盘。
    const raw = fs.readFileSync(path.join(tmpDir, 'web-auth.json'), 'utf8');
    expect(raw).not.toContain(DEFAULT_PASSWORD);
    expect(JSON.parse(raw)).toMatchObject({ isDefault: true });
  });

  it('accepts the default password on login and rejects a wrong one', () => {
    const auth = createAuth(tmpDir);
    const okRes = new FakeRes();
    auth.handleLogin({ path: '/api/login', headers: {}, body: { password: DEFAULT_PASSWORD } }, okRes);
    expect(okRes.statusCode).toBe(200);
    expect(okRes.cookies[COOKIE_NAME]).toBeTruthy();

    const badRes = new FakeRes();
    auth.handleLogin({ path: '/api/login', headers: {}, body: { password: 'nope' } }, badRes);
    expect(badRes.statusCode).toBe(401);
    expect(badRes.cookies[COOKIE_NAME]).toBeUndefined();
  });

  it('does not throw on malformed cookies and rate-limits repeated failures', () => {
    const auth = createAuth(tmpDir);
    expect(() => auth.isAuthed({ path: '/api/x', headers: { cookie: `${COOKIE_NAME}=%ZZ` } })).not.toThrow();

    for (let index = 0; index < 10; index += 1) {
      const res = new FakeRes();
      auth.handleLogin({ path: '/api/login', headers: { 'x-forwarded-for': '192.0.2.10' }, body: { password: 'wrong' } }, res);
      expect(res.statusCode).toBe(401);
    }
    const blocked = new FakeRes();
    auth.handleLogin({ path: '/api/login', headers: { 'x-forwarded-for': '192.0.2.10' }, body: { password: DEFAULT_PASSWORD } }, blocked);
    expect(blocked.statusCode).toBe(429);
  });
});

describe('web auth — middleware gating', () => {
  it('blocks API requests without a valid session and allows login endpoints', () => {
    const auth = createAuth(tmpDir);

    const blocked = new FakeRes();
    let nextCalled = false;
    auth.middleware(reqWithCookie(null), blocked, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(blocked.statusCode).toBe(401);
    expect(blocked.jsonBody).toMatchObject({ code: 'UNAUTHORIZED' });

    const loginPass = new FakeRes();
    let loginNext = false;
    auth.middleware({ path: '/api/login', headers: {} }, loginPass, () => { loginNext = true; });
    expect(loginNext).toBe(true);

    const statusPass = new FakeRes();
    let statusNext = false;
    auth.middleware({ path: '/api/auth-status', headers: {} }, statusPass, () => { statusNext = true; });
    expect(statusNext).toBe(true);
  });

  it('serves the login page for unauthenticated non-API requests', () => {
    const auth = createAuth(tmpDir);
    const res = new FakeRes();
    auth.middleware({ path: '/', headers: {} }, res, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.sentHtml).toContain('login-form');
  });

  it('lets a valid session cookie through', () => {
    const auth = createAuth(tmpDir);
    const cookie = loginAndGetCookie(auth, DEFAULT_PASSWORD);
    expect(auth.isAuthed(reqWithCookie(cookie))).toBe(true);
    expect(auth.verifyUpgrade(reqWithCookie(cookie))).toBe(true);

    let nextCalled = false;
    auth.middleware(reqWithCookie(cookie), new FakeRes(), () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });
});

describe('web auth — change password', () => {
  it('rejects a wrong current password', () => {
    const auth = createAuth(tmpDir);
    const res = new FakeRes();
    auth.changePassword(
      { path: '/api/change-password', headers: {}, body: { oldPassword: 'wrong', newPassword: 'brandnew' } },
      res,
    );
    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toMatchObject({ code: 'BAD_OLD_PASSWORD' });
  });

  it('rejects a too-short new password', () => {
    const auth = createAuth(tmpDir);
    const res = new FakeRes();
    auth.changePassword(
      { path: '/api/change-password', headers: {}, body: { oldPassword: DEFAULT_PASSWORD, newPassword: 'ab' } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toMatchObject({ code: 'WEAK_PASSWORD' });
  });

  it('changes the password, invalidates old sessions, and keeps the current one logged in', () => {
    const auth = createAuth(tmpDir);
    const oldCookie = loginAndGetCookie(auth, DEFAULT_PASSWORD);
    expect(auth.isAuthed(reqWithCookie(oldCookie))).toBe(true);

    const res = new FakeRes();
    auth.changePassword(
      {
        path: '/api/change-password',
        headers: { cookie: `${COOKIE_NAME}=${oldCookie}` },
        body: { oldPassword: DEFAULT_PASSWORD, newPassword: 's3cret-pw' },
      },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(auth.isUsingDefaultPassword()).toBe(false);

    // 旧会话值失效。
    expect(auth.isAuthed(reqWithCookie(oldCookie))).toBe(false);
    // 改密响应重设了新的会话 Cookie，仍然有效。
    const refreshed = res.cookies[COOKIE_NAME];
    expect(refreshed).toBeTruthy();
    expect(auth.isAuthed(reqWithCookie(refreshed.value))).toBe(true);

    // 新密码可登录，旧密码不可。
    const newLogin = new FakeRes();
    auth.handleLogin({ path: '/api/login', headers: {}, body: { password: 's3cret-pw' } }, newLogin);
    expect(newLogin.statusCode).toBe(200);
    const staleLogin = new FakeRes();
    auth.handleLogin({ path: '/api/login', headers: {}, body: { password: DEFAULT_PASSWORD } }, staleLogin);
    expect(staleLogin.statusCode).toBe(401);
  });

  it('persists the new credential across restarts', () => {
    const first = createAuth(tmpDir);
    const cookie = loginAndGetCookie(first, DEFAULT_PASSWORD);
    const res = new FakeRes();
    first.changePassword(
      {
        path: '/api/change-password',
        headers: { cookie: `${COOKIE_NAME}=${cookie}` },
        body: { oldPassword: DEFAULT_PASSWORD, newPassword: 'persist-me' },
      },
      res,
    );
    expect(res.statusCode).toBe(200);

    // 新进程重新加载凭据文件。
    const second = createAuth(tmpDir);
    expect(second.source).toBe('file');
    expect(second.isUsingDefaultPassword()).toBe(false);
    const login = new FakeRes();
    second.handleLogin({ path: '/api/login', headers: {}, body: { password: 'persist-me' } }, login);
    expect(login.statusCode).toBe(200);
  });
});

describe('web auth — rate limiting is not spoofable via X-Forwarded-For', () => {
  it('keys the failure bucket on the real connection address, ignoring the header', () => {
    const auth = createAuth(tmpDir);
    // 同一真实来源，轮换伪造的 X-Forwarded-For：仍应累计到同一桶并最终 429。
    for (let index = 0; index < 10; index += 1) {
      const res = new FakeRes();
      auth.handleLogin({
        path: '/api/login',
        ip: '203.0.113.5',
        headers: { 'x-forwarded-for': `10.0.0.${index}` },
        body: { password: 'wrong' },
      }, res);
      expect(res.statusCode).toBe(401);
    }
    const blocked = new FakeRes();
    auth.handleLogin({
      path: '/api/login',
      ip: '203.0.113.5',
      headers: { 'x-forwarded-for': '198.51.100.9' },
      body: { password: DEFAULT_PASSWORD },
    }, blocked);
    expect(blocked.statusCode).toBe(429);

    // 另一个真实地址即便伪造相同转发头也不受影响。
    const other = new FakeRes();
    auth.handleLogin({
      path: '/api/login',
      ip: '203.0.113.6',
      headers: { 'x-forwarded-for': '198.51.100.9' },
      body: { password: DEFAULT_PASSWORD },
    }, other);
    expect(other.statusCode).toBe(200);
  });
});

describe('web auth — password change revokes existing sessions', () => {
  it('invokes onPasswordChanged only after a successful change', () => {
    let revoked = 0;
    const auth = createAuth(tmpDir, { onPasswordChanged: () => { revoked += 1; } });
    const cookie = loginAndGetCookie(auth, DEFAULT_PASSWORD);

    const bad = new FakeRes();
    auth.changePassword(
      { path: '/api/change-password', headers: {}, body: { oldPassword: 'wrong', newPassword: 'brandnew' } },
      bad,
    );
    expect(bad.statusCode).toBe(401);
    expect(revoked).toBe(0);

    const ok = new FakeRes();
    auth.changePassword(
      {
        path: '/api/change-password',
        headers: { cookie: `${COOKIE_NAME}=${cookie}` },
        body: { oldPassword: DEFAULT_PASSWORD, newPassword: 'brandnew' },
      },
      ok,
    );
    expect(ok.statusCode).toBe(200);
    expect(revoked).toBe(1);
  });

  it('still returns success (not 500) if the revoke callback throws', () => {
    const auth = createAuth(tmpDir, { onPasswordChanged: () => { throw new Error('boom'); } });
    const cookie = loginAndGetCookie(auth, DEFAULT_PASSWORD);
    const res = new FakeRes();
    expect(() => auth.changePassword(
      {
        path: '/api/change-password',
        headers: { cookie: `${COOKIE_NAME}=${cookie}` },
        body: { oldPassword: DEFAULT_PASSWORD, newPassword: 'brandnew' },
      },
      res,
    )).not.toThrow();
    expect(res.statusCode).toBe(200);
  });
});

describe('web auth — env-managed password', () => {
  it('uses WEB_AUTH_PASSWORD without writing a credential file and blocks change', () => {
    process.env.WEB_AUTH_PASSWORD = 'from-env-pw';
    const auth = createAuth(tmpDir);
    expect(auth.source).toBe('env');
    expect(auth.isEnvManaged).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'web-auth.json'))).toBe(false);

    const login = new FakeRes();
    auth.handleLogin({ path: '/api/login', headers: {}, body: { password: 'from-env-pw' } }, login);
    expect(login.statusCode).toBe(200);

    const change = new FakeRes();
    auth.changePassword(
      { path: '/api/change-password', headers: {}, body: { oldPassword: 'from-env-pw', newPassword: 'whatever' } },
      change,
    );
    expect(change.statusCode).toBe(400);
    expect(change.jsonBody).toMatchObject({ code: 'ENV_MANAGED' });
  });
});

describe('web auth — corrupt credential file fails closed', () => {
  const credentialPath = () => path.join(tmpDir, 'web-auth.json');

  it('refuses to start when the credential file is corrupt and there is no backup', () => {
    const corrupt = '{"salt":"abc","hash":'; // 截断的 JSON
    fs.writeFileSync(credentialPath(), corrupt);
    expect(() => createAuth(tmpDir)).toThrow(/credential-corrupt|损坏|拒绝启动/);
    // 不得把损坏文件覆盖成默认凭据
    expect(fs.readFileSync(credentialPath(), 'utf8')).toBe(corrupt);
    // 也不应顺手写入备份
    expect(fs.existsSync(`${credentialPath()}.bak`)).toBe(false);
  });

  it('treats a structurally invalid file (missing salt/hash) as corrupt', () => {
    fs.writeFileSync(credentialPath(), JSON.stringify({ hello: 'world' }));
    expect(() => createAuth(tmpDir)).toThrow(/credential-corrupt|损坏|拒绝启动/);
  });

  it('recovers from a valid .bak when the primary is corrupt', () => {
    // 先生成一套有效的默认凭据文件，并把它同时作为备份。
    createAuth(tmpDir);
    const valid = fs.readFileSync(credentialPath(), 'utf8');
    fs.writeFileSync(`${credentialPath()}.bak`, valid);
    fs.writeFileSync(credentialPath(), 'not-json-at-all');

    const recovered = createAuth(tmpDir);
    expect(recovered.source).toBe('file');
    // 备份应被写回主文件
    expect(() => JSON.parse(fs.readFileSync(credentialPath(), 'utf8'))).not.toThrow();

    const login = new FakeRes();
    recovered.handleLogin({ path: '/api/login', headers: {}, body: { password: DEFAULT_PASSWORD } }, login);
    expect(login.statusCode).toBe(200);
  });

  it('still bootstraps the default password only when no credential file exists', () => {
    const auth = createAuth(tmpDir);
    expect(auth.source).toBe('generated');
    expect(auth.isUsingDefaultPassword()).toBe(true);
  });

  it('writes a .bak of the previous credential when the password changes', () => {
    const auth = createAuth(tmpDir);
    const cookie = loginAndGetCookie(auth, DEFAULT_PASSWORD);
    const res = new FakeRes();
    auth.changePassword(
      {
        path: '/api/change-password',
        headers: { cookie: `${COOKIE_NAME}=${cookie}` },
        body: { oldPassword: DEFAULT_PASSWORD, newPassword: 'new-pw-123' },
      },
      res,
    );
    expect(res.statusCode).toBe(200);
    const backup = JSON.parse(fs.readFileSync(`${credentialPath()}.bak`, 'utf8'));
    const primary = JSON.parse(fs.readFileSync(credentialPath(), 'utf8'));
    expect(backup.isDefault).toBe(true); // 备份是改密前的默认凭据
    expect(primary.isDefault).toBe(false); // 主文件已是新密码
  });
});

describe('web auth — password change persistence failure', () => {
  it('reports error and keeps the old password when writing the new credential fails', () => {
    const auth = createAuth(tmpDir);
    const cookie = loginAndGetCookie(auth, DEFAULT_PASSWORD);
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    try {
      const res = new FakeRes();
      auth.changePassword(
        {
          path: '/api/change-password',
          headers: { cookie: `${COOKIE_NAME}=${cookie}` },
          body: { oldPassword: DEFAULT_PASSWORD, newPassword: 'new-pw-123' },
        },
        res,
      );
      expect(res.statusCode).toBe(500);
      expect(res.jsonBody).toMatchObject({ code: 'CREDENTIAL_WRITE_FAILED' });
    } finally {
      renameSpy.mockRestore();
    }

    // 旧密码仍可登录（改密未提交），新密码不能登录
    const oldLogin = new FakeRes();
    auth.handleLogin({ path: '/api/login', headers: {}, body: { password: DEFAULT_PASSWORD } }, oldLogin);
    expect(oldLogin.statusCode).toBe(200);
    const newLogin = new FakeRes();
    auth.handleLogin({ path: '/api/login', headers: {}, body: { password: 'new-pw-123' } }, newLogin);
    expect(newLogin.statusCode).toBe(401);
  });

  it('succeeds and switches password once the disk write recovers', () => {
    const auth = createAuth(tmpDir);
    const cookie = loginAndGetCookie(auth, DEFAULT_PASSWORD);
    const res = new FakeRes();
    auth.changePassword(
      {
        path: '/api/change-password',
        headers: { cookie: `${COOKIE_NAME}=${cookie}` },
        body: { oldPassword: DEFAULT_PASSWORD, newPassword: 'new-pw-123' },
      },
      res,
    );
    expect(res.statusCode).toBe(200);
    const login = new FakeRes();
    auth.handleLogin({ path: '/api/login', headers: {}, body: { password: 'new-pw-123' } }, login);
    expect(login.statusCode).toBe(200);
  });
});
