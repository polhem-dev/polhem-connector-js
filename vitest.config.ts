import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The wire-fixture suite needs samples fetched from the framework repository, so it is not
    // part of the default run — `npm test` stays offline. Run it with `npm run test:wire`.
    exclude: [...configDefaults.exclude, 'test/wire-fixtures.test.ts'],
  },
});
