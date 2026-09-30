import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server'

// Pure signed-UV verification shared by the two existing-key consumers.
// Each consumer retains its own public refusal type and transaction policy.
export async function verifyPasskeyAssertion(key: { credentialID: string; publicKey: string; counter: number }, challenge: string,
  response: AuthenticationResponseJSON, origin: string) {
  if (response.id !== key.credentialID) throw new Error('Authentication rejected')
  const result = await verifyAuthenticationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin,
    expectedRPID: new URL(origin).hostname, credential: { id: key.credentialID, publicKey: new Uint8Array(Buffer.from(key.publicKey, 'base64')), counter: key.counter },
    requireUserVerification: true }).catch(() => { throw new Error('Authentication rejected') })
  const counter = result.authenticationInfo.newCounter
  if (result.verified !== true || result.authenticationInfo.userVerified !== true || !Number.isSafeInteger(counter) || counter < 0
    || (counter > 0 || key.counter > 0) && counter <= key.counter) throw new Error('Authentication rejected')
  return counter
}
