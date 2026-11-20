import { SoshoPay } from '../dist/index.js'
import { pathToFileURL } from 'node:url'

export async function paymentExample(client, idempotencyKey) {
  return client.createPayment({
    amount: 100, currency: 'USD', rail: 'ecocash',
    customer: { msisdn: '+263770000001' }, reference: 'SDK-QUICKSTART',
  }, { idempotencyKey })
}

// On your server: const client = new SoshoPay({
//   baseUrl: process.env.SOSHO_BASE_URL, apiKey: process.env.SOSHO_SECRET_KEY,
// })
// Persist a unique key on the order before sending, then:
// const { data } = await paymentExample(client, order.paymentAttemptKey)
// const current = await client.getPayment(data.id) // pending is not success
export { SoshoPay }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { SOSHO_BASE_URL: baseUrl, SOSHO_SECRET_KEY: apiKey, SOSHO_IDEMPOTENCY_KEY: key } = process.env
  if (!baseUrl || !apiKey?.startsWith('sk_test_') || !key) throw new Error('Set SOSHO_BASE_URL, a Sandbox SOSHO_SECRET_KEY and a durable SOSHO_IDEMPOTENCY_KEY on your server.')
  const client = new SoshoPay({ baseUrl, apiKey })
  const created = await paymentExample(client, key)
  let current = created
  for (let attempt = 0; attempt < 30 && ['created', 'pending'].includes(current.data.status); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1_000))
    current = await client.getPayment(created.data.id)
  }
  console.log(JSON.stringify(current, null, 2))
  if (current.data.status !== 'succeeded') process.exitCode = 1
}
