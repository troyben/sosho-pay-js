#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { SoshoPay, ApiError, type components } from './index.js'
import { webhookPayload, type WebhookEvent } from './testing.js'
import { assertSafeNumbers } from './transport.js'

export function cliClient(env: NodeJS.ProcessEnv = process.env) {
  if (!/^sk_test_[A-Za-z0-9]+$/.test(env.SOSHO_SECRET_KEY ?? '')) throw new Error('The development CLI requires a Sandbox secret key in SOSHO_SECRET_KEY.')
  return new SoshoPay({ baseUrl: env.SOSHO_BASE_URL ?? '', apiKey: env.SOSHO_SECRET_KEY! })
}

function localTarget(target: string) {
  const url = new URL(target)
  // Literal loopback avoids DNS rebinding; no key or API auth is ever forwarded locally.
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('Forward only to an HTTP literal loopback URL (127.0.0.1 or [::1]), without credentials, query or fragment.')
  return url
}
type LocalOptions = { fetch?: typeof fetch; log?: (line: string) => void }
export async function forwardEvent(event: WebhookEvent, target: string, secret: string, options: LocalOptions = {}) {
  const url = localTarget(target)
  const fixture = webhookPayload(event, secret)
  const response = await (options.fetch ?? fetch)(url, { method: 'POST', headers: fixture.headers, body: fixture.body, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10_000) })
  await response.body?.cancel()
  options.log?.(`${event.id} ${event.type} -> HTTP ${response.status}`)
  if (!response.ok) throw new Error('Local handler did not acknowledge the event; cursor was not advanced. Replay it after fixing the handler.')
}

/** Finite SSE batches release the API worker; last acknowledged id resumes the next batch. */
export async function listen(client: SoshoPay, target: string, secret: string, options: LocalOptions & { batches?: number; delayMs?: number; signal?: AbortSignal; after?: string } = {}) {
  localTarget(target)
  let after = options.after
  for (let batch = 0; batch < (options.batches ?? Infinity) && !options.signal?.aborted; batch++) {
    const text = await client.request('streamEvents', { query: { after } })
    for (const frame of text.replaceAll('\r\n', '\n').split('\n\n')) {
      const line = frame.split('\n').find(item => item.startsWith('data: '))
      if (!line) continue
      const envelope = JSON.parse(line.slice(6))
      assertSafeNumbers(envelope)
      const event = envelope.data as components['schemas']['Event']
      if (!event || !/^evt_[A-Za-z0-9]+$/.test(event.id) || typeof event.type !== 'string') throw new Error('Invalid event stream frame.')
      await forwardEvent(event, target, secret, options)
      after = event.id
    }
    if (batch + 1 < (options.batches ?? Infinity) && !options.signal?.aborted) await new Promise(resolve => {
      const done = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', done); resolve(undefined) }
      const timer = setTimeout(done, options.delayMs ?? 2000)
      options.signal?.addEventListener('abort', done, { once: true })
    })
  }
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name)
  if (index < 0 || !args[index + 1] || args[index + 1]!.startsWith('--')) throw new Error(`Missing ${name}.`)
  return args[index + 1]!
}
async function main(args: string[]) {
  if (!args.length || args[0] === '--help') {
    console.log('Sandbox-only CLI. Set SOSHO_BASE_URL and SOSHO_SECRET_KEY on your server. No credentials are stored.\nCommands: login | listen --forward-to http://127.0.0.1:3000/webhooks [--after evt_ID] | events replay evt_ID --forward-to URL | payments create --file payment.json --idempotency-key ATTEMPT_KEY')
    return
  }
  const client = cliClient()
  if (args[0] === 'login' && args.length === 1) {
    await client.request('listCurrencies', {})
    console.log('Connected to Sandbox. Credentials remain in your environment; nothing was saved.')
  } else if (args[0] === 'payments' && args[1] === 'create') {
    const path = option(args, '--file')
    if ((await stat(path)).size > 1_048_576) throw new Error('Payment JSON must be under 1 MiB.')
    const body = JSON.parse(await readFile(path, 'utf8')) as components['schemas']['CreatePayment']
    const result = await client.createPayment(body, { idempotencyKey: option(args, '--idempotency-key') })
    console.log(`${result.data.id} ${result.data.status}`)
  } else if (args[0] === 'listen' || (args[0] === 'events' && args[1] === 'replay' && args[2])) {
    const target = option(args, '--forward-to')
    localTarget(target)
    const secret = process.env.SOSHO_LOCAL_WEBHOOK_SECRET ?? `whsec_${randomBytes(24).toString('hex')}`
    if (!process.env.SOSHO_LOCAL_WEBHOOK_SECRET) console.log(`Local-only signing secret (configure your handler): ${secret}`)
    if (args[0] === 'events') {
      const event = await client.request('getEvent', { path: { id: args[2]! } })
      await forwardEvent(event.data, target, secret, { log: console.log })
    } else {
      const controller = new AbortController()
      process.once('SIGINT', () => controller.abort())
      process.once('SIGTERM', () => controller.abort())
      await listen(client, target, secret, { log: console.log, signal: controller.signal, after: args.includes('--after') ? option(args, '--after') : undefined })
    }
  } else throw new Error('Unknown command. Run soshopay --help.')
}
function isEntrypoint(path: string | undefined): boolean {
  try { return Boolean(path && import.meta.url === pathToFileURL(realpathSync(path)).href) }
  catch { return false }
}
if (isEntrypoint(process.argv[1])) {
  main(process.argv.slice(2)).catch(error => {
    // Never print arbitrary transport errors, API messages, credentials or customer payloads.
    console.error(error instanceof ApiError ? `Gateway refused request: ${error.code}; request ${error.requestId ?? 'unknown'}.` : 'CLI failed. Check Sandbox configuration, command arguments and your local handler. Run soshopay --help.')
    process.exitCode = 1
  })
}
