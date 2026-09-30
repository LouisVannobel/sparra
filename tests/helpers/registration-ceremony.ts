import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'

// Test-only packed self-attestation. Native SimpleWebAuthn verifies its ES256
// signature; no success response or verification callback is mocked.
type Cbor = number | string | Buffer | Map<Cbor, Cbor>
function cbor(value: Cbor): Buffer {
  function head(major: number, length: number) {
    if (length < 24) return Buffer.from([major * 32 + length])
    if (length < 256) return Buffer.from([major * 32 + 24, length])
    const result = Buffer.alloc(3); result[0] = major * 32 + 25; result.writeUInt16BE(length, 1); return result
  }
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -value - 1)
  if (typeof value === 'string') { const bytes = Buffer.from(value); return Buffer.concat([head(3, bytes.length), bytes]) }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value])
  return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, entry]) => [cbor(key), cbor(entry)])])
}
export function registrationCredentialFixture(options: { challenge: string; rp: { id?: string } }, origin: string, uv = true) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' })
  const credentialId = randomBytes(32)
  const cose = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]))
  const length = Buffer.alloc(2); length.writeUInt16BE(credentialId.length)
  const authenticatorData = Buffer.concat([createHash('sha256').update(options.rp.id!).digest(), Buffer.from([uv ? 0x45 : 0x41]),
    Buffer.alloc(4), Buffer.alloc(16), length, credentialId, cose])
  const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }))
  const signature = sign('sha256', Buffer.concat([authenticatorData, createHash('sha256').update(clientData).digest()]), privateKey)
  const attestationObject = cbor(new Map<Cbor, Cbor>([['fmt', 'packed'], ['authData', authenticatorData],
    ['attStmt', new Map<Cbor, Cbor>([['alg', -7], ['sig', signature]])]]))
  const response = { id: credentialId.toString('base64url'), rawId: credentialId.toString('base64url'), type: 'public-key' as const,
    response: { clientDataJSON: clientData.toString('base64url'), attestationObject: attestationObject.toString('base64url'), transports: ['internal'] },
    clientExtensionResults: {}, authenticatorAttachment: 'platform' as const }
  return Object.freeze({ response,
    virtualAuthenticatorCredential(rpId: string, userHandle: string, signCount = 0) {
      return { credentialId: credentialId.toString('base64'), isResidentCredential: true, rpId,
        privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
        userHandle: Buffer.from(userHandle, 'base64url').toString('base64'), signCount }
    },
    authenticationResponse(authentication: { challenge: string; rpId?: string }, values: Readonly<{
      uv?: boolean
      up?: boolean
      counter?: number
      challenge?: string
      origin?: string
      rpId?: string
      type?: string
    }> = {}) {
      const counter = values.counter ?? 1
      if (!Number.isSafeInteger(counter) || counter < 0 || counter > 0xffff_ffff) throw new Error('Invalid fixture counter')
      const rpId = values.rpId ?? authentication.rpId
      if (!rpId) throw new Error('Missing fixture RP ID')
      const counterBytes = Buffer.alloc(4); counterBytes.writeUInt32BE(counter)
      const assertionAuthenticatorData = Buffer.concat([
        createHash('sha256').update(rpId).digest(),
        Buffer.from([(values.up === false ? 0 : 0x01) | (values.uv === false ? 0 : 0x04)]), counterBytes,
      ])
      const assertionClientData = Buffer.from(JSON.stringify({ type: values.type ?? 'webauthn.get', challenge: values.challenge ?? authentication.challenge,
        origin: values.origin ?? origin, crossOrigin: false }))
      const assertionSignature = sign('sha256', Buffer.concat([
        assertionAuthenticatorData, createHash('sha256').update(assertionClientData).digest(),
      ]), privateKey)
      return { id: response.id, rawId: response.rawId, type: 'public-key' as const,
        response: { clientDataJSON: assertionClientData.toString('base64url'), authenticatorData: assertionAuthenticatorData.toString('base64url'),
          signature: assertionSignature.toString('base64url') }, clientExtensionResults: {}, authenticatorAttachment: 'platform' as const }
    },
  })
}

export function registrationCeremony(options: { challenge: string; rp: { id?: string } }, origin: string, uv = true) {
  return registrationCredentialFixture(options, origin, uv).response
}
