// ============================================================
// CogniTrader BSC — ESLint flat config (ESLint 9)
// Minimal: TypeScript parsing + the typescript-eslint recommended
// rule set. Tests are linted alongside src.
// ============================================================

const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');

// The plugin's recommended config may be flat (array) or eslintrc-shaped
// depending on the installed version; normalize to a rules object.
const recommended = tsPlugin.configs.recommended;
const recommendedRules = Array.isArray(recommended)
  ? Object.assign({}, ...recommended.map((part) => part.rules || {}))
  : recommended.rules || {};

module.exports = [
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...recommendedRules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
];
