import type { BetterAuthOptions } from 'better-auth'

export const authSchemaOptions = {
  emailVerification: { sendOnSignUp: false, expiresIn: 600 },
  user: {
    additionalFields: {
      recovering: { type: 'boolean', required: true, defaultValue: false, input: false, returned: false },
      recoveryGeneration: { type: 'number', required: true, defaultValue: 0, input: false, returned: false },
      holdUntil: { type: 'date', required: false, input: false, returned: false },
    },
  },
  session: {
    additionalFields: {
      authState: { type: ['ACTIVE', 'MFA_PENDING', 'RECOVERY_RESTRICTED'], required: true, input: false, returned: false },
      authMethod: { type: ['google', 'magic-link', 'passkey', 'totp', 'recovery'], required: true, input: false, returned: false },
      authenticatedAt: { type: 'date', required: true, input: false, returned: false },
      providerIdentity: { type: 'json', required: false, input: false, returned: false },
      recoveryGeneration: { type: 'number', required: true, input: false, returned: false },
      lastActivityAt: { type: 'date', required: true, input: false, returned: false },
    },
  },
} satisfies Pick<BetterAuthOptions, 'user' | 'session' | 'emailVerification'>
