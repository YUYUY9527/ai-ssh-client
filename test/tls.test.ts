import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {
  buildSubjectAltName,
  defaultCertificateHosts,
  ensureSelfSignedCertificate,
  isEnabled,
  resolveTlsOptions,
} from '../server/tls.cjs';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ssh-tls-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 自签名证书生成依赖 openssl；缺失时（例如未装 openssl 的 Windows 开发机）跳过该组用例。
const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('tls', () => {
  it('parses boolean environment flags', () => {
    expect(isEnabled('1')).toBe(true);
    expect(isEnabled('true')).toBe(true);
    expect(isEnabled('YES')).toBe(true);
    expect(isEnabled('on')).toBe(true);
    expect(isEnabled('')).toBe(false);
    expect(isEnabled('0')).toBe(false);
    expect(isEnabled(undefined)).toBe(false);
  });

  it('builds subjectAltName entries for IPs and host names', () => {
    expect(buildSubjectAltName(['192.168.4.213', 'localhost']))
      .toBe('IP:192.168.4.213,DNS:localhost');
  });

  it('always includes loopback and keeps extra hosts', () => {
    const hosts = defaultCertificateHosts(['ssh.example.com']);
    expect(hosts).toContain('localhost');
    expect(hosts).toContain('127.0.0.1');
    expect(hosts).toContain('ssh.example.com');
  });

  it('stays on HTTP when TLS is not requested', () => {
    expect(resolveTlsOptions({})).toBeNull();
    expect(resolveTlsOptions({ WEB_TLS: '0', WEB_TLS_CERT: '', WEB_TLS_KEY: '  ' })).toBeNull();
  });

  it('rejects a half-configured certificate pair', () => {
    expect(() => resolveTlsOptions({ WEB_TLS_CERT: '/tmp/cert.pem' }))
      .toThrow(/must be provided together/);
    expect(() => resolveTlsOptions({ WEB_TLS_KEY: '/tmp/key.pem' }))
      .toThrow(/must be provided together/);
  });

  it('loads explicitly provided PEM files', () => {
    const dir = makeTempDir();
    const certPath = path.join(dir, 'cert.pem');
    const keyPath = path.join(dir, 'key.pem');
    fs.writeFileSync(certPath, 'CERT-PEM');
    fs.writeFileSync(keyPath, 'KEY-PEM');

    const options = resolveTlsOptions({ WEB_TLS_CERT: certPath, WEB_TLS_KEY: keyPath });
    expect(options?.cert.toString()).toBe('CERT-PEM');
    expect(options?.key.toString()).toBe('KEY-PEM');
  });

  it.skipIf(!hasOpenssl)('generates and reuses a self-signed certificate', async () => {
    const dir = path.join(makeTempDir(), 'tls');
    const hosts = ['localhost', '127.0.0.1'];

    const generated = ensureSelfSignedCertificate({ dir, hosts, log: () => {} });
    expect(generated.created).toBe(true);
    expect(fs.existsSync(generated.certPath)).toBe(true);

    const cert = new X509Certificate(fs.readFileSync(generated.certPath));
    expect(cert.subjectAltName).toContain('DNS:localhost');
    expect(cert.subjectAltName).toContain('127.0.0.1');
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now());
    expect(cert.checkHost('localhost')).toBeTruthy();

    // 第二次调用复用已有文件，避免每次启动都轮换证书（否则浏览器信任例外反复失效）。
    expect(ensureSelfSignedCertificate({ dir, hosts, log: () => {} }).created).toBe(false);

    // WEB_TLS=1 时应自动落到自签名证书。
    const options = resolveTlsOptions({ WEB_TLS: '1' }, { tlsDir: dir, hosts, log: () => {} });
    expect(options?.cert.toString()).toContain('BEGIN CERTIFICATE');
    if (!options) throw new Error('expected TLS options');

    // 端到端校验：Node 的 TLS 栈能用该证书完成握手（等价于浏览器接受证书本身）。
    const server = https.createServer(options, (_request, response) => {
      response.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const body = await new Promise<string>((resolve, reject) => {
        https.get({
          host: '127.0.0.1',
          port,
          servername: 'localhost',
          ca: options.cert,
          headers: { Host: 'localhost' },
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(chunk as Buffer));
          response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        }).on('error', reject);
      });
      expect(body).toBe('ok');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
