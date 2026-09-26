import { defineConfig } from 'vitest/config';

/**
 * The cross-language suite, run separately because it needs fixtures fetched from the framework
 * repository. The default config excludes it so `npm test` stays offline.
 */
export default defineConfig({
  test: {
    include: ['test/wire-fixtures.test.ts'],
  },
});
