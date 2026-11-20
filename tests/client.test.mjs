import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { SoshoPay, ApiError, TransportError, ProtocolError, verifyWebhook } from '../dist/index.js'
import { PublicSoshoPay } from '../dist/public.js'
import { paymentExample } from '../examples/payment.mjs'

const envelope = { data: { id: 'pay_contract', status: 'pending', amount: 100 }, meta: { request_id: 'req_contract', mode: 'sandbox' } }
function setup(responses, maxRetries = 2) {
  const calls = []
  const fetch = async (url, options) => {
    calls.push({ url: String(url), ...options })
    const next = responses.shift()
    if (next instanceof Error) throw next
    return new Response(JSON.stringify(next?.body ?? envelope), { status: next?.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  }
  const client = new SoshoPay({ baseUrl: 'https://gateway.example.com', apiKey: 'sk_test_contract', fetch, maxRetries })
  return { client, calls, fetch }
}

describe('server SDK', () => {
  it('refuses a misconfigured Live contract key without printing it or making network calls', () => {
    const sentinel = 'sk_live_NEVER_PRINT_THIS_CREDENTIAL'
    for (const script of ['tests/sandbox.contract.mjs', 'examples/payment.mjs']) {
    const result = spawnSync(process.execPath, [script], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
      env: { ...process.env, SOSHO_BASE_URL: 'http://localhost:18080', SOSHO_SECRET_KEY: sentinel, SOSHO_PUBLISHABLE_KEY: 'pk_test_contract' },
      timeout: 5000,
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Sandbox/)
    assert.equal((result.stdout + result.stderr).includes(sentinel), false)
    }
  })
  it('executes the exact documented example and preserves the envelope', async () => {
    const { client, calls } = setup([{}])
    assert.deepEqual(await paymentExample(client, 'order-attempt'), envelope)
    assert.deepEqual(JSON.parse(calls[0].body), { amount: 100, currency: 'USD', rail: 'ecocash', customer: { msisdn: '+263770000001' }, reference: 'SDK-QUICKSTART' })
    assert.equal(calls[0].headers['Idempotency-Key'], 'order-attempt')
    assert.equal(calls[0].redirect, 'error')
    assert.equal(calls[0].credentials, 'omit')
  })
  it('retries network and 5xx using one generated key and unchanged body', async () => {
    const { client, calls } = setup([new TypeError('network'), { status: 503 }, {}])
    await paymentExample(client)
    assert.equal(calls.length, 3)
    assert.equal(new Set(calls.map(c => c.headers['Idempotency-Key'])).size, 1)
    assert.ok(calls[0].headers['Idempotency-Key'])
    assert.equal(new Set(calls.map(c => c.body)).size, 1)
  })
  for (const status of [400, 401, 403, 409, 422, 429]) {
    it(`never retries ${status} and exposes a typed code/request id`, async () => {
      const { client, calls } = setup([{ status, body: { error: { code: 'in_flight', message: 'Wait', request_id: 'req_error', param: null } } }])
      await assert.rejects(paymentExample(client, 'recover-me'), error => error instanceof ApiError && error.code === 'in_flight' && error.requestId === 'req_error' && error.status === status && error.idempotencyKey === 'recover-me')
      assert.equal(calls.length, 1)
    })
  }
  it('does not retry a non-idempotent webhook or Sandbox write', async () => {
    for (const operation of ['testWebhookEndpoint', 'approveSandboxPayment']) {
      const { client, calls } = setup([{ status: 503 }])
      await assert.rejects(client.request(operation, { path: { id: 'obj_contract' } }), ApiError)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].headers['Idempotency-Key'], undefined)
    }
  })
  it('returns the recovery key after exhausted network attempts', async () => {
    const { client, calls } = setup([new TypeError(), new TypeError(), new TypeError()])
    await assert.rejects(paymentExample(client, 'durable-key'), error => error instanceof TransportError && error.idempotencyKey === 'durable-key')
    assert.equal(calls.length, 3)
    assert.ok(!JSON.stringify(client).includes('sk_test_contract'))
  })
  it('rejects unsafe numbers and malformed envelopes instead of returning rounded money', async () => {
    const { client } = setup([{ body: { data: { amount: 9007199254740992 }, meta: {} } }, { body: {} }])
    await assert.rejects(client.getPayment('pay_contract'), ProtocolError)
    await assert.rejects(client.getPayment('pay_contract'), ProtocolError)
  })
  it('refuses credential-bearing URLs, insecure remote hosts, traversal and invalid retry settings', async () => {
    for (const baseUrl of ['http://remote.example.com', 'https://user:pass@host', 'https://host/path', 'https://host?x=y', 'https://host/#fragment']) {
      assert.throws(() => new SoshoPay({ baseUrl, apiKey: 'sk_test_contract' }), TypeError)
    }
    assert.throws(() => new SoshoPay({ baseUrl: 'https://host', apiKey: 'pk_test_public' }), TypeError)
    assert.throws(() => new SoshoPay({ baseUrl: 'https://host', apiKey: 'sk_test_contract', maxRetries: 3 }), TypeError)
    const { client, calls } = setup([])
    await assert.rejects(client.getPayment('../payments'), TypeError)
    assert.equal(calls.length, 0)
  })
})

describe('publishable client', () => {
  it('has only the three CORS-supported read operations and rejects secret keys', async () => {
    const { fetch, calls } = setup([{}])
    const client = new PublicSoshoPay({ baseUrl: 'https://host', apiKey: 'pk_test_public', fetch })
    await client.getPayment('pay_contract')
    assert.equal(calls[0].method, 'GET')
    assert.equal(typeof client.createPayment, 'undefined')
    assert.equal(typeof client.request, 'undefined')
    assert.throws(() => new PublicSoshoPay({ baseUrl: 'https://host', apiKey: 'sk_test_secret' }), TypeError)
  })
})

describe('webhook verification', () => {
  const secret = 'whsec_contract'
  const raw = '{"id":"evt_1", "amount":100}'
  const timestamp = 1_800_000_000
  const header = `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')}`
  it('accepts the raw body and boundary timestamp', () => {
    assert.equal(verifyWebhook(secret, raw, header, timestamp), true)
    assert.equal(verifyWebhook(secret, Buffer.from(raw), header, timestamp + 300), true)
  })
  it('rejects tampering, parsing/reserializing, stale/future headers and disabled tolerance', () => {
    assert.equal(verifyWebhook(secret, raw + ' ', header, timestamp), false)
    assert.equal(verifyWebhook(secret, JSON.stringify(JSON.parse(raw)), header, timestamp), false)
    for (const now of [timestamp - 301, timestamp + 301]) assert.equal(verifyWebhook(secret, raw, header, now), false)
    assert.equal(verifyWebhook(secret, raw, header, timestamp, 0), false)
    assert.equal(verifyWebhook(secret, raw, header + ',v1=bad', timestamp), false)
    assert.equal(verifyWebhook('whsec_wrong', raw, header, timestamp), false)
    assert.equal(verifyWebhook(secret, raw, null, timestamp), false)
  })
})
