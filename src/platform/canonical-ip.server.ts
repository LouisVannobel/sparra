import { isIP } from 'node:net'

// Shared by the two actual ingress/limiter consumers; preserves native R1 keys.
export function canonicalIp(ip: string): string {
  if (!isIP(ip) || ip.includes('%')) throw new Error('Invalid IP')
  if (isIP(ip) === 4) return ip
  const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1)
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized)
  if (!mapped) return normalized
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16)
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}
