import { describe, expect, it } from 'vitest';
import { loadOpenSshIdentityFiles } from '../src/renderer/connection/openssh-identity';
import { parseOpenSshConfig } from '../src/renderer/connection/parse-openssh-config';

describe('parseOpenSshConfig', () => {
  it('parses Host / HostName / User / Port / IdentityFile', () => {
    const connections = parseOpenSshConfig(`
Host web
  HostName 192.168.1.10
  User ubuntu
  Port 2222
  IdentityFile "~/.ssh/id_web"

Host db
  HostName db.internal
  User root
  IdentityFile none
`);

    expect(connections).toHaveLength(2);
    expect(connections[0]).toMatchObject({
      name: 'web',
      host: '192.168.1.10',
      port: 2222,
      username: 'ubuntu',
      identityFile: '~/.ssh/id_web',
    });
    expect(connections[1]).toMatchObject({
      name: 'db',
      host: 'db.internal',
      port: 22,
      username: 'root',
    });
    expect(connections[1].identityFile).toBeUndefined();
  });

  it('keeps the first IdentityFile and accepts case-insensitive keys', () => {
    const [connection] = parseOpenSshConfig(`
host keyed
  hostname example.com
  user deploy
  identityfile ~/.ssh/first
  IdentityFile ~/.ssh/second
`);

    expect(connection.identityFile).toBe('~/.ssh/first');
  });

  it('skips wildcard-only host blocks', () => {
    const connections = parseOpenSshConfig(`
Host *
  User everyone
  IdentityFile ~/.ssh/id_rsa

Host real
  HostName real.example.com
  User alice
`);

    expect(connections).toHaveLength(1);
    expect(connections[0].name).toBe('real');
  });
});

describe('loadOpenSshIdentityFiles', () => {
  it('loads IdentityFile contents into privateKey and reports counts', async () => {
    const drafts = parseOpenSshConfig(`
Host keyed
  HostName example.com
  User deploy
  IdentityFile ~/.ssh/id_keyed
`);
    const readPaths: string[] = [];
    const result = await loadOpenSshIdentityFiles(drafts, async (filePath) => {
      readPaths.push(filePath);
      return { success: true, data: { content: '-----BEGIN KEY-----' } };
    });

    expect(readPaths).toEqual(['~/.ssh/id_keyed']);
    expect(result.loadedKeys).toBe(1);
    expect(result.failedKeys).toBe(0);
    expect(result.connections[0].privateKey).toBe('-----BEGIN KEY-----');
    expect(result.connections[0]).not.toHaveProperty('identityFile');
  });

  it('keeps importing when a key cannot be read', async () => {
    const drafts = parseOpenSshConfig(`
Host missing
  HostName example.com
  User deploy
  IdentityFile ~/.ssh/missing
`);
    const result = await loadOpenSshIdentityFiles(drafts, async () => ({
      success: false,
      error: 'ENOENT',
    }));

    expect(result.loadedKeys).toBe(0);
    expect(result.failedKeys).toBe(1);
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].host).toBe('example.com');
    expect(result.connections[0].privateKey).toBeUndefined();
  });
});
