const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    // .claude/worktrees holds crew copies of this repo; each one is linted from inside itself.
    ignores: [
      'dist/*',
      'firstmate/*',
      'backpass/*',
      'supabase/functions/*',
      '.claude/worktrees/*',
    ],
  },
  {
    // Contract suites are authored upstream and must never be edited (SPEC section 0),
    // so style rules cannot be satisfied here.
    files: ['src/lib/split/split.test.ts', 'src/lib/claims/resolve.test.ts'],
    rules: { '@typescript-eslint/array-type': 'off' },
  },
]);
