import { describe, it, expect } from 'vitest';
import {
  gateTerminalPaste,
  isMultiLinePaste,
  prepareTerminalPaste,
  resolvePasteConfirmation,
} from '../src/renderer/session/terminal/paste-safety';

describe('paste-safety', () => {
  it('sends single-line paste without confirmation', () => {
    expect(isMultiLinePaste('echo hello')).toBe(false);
    const single = gateTerminalPaste('echo hello');
    expect(single.action).toBe('send');
    expect(single.text).toBe('echo hello');
  });

  it('blocks multi-line paste with \\n for confirmation', () => {
    expect(isMultiLinePaste('line1\nline2')).toBe(true);
    const multiN = gateTerminalPaste('line1\nline2');
    expect(multiN.action).toBe('confirm');
    expect(multiN.previewText).toBe('line1\nline2');
    expect(multiN.preparedText).toBe('line1\rline2');
  });

  it('blocks multi-line paste with \\r for confirmation', () => {
    const multiR = gateTerminalPaste('a\rb');
    expect(multiR.action).toBe('confirm');
  });

  it('returns CR-normalized text when confirmed', () => {
    const confirmed = gateTerminalPaste('line1\r\nline2\nline3', true);
    expect(confirmed.action).toBe('send');
    expect(confirmed.text).toBe(prepareTerminalPaste('line1\r\nline2\nline3'));
    expect(confirmed.text).toBe('line1\rline2\rline3');
  });

  it('resolves paste confirmation', () => {
    const multiN = gateTerminalPaste('line1\nline2');
    expect(resolvePasteConfirmation(multiN.preparedText, false)).toBe('');
    expect(resolvePasteConfirmation(multiN.preparedText, true)).toBe(multiN.preparedText);
  });

  it('skips empty paste', () => {
    expect(gateTerminalPaste('').action).toBe('skip');
  });
});
