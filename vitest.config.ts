import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    exclude: [...configDefaults.exclude, 'tests/integration/**'],
    coverage: {
      provider: 'istanbul',
      reporter: ['json'],
      reportsDirectory: 'coverage',
      clean: true,
      reportOnFailure: false,
      processingConcurrency: 1,
      include: [
        'src/**/*.{ts,tsx,mjs,js}',
        'scripts/**/*.{ts,mjs,js}',
        'tests/helpers/**/*.{ts,tsx,mjs,js}',
        'tests/fixtures/**/*.{ts,tsx,mjs,js}',
      ],
    },
  },
})
