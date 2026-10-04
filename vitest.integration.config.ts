import { defineConfig } from 'vitest/config'
import ordinaryConfig from './vitest.config.ts'

export default defineConfig({
  test: { environment: 'node', include: ['tests/integration/**/*.test.ts'], testTimeout: 20000, hookTimeout: 180000, coverage: ordinaryConfig.test?.coverage },
})
