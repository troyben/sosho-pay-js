import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listen, forwardEvent, cliClient } from '../dist/cli.js'
import { createTestClient, webhookPayload } from '../dist/testing.js'
import { verifyWebhook } from '../dist/webhook.js'
import { mkdtemp, symlink, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

test('installed bin symlink executes CLI help rather than exiting silently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'soshopay-bin-'))
  const bin = join(directory, 'soshopay')
  await symlink(fileURLToPath(new URL('../dist/cli.js', import.meta.url)), bin)
  try {
    const result = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /Sandbox-only CLI/)
    assert.match(result.stdout, /Commands: login/)
  } finally {
    await unlink(bin)
    await rmdir(directory)
  }
})

const event = { id: 'evt_example', type: 'payment.succeeded', created_at: '2026-11-19T00:00:00Z', data: { id: 'pay_example', amount: 100 } }
test('offline test client captures the exact SDK request and signed payloads verify', async () => {
  const fake = createTestClient([{ data: event.data, meta: { request_id: 'req_test' } }])
  assert.equal((await fake.client.getPayment('pay_example')).data.amount, 100)
  assert.equal(fake.requests.length, 1)
  assert.equal(new URL(fake.requests[0].url).pathname, '/v1/payments/pay_example')
  const fixture = webhookPayload(event, 'whsec_local', 1800000000)
  assert.equal(verifyWebhook('whsec_local', fixture.body, fixture.headers['Soshopay-Signature'], 1800000000), true)
})
test('listener resumes only after successful local forwarding and prints no payload/secret', async () => {
  const cursors = [], logs = [], forwarded = []
  const client = { request: async (_op, input) => {
    cursors.push(input.query.after)
    return cursors.length === 1 ? `id: ${event.id}\ndata: ${JSON.stringify({ data: event, meta: {} })}\n\n` : ': heartbeat\n\n'
  } }
  await listen(client, 'http://127.0.0.1:3000/webhooks', 'whsec_local', { batches: 2, delayMs: 0, log: line => logs.push(line), fetch: async (url, init) => {
    forwarded.push({ url, init }); return new Response(null, { status: 204 })
  } })
  assert.deepEqual(cursors, [undefined, event.id])
  assert.equal(forwarded.length, 1)
  assert.equal(logs.join('').includes('whsec_'), false)
  assert.equal(logs.join('').includes('amount'), false)
})
test('forwarding refuses remote/credentialed targets, redirects and unsafe keys before network access', async () => {
  for (const target of ['https://remote.test/hook', 'http://localhost:3000/hook', 'http://user:pass@127.0.0.1/hook', 'http://127.0.0.1/hook?secret=x']) {
    await assert.rejects(forwardEvent(event, target, 'whsec_local', { fetch: () => { throw new Error('must not call') } }))
  }
  assert.throws(() => cliClient({ SOSHO_BASE_URL: 'https://gateway.example', SOSHO_SECRET_KEY: 'sk_live_SENTINEL' }), error => !error.message.includes('SENTINEL'))
  await assert.rejects(forwardEvent(event, 'http://127.0.0.1:3000/hook', 'whsec_local', { fetch: async (_url, init) => {
    assert.equal(init.redirect, 'error'); return new Response('', { status: 302 })
  } }))
})
test('unsafe integer SSE is refused before signing, forwarding or advancing the cursor', async () => {
  let calls = 0, batches = 0
  const client = { request: async () => {
    batches++
    return 'id: evt_example\ndata: {"data":{"id":"evt_example","type":"payment.succeeded","data":{"amount":9007199254740993}}}\n\n'
  } }
  await assert.rejects(listen(client, 'http://127.0.0.1:3000/hook', 'whsec_local', { batches: 2, delayMs: 0, fetch: async () => { calls++; return new Response() } }), /safe range/)
  assert.equal(calls, 0)
  assert.equal(batches, 1)
})
