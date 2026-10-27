// Better Auth stores OAuth state under this namespace; the public state stays opaque.
export function storedOAuthStateIdentifier(state: string): string {
  return 'auth-state:' + state
}
