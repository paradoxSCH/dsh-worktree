import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The core suite intentionally exercises real Git repositories and durable
    // crash recovery. Windows process startup can exceed Vitest's unit-test
    // default even when the operation is healthy.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    exclude: [...configDefaults.exclude, 'tests/browser/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/client/**', 'src/**/*.d.ts'],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: {
        statements: 68,
        branches: 52,
        functions: 79,
        lines: 72,
      },
    },
  },
})
