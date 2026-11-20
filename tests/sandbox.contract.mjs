import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { SoshoPay, ApiError } from '../dist/index.js'
import { PublicSoshoPay } from '../dist/public.js'
import { paymentExample } from '../examples/payment.mjs'
import { listen } from '../dist/cli.js'
import { verifyWebhook } from '../dist/webhook.js'

const baseUrl = process.env.SOSHO_BASE_URL
const apiKey = process.env.SOSHO_SECRET_KEY
const publicKey = process.env.SOSHO_PUBLISHABLE_KEY
// Only CI's isolated loopback Sandbox. Refuse remote or Live destinations even if misconfigured.
assert.equal(new URL(baseUrl).origin, 'http://localhost:18080')
if (typeof apiKey !== 'string' || !/^sk_test_[A-Za-z0-9]+$/.test(apiKey) || typeof publicKey !== 'string' || !/^pk_test_[A-Za-z0-9]+$/.test(publicKey)) {
  throw new Error('SDK contract tests require isolated Sandbox credentials.')
}
const client = new SoshoPay({ baseUrl, apiKey })
const key = randomUUID()
const first = await paymentExample(client, key)
const replay = await paymentExample(client, key)
assert.equal(replay.data.id, first.data.id)
const browser = new PublicSoshoPay({ baseUrl, apiKey: publicKey })
let current
for (let attempt = 0; attempt < 30; attempt++) {
  current = await browser.getPayment(first.data.id)
  if (current.data.status !== 'pending' && current.data.status !== 'created') break
  await new Promise(resolve => setTimeout(resolve, 1_000))
}
assert.equal(current.data.status, 'succeeded')
assert.equal(current.data.amount, 100)
assert.equal(current.meta.mode, 'sandbox')
const events = await browser.listPaymentEvents(first.data.id)
assert.ok(events.data.length)
const merchantEvents = await client.request('listEvents', {})
assert.ok(merchantEvents.data.length)
assert.equal((await client.request('getEvent', { path: { id: merchantEvents.data[0].id } })).data.id, merchantEvents.data[0].id)
let localDeliveries = 0
await listen(client, 'http://127.0.0.1:3000/webhooks', 'whsec_ci_local', { batches: 1, fetch: async (_url, init) => {
  assert.equal(verifyWebhook('whsec_ci_local', init.body, init.headers['Soshopay-Signature']), true)
  assert.equal(Object.hasOwn(init.headers, 'Authorization'), false)
  localDeliveries++
  return new Response(null, { status: 204 })
} })
assert.ok(localDeliveries > 0)
const refund = await client.createRefund(first.data.id, { amount: 1, reason: 'SDK CI contract' }, { idempotencyKey: randomUUID() })
assert.equal(refund.data.status, 'succeeded')
assert.equal(refund.data.amount, 1)
await assert.rejects(client.getPayment('pay_missing'), error => error instanceof ApiError && error.status === 404 && error.code === 'resource_not_found')
console.log('PASS TypeScript SDK → isolated Sandbox: documented example, replay, public reads, final outcome, refund and typed error')
