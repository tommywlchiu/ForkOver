const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'firstmate/*', 'backpass/*'],
  },
  {
    // Contract suites are authored upstream and must never be edited (SPEC section 0),
    // so style rules cannot be satisfied here.
    files: ['src/lib/split/split.test.ts', 'src/lib/claims/resolve.test.ts'],
    rules: { '@typescript-eslint/array-type': 'off' },
  },
]);
