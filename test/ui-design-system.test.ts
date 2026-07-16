import { describe, it, expect } from 'vitest';
import { validateUiDesignSystem } from '../scripts/lib/ui-design-system-check.cjs';

describe('ui-design-system', () => {
  it('satisfies the shipped design-system contract', () => {
    const result = validateUiDesignSystem();
    // 失败时把具体项打印出来，便于定位。
    expect(result.ok, result.failures?.join('\n')).toBe(true);
  });
});
