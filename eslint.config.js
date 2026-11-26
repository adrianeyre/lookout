import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Any string naming /proc or /sys outright, which would bypass the Host root (ADR-0003). */
const DIRECT_HOST_PATH = String.raw`/^\/(proc|sys)(\/|$)/`;

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'e2e/.tmp/**',
      // The Stageshow kit, vendored unmodified (site/stageshow/README.md).
      'site/stageshow/**',
      // Plain JavaScript run only inside the pen-test fixture Image (docs/pen-test/fixtures.md).
      'pen-test/fixture-image/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      // Fastify handlers and interface implementations are async without always awaiting.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['apps/server/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/server/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: `Literal[value=${DIRECT_HOST_PATH}]`,
          message:
            'Read Host files through HostRoot (LOOKOUT_HOST_ROOT), never /proc or /sys directly.',
        },
        {
          selector: `TemplateElement[value.raw=${DIRECT_HOST_PATH}]`,
          message:
            'Read Host files through HostRoot (LOOKOUT_HOST_ROOT), never /proc or /sys directly.',
        },
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}', 'site/demos/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
