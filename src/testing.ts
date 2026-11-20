import { createHmac } from 'node:crypto'
import { SoshoPay } from './index.js'
import type { components } from './schema.js'
import { assertSafeNumbers } from './transport.js'

export type WebhookEvent = Pick<components['schemas']['Event'], 'id' | 'type' | 'created_at' | 'data'>
/** Offline fixture only. Use a separate local secret, never a production webhook secret. */
export function webhookPayload(event: WebhookEvent, secret = 'whsec_offline_fixture', timestamp = Math.floor(Date.now() / 1000)) {
  assertSafeNumbers(event)
  if (!secret.startsWith('whsec_') || !Number.isSafeInteger(timestamp)) throw new TypeError('Invalid local signing inputs.')
  const body = JSON.stringify({ id: event.id, type: event.type, created_at: event.created_at, data: event.data })
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return { body, headers: { 'Content-Type': 'application/json', 'Soshopay-Signature': `t=${timestamp},v1=${signature}`, 'Soshopay-Event-Id': event.id, 'Soshopay-Delivery-Id': `cli_${globalThis.crypto.randomUUID()}`, 'Soshopay-Attempt': '1' } }
}

/** In-memory fake using the real serialization/error handling. Queue Response objects or envelopes. */
export function createTestClient(results: Array<Response | object>) {
  const queue = [...results]
  const requests: Request[] = []
  const client = new SoshoPay({ baseUrl: 'https://offline.example', apiKey: 'sk_test_offline', maxRetries: 0, fetch: async (url, init) => {
    requests.push(new Request(url, init))
    const next = queue.shift()
    if (!next) throw new Error('Offline response queue exhausted.')
    return next instanceof Response ? next : Response.json(next)
  } })
  return { client, requests }
}
