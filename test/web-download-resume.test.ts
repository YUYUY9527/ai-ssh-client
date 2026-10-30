import { describe, it, expect } from 'vitest';
import {
  decideWebDownloadConflict,
  decideWebDownloadResume,
  localNameWithSuffix,
  splitLocalFileName,
  suggestedLocalName,
  webDownloadPartMetaName,
} from '../src/renderer/lib/web-download-resume';
import type { WebDownloadPartMeta } from '../src/renderer/lib/web-download-resume';

function meta(overrides: Partial<WebDownloadPartMeta> = {}): WebDownloadPartMeta {
  return {
    taskId: 'task-1',
    name: 'file.bin',
    etag: '"100-5"',
    size: 100,
    bytesWritten: 40,
    ...overrides,
  };
}

describe('decideWebDownloadResume', () => {
  it('resumes when a matching task checkpoint and local size exist', () => {
    expect(decideWebDownloadResume({
      taskId: 'task-1',
      metadata: meta(),
      existingSize: 40,
    })).toEqual({ resume: true, offset: 40, ifRange: '"100-5"' });
  });

  it('does not resume without checkpoint metadata', () => {
    expect(decideWebDownloadResume({
      taskId: 'task-1',
      metadata: null,
      existingSize: 40,
    })).toEqual({ resume: false, offset: 0 });
  });

  it('does not resume when the checkpoint belongs to another task', () => {
    expect(decideWebDownloadResume({
      taskId: 'task-2',
      metadata: meta(),
      existingSize: 40,
    })).toEqual({ resume: false, offset: 0 });
  });

  it('does not resume when the local file size differs from bytesWritten', () => {
    expect(decideWebDownloadResume({
      taskId: 'task-1',
      metadata: meta(),
      existingSize: 39,
    })).toEqual({ resume: false, offset: 0 });
  });

  it('does not resume when the remote validator is stale', () => {
    expect(decideWebDownloadResume({
      taskId: 'task-1',
      metadata: meta(),
      existingSize: 40,
      remoteEtag: '"100-9"',
    })).toEqual({ resume: false, offset: 0 });
  });

  it('does not resume when the checkpoint records no validator etag', () => {
    expect(decideWebDownloadResume({
      taskId: 'task-1',
      metadata: meta({ etag: '' }),
      existingSize: 40,
    })).toEqual({ resume: false, offset: 0 });
  });

  it('does not resume when the recorded download is already complete', () => {
    expect(decideWebDownloadResume({
      taskId: 'task-1',
      metadata: meta({ size: 40, bytesWritten: 40 }),
      existingSize: 40,
    })).toEqual({ resume: false, offset: 0 });
  });

  it('builds a task-scoped checkpoint filename', () => {
    expect(webDownloadPartMetaName('file.bin', 'task-1'))
      .toBe('.file.bin.task-1.partmeta');
  });
});

describe('decideWebDownloadConflict', () => {
  it('always resumes when the task checkpoint is valid, regardless of policy', () => {
    expect(decideWebDownloadConflict({ exists: true, resume: true, policy: 'ask' }))
      .toBe('resume');
    expect(decideWebDownloadConflict({ exists: true, resume: true, policy: 'overwrite' }))
      .toBe('resume');
    expect(decideWebDownloadConflict({ exists: true, resume: true, policy: 'skip' }))
      .toBe('resume');
    expect(decideWebDownloadConflict({ exists: true, resume: true, policy: 'rename' }))
      .toBe('resume');
  });

  it('writes straight to the target name when no file exists yet', () => {
    expect(decideWebDownloadConflict({ exists: false, resume: false, policy: 'ask' }))
      .toBe('overwrite');
    expect(decideWebDownloadConflict({ exists: false, resume: false, policy: 'skip' }))
      .toBe('overwrite');
    expect(decideWebDownloadConflict({ exists: false, resume: false, policy: 'rename' }))
      .toBe('overwrite');
  });

  it('follows the conflict policy when an unrelated file blocks the name', () => {
    expect(decideWebDownloadConflict({ exists: true, resume: false, policy: 'overwrite' }))
      .toBe('overwrite');
    expect(decideWebDownloadConflict({ exists: true, resume: false, policy: 'skip' }))
      .toBe('skip');
    expect(decideWebDownloadConflict({ exists: true, resume: false, policy: 'rename' }))
      .toBe('rename');
    expect(decideWebDownloadConflict({ exists: true, resume: false, policy: 'ask' }))
      .toBe('ask');
  });
});

describe('local file name candidates', () => {
  it('splits stem and extension, keeping hidden files intact', () => {
    expect(splitLocalFileName('report.tar.gz')).toEqual({ stem: 'report.tar', extension: '.gz' });
    expect(splitLocalFileName('README')).toEqual({ stem: 'README', extension: '' });
    expect(splitLocalFileName('.bashrc')).toEqual({ stem: '.bashrc', extension: '' });
  });

  it('builds numbered candidates', () => {
    expect(localNameWithSuffix('file.bin', 1)).toBe('file (1).bin');
    expect(localNameWithSuffix('file.bin', 12)).toBe('file (12).bin');
    expect(localNameWithSuffix('README', 2)).toBe('README (2)');
    expect(localNameWithSuffix('file.bin', 0)).toBe('file.bin');
  });

  it('suggests the first rename candidate', () => {
    expect(suggestedLocalName('file.bin')).toBe('file (1).bin');
    expect(suggestedLocalName('.env')).toBe('.env (1)');
  });
});
