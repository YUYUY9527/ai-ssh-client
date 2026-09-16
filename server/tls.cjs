const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * Web 网关的 TLS 支持。
 *
 * 背景：浏览器（Chrome ≥ 88 起逐步收紧）会把「非可信来源 + 非白名单扩展名」的下载
 * 判定为 insecure download 并直接拦截（控制台只留一条
 * "The file at 'http://...' was loaded over an insecure connection..." 提示，
 * 下载气泡里是"已阻止不安全的下载"）。SFTP 下载的 `.pcap/.zip/.conf` 等都不在
 * Chrome 的安全扩展名白名单内，因此在 `http://<局域网IP>:5080` 下点下载会静默失败。
 * 唯一可靠的解法是让页面与下载同源且走 HTTPS（https 属于 potentially trustworthy origin）。
 *
 * 配置方式：
 * - WEB_TLS_CERT / WEB_TLS_KEY：显式指定 PEM 证书与私钥路径（推荐生产使用）；
 * - WEB_TLS=1：未提供证书时，在 DATA_DIR/tls 下用 openssl 生成自签名证书（仅首次）；
 * - WEB_TLS_HOSTS：自签名证书 SAN 里附加的主机名/IP（逗号分隔，默认自动收集本机 IPv4）。
 *
 * 未启用 TLS 时返回 null，调用方继续以 HTTP 启动。
 */

/** 解析布尔型环境变量（1/true/yes/on 为真）。 */
function isEnabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

/** 解析逗号分隔列表并去空。 */
function splitList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 生成自签名证书的 SAN 条目：本机所有非回环 IPv4 + localhost。
 * 局域网部署常直接用 IP 访问，SAN 必须包含该 IP，否则浏览器报证书域名不匹配。
 */
function defaultCertificateHosts(extraHosts = []) {
  const hosts = new Set(['localhost', '127.0.0.1']);
  for (const item of extraHosts) {
    hosts.add(item);
  }
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) {
        hosts.add(address.address);
      }
    }
  }
  return [...hosts];
}

/** 将主机名列表转换为 openssl 的 subjectAltName 字符串。 */
function buildSubjectAltName(hosts) {
  return hosts
    .map((host) => (/^\d+\.\d+\.\d+\.\d+$/.test(host)
      ? `IP:${host}`
      : `DNS:${host}`))
    .join(',');
}

/** openssl 是否可用（自签名模式依赖它）。 */
function hasOpenssl() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 生成自签名证书；已存在且未要求重建时直接复用。 */
function ensureSelfSignedCertificate({ dir, hosts, force = false, log = console.info }) {
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  if (!force && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { certPath, keyPath, created: false };
  }
  if (!hasOpenssl()) {
    throw new Error(
      'WEB_TLS requires openssl to generate a self-signed certificate. '
      + 'Install openssl, or provide WEB_TLS_CERT / WEB_TLS_KEY explicitly '
      + '(see README "HTTPS 部署").',
    );
  }

  fs.mkdirSync(dir, { recursive: true });
  const subjectAltName = buildSubjectAltName(hosts);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
    '-keyout', keyPath,
    '-out', certPath,
    '-subj', '/CN=ai-ssh-client',
    '-addext', `subjectAltName=${subjectAltName}`,
  ], { stdio: 'ignore' });
  log(`Generated self-signed TLS certificate for: ${hosts.join(', ')}`);
  return { certPath, keyPath, created: true };
}

/**
 * 解析 TLS 配置。
 * @returns {{cert: Buffer, key: Buffer} | null} 未启用时返回 null。
 */
function resolveTlsOptions(env = process.env, options = {}) {
  const certFile = String(env.WEB_TLS_CERT || '').trim();
  const keyFile = String(env.WEB_TLS_KEY || '').trim();
  const requested = isEnabled(env.WEB_TLS) || isEnabled(env.WEB_TLS_SELF_SIGNED);
  if (!requested && !certFile && !keyFile) {
    return null;
  }
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new Error('WEB_TLS_CERT and WEB_TLS_KEY must be provided together.');
  }

  let certPath = certFile;
  let keyPath = keyFile;
  if (!certPath) {
    const dir = options.tlsDir || path.join(options.dataDir || path.join(__dirname, '..', 'data'), 'tls');
    const hosts = options.hosts || defaultCertificateHosts(splitList(env.WEB_TLS_HOSTS));
    const generated = ensureSelfSignedCertificate({
      dir,
      hosts,
      force: isEnabled(env.WEB_TLS_REGENERATE),
      log: options.log,
    });
    certPath = generated.certPath;
    keyPath = generated.keyPath;
  }

  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };
}

module.exports = {
  resolveTlsOptions,
  ensureSelfSignedCertificate,
  defaultCertificateHosts,
  buildSubjectAltName,
  isEnabled,
};
