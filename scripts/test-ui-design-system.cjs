#!/usr/bin/env node
/**
 * Gates the shipped UI design-system contract (tokens, shared classes, chrome consumers).
 */
const { validateUiDesignSystem } = require('./lib/ui-design-system-check.cjs');

const result = validateUiDesignSystem();
for (const note of result.notes) {
  console.log(`[ui-design-system] ${note}`);
}
if (!result.ok) {
  console.error('[ui-design-system] FAILED');
  for (const failure of result.failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}
console.log('[ui-design-system] OK');
