import { configDefaults, defineConfig } from 'vitest/config';

// Vitest 4 no longer ignores `dist/` by default: the compiled copies of the tests would run twice.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, 'dist/**'] },
});
