import { createHmac, timingSafeEqual } from 'node:crypto'

/** Verify the raw UTF-8 body BEFORE JSON parsing; do not reserialize the payload. */
export function verifyWebhook(secret: string, rawBody: string | Uint8Array, header: string | null, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300): boolean {
  if (!secret.startsWith('whsec_') || !Number.isSafeInteger(nowSeconds) || !Number.isSafeInteger(toleranceSeconds) || toleranceSeconds < 1 || toleranceSeconds > 300) return false
  const match = /^t=(\d{1,16}),v1=([a-f0-9]{64})$/.exec(header ?? '')
  if (!match) return false
  const timestamp = Number(match[1])
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false
  const signature = createHmac('sha256', secret).update(`${match[1]}.`).update(rawBody).digest()
  return timingSafeEqual(signature, Buffer.from(match[2]!, 'hex'))
}
