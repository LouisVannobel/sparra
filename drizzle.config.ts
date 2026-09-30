import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/modules/auth/schema.server.ts', './src/modules/workspaces/schema.server.ts'],
  out: './drizzle',
})
