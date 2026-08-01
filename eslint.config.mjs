import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    // Граница архитектуры (ADR-0004): core и shared не знают про Electron.
    files: ['src/core/**/*.ts', 'src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'electron', message: 'core/shared не зависят от Electron (ADR-0004)' }],
          patterns: [{ group: ['electron/*'], message: 'core/shared не зависят от Electron (ADR-0004)' }]
        }
      ]
    }
  },
  {
    // Renderer — только UI: ни Electron, ни Node, ни внутренностей core (ADR-0005).
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'electron', message: 'renderer общается с main только через IPC-контракт (ADR-0005)' }],
          patterns: [
            { group: ['electron/*'], message: 'renderer общается с main только через IPC-контракт (ADR-0005)' },
            { group: ['node:*'], message: 'в renderer нет Node API (sandbox)' },
            { group: ['@core/*'], message: 'renderer видит только типы из @shared (ADR-0005)' }
          ]
        }
      ]
    }
  }
)
