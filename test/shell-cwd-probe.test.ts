import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  makePwdProbeToken,
  stripPwdProbeArtifacts,
} = require('../server/shell-cwd-probe.cjs') as {
  makePwdProbeToken: () => string;
  stripPwdProbeArtifacts: (text: string) => string;
};

describe('shell-cwd-probe', () => {
  it('builds unique probe tokens', () => {
    const left = makePwdProbeToken();
    const right = makePwdProbeToken();
    expect(left).toMatch(/^__AIS_PWD_[A-Za-z0-9]+__$/);
    expect(right).toMatch(/^__AIS_PWD_[A-Za-z0-9]+__$/);
    expect(left).not.toBe(right);
  });

  it('strips probe command and result from terminal broadcast text', () => {
    const token = '__AIS_PWD_testhash__';
    const raw = [
      `stty -echo 2>/dev/null; printf '%s:%s\\n' '${token}' "$PWD"; stty echo 2>/dev/null`,
      `${token}:/var/log`,
      'root@host:/var/log# ',
    ].join('\r\n');

    const cleaned = stripPwdProbeArtifacts(raw);
    expect(cleaned).not.toContain(token);
    expect(cleaned).not.toContain('stty -echo');
    expect(cleaned).toContain('root@host:/var/log#');
  });

  it('leaves normal shell output untouched', () => {
    const text = 'root@host:/home# ls\r\nfile.txt\r\nroot@host:/home# ';
    expect(stripPwdProbeArtifacts(text)).toBe(text);
  });
});
