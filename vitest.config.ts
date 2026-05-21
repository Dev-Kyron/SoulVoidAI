import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Root Vitest configuration. Two projects so main-process tests run in Node
 * and renderer-side tests get happy-dom; both share the @shared alias.
 *
 * Tests live alongside the code they cover, with `.test.ts` / `.test.tsx`
 * suffixes. Coverage isn't wired by default — opt in with `--coverage`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'out', 'dist'],
    environmentMatchGlobs: [
      ['src/renderer/**', 'happy-dom'],
      ['src/main/**', 'node'],
      ['src/shared/**', 'node']
    ],
    // Most of the storage tests touch the SQLite + filesystem layer; we point
    // them at an isolated tmp dir so they don't clobber the real user data
    // directory. Done inside individual test files via mocks.
    globals: false,
    testTimeout: 15_000
  }
})
