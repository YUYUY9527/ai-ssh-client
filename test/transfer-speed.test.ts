import { describe, expect, it } from 'vitest';

import {
  SPEED_MIN_SPAN_MS,
  SPEED_WINDOW_MS,
  TransferSpeedTracker,
  computeWindowSpeed,
  formatByteSize,
  formatTransferSpeed,
  type SpeedSample,
} from '../src/renderer/transfer/transfer-speed';

describe('computeWindowSpeed', () => {
  it('returns 0 with no samples', () => {
    expect(computeWindowSpeed([], 10_000)).toBe(0);
  });

  it('returns 0 with a single sample (no delta yet)', () => {
    expect(computeWindowSpeed([{ t: 1000, bytes: 500 }], 1000)).toBe(0);
  });

  it('computes bytes per second over the window', () => {
    const samples: SpeedSample[] = [
      { t: 0, bytes: 0 },
      { t: 1000, bytes: 2048 },
    ];
    // 2048 bytes in 1s => 2048 B/s
    expect(computeWindowSpeed(samples, 1000)).toBe(2048);
  });

  it('averages across multiple samples', () => {
    const samples: SpeedSample[] = [
      { t: 0, bytes: 0 },
      { t: 500, bytes: 1000 },
      { t: 1000, bytes: 3000 },
    ];
    // 3000 bytes over 1s => 3000 B/s
    expect(computeWindowSpeed(samples, 1000)).toBe(3000);
  });

  it('returns 0 until the minimum span is reached', () => {
    const samples: SpeedSample[] = [
      { t: 0, bytes: 0 },
      { t: SPEED_MIN_SPAN_MS - 1, bytes: 10_000 },
    ];
    expect(computeWindowSpeed(samples, SPEED_MIN_SPAN_MS - 1)).toBe(0);
  });

  it('ignores samples older than the window', () => {
    const now = SPEED_WINDOW_MS + 5000;
    const samples: SpeedSample[] = [
      { t: 0, bytes: 0 }, // outside window
      { t: now - 1000, bytes: 1000 },
      { t: now, bytes: 2000 },
    ];
    // Only the last 1s counts: 1000 bytes/s
    expect(computeWindowSpeed(samples, now)).toBe(1000);
  });

  it('decays toward 0 when no new bytes arrive (stalled transfer)', () => {
    const samples: SpeedSample[] = [
      { t: 0, bytes: 0 },
      { t: 1000, bytes: 4000 },
    ];
    const fresh = computeWindowSpeed(samples, 1000);
    const later = computeWindowSpeed(samples, 3000);
    expect(fresh).toBe(4000);
    // Same bytes spread over a longer span => lower speed.
    expect(later).toBeLessThan(fresh);
    expect(later).toBeGreaterThan(0);
    // Once the only remaining sample has no delta, speed is 0.
    expect(computeWindowSpeed(samples, 1000 + SPEED_WINDOW_MS + 1)).toBe(0);
  });

  it('never returns a negative speed', () => {
    const samples: SpeedSample[] = [
      { t: 0, bytes: 5000 },
      { t: 1000, bytes: 1000 },
    ];
    expect(computeWindowSpeed(samples, 1000)).toBe(0);
  });
});

describe('TransferSpeedTracker', () => {
  it('tracks a steady transfer', () => {
    const tracker = new TransferSpeedTracker();
    tracker.observe('task', 1, 0, 0);
    tracker.observe('task', 1, 1000, 500);
    tracker.observe('task', 1, 2000, 1000);
    expect(tracker.speedAt('task', 1000)).toBe(2000);
  });

  it('resets history when the attempt changes (retry)', () => {
    const tracker = new TransferSpeedTracker();
    tracker.observe('task', 1, 0, 0);
    tracker.observe('task', 1, 1_000_000, 1000);
    // New attempt restarts from a resumed offset; must not spike or go negative.
    tracker.observe('task', 2, 500, 2000);
    tracker.observe('task', 2, 1500, 3000);
    expect(tracker.speedAt('task', 3000)).toBe(1000);
  });

  it('resets history when bytes regress within an attempt', () => {
    const tracker = new TransferSpeedTracker();
    tracker.observe('task', 1, 0, 0);
    tracker.observe('task', 1, 9000, 1000);
    tracker.observe('task', 1, 100, 2000); // regression
    tracker.observe('task', 1, 1100, 3000);
    expect(tracker.speedAt('task', 3000)).toBe(1000);
  });

  it('returns 0 for an unknown task', () => {
    const tracker = new TransferSpeedTracker();
    expect(tracker.speedAt('missing', 1000)).toBe(0);
  });

  it('prunes tasks that are no longer active', () => {
    const tracker = new TransferSpeedTracker();
    tracker.observe('a', 1, 0, 0);
    tracker.observe('a', 1, 1000, 1000);
    tracker.observe('b', 1, 0, 0);
    tracker.prune(new Set(['b']));
    expect(tracker.speedAt('a', 1000)).toBe(0);
  });

  it('keeps memory bounded by dropping samples outside the window', () => {
    const tracker = new TransferSpeedTracker();
    // Feed many samples across a long span; only the recent window should remain.
    for (let t = 0; t <= SPEED_WINDOW_MS * 3; t += 200) {
      tracker.observe('task', 1, (t / 200) * 100, t);
    }
    const now = SPEED_WINDOW_MS * 3;
    const speed = tracker.speedAt('task', now);
    // Steady 100 bytes per 200ms => 500 B/s.
    expect(speed).toBe(500);
  });
});

describe('formatByteSize', () => {
  it('formats zero and small values', () => {
    expect(formatByteSize(0)).toBe('0 B');
    expect(formatByteSize(512)).toBe('512 B');
  });

  it('uses 1024-based units with one decimal', () => {
    expect(formatByteSize(1024)).toBe('1 KB');
    expect(formatByteSize(1536)).toBe('1.5 KB');
    expect(formatByteSize(1024 * 1024)).toBe('1 MB');
    expect(formatByteSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatByteSize(1024 * 1024 * 1024)).toBe('1 GB');
  });

  it('guards against invalid input', () => {
    expect(formatByteSize(-5)).toBe('0 B');
    expect(formatByteSize(Number.NaN)).toBe('0 B');
    expect(formatByteSize(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});

describe('formatTransferSpeed', () => {
  it('appends a per-second unit', () => {
    expect(formatTransferSpeed(0)).toBe('0 B/s');
    expect(formatTransferSpeed(1024)).toBe('1 KB/s');
    expect(formatTransferSpeed(12.4 * 1024 * 1024)).toBe('12.4 MB/s');
  });
});
