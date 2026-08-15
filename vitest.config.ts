import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The core suite intentionally exercises real Git repositories and durable
    // crash recovery. Windows process startup can exceed Vitest's unit-test
    // default even when the operation is healthy.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
