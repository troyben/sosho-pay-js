import { ApiError, ProtocolError, TransportError } from './errors.js'
import { routes, type OperationTypes } from './operations.js'

export interface ClientOptions {
  baseUrl: string
  apiKey: string
  /** Additional attempts, 0–2. Only GET or server-idempotent writes are retried. */
  maxRetries?: number
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}
export interface RequestOptions { idempotencyKey?: string }
export type OperationName = keyof OperationTypes

export function assertSafeNumbers(value: unknown): void {
  if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new ProtocolError('A JSON number exceeds the SDK’s safe range; no rounded monetary value was accepted.')
  }
  if (value && typeof value === 'object') for (const item of Object.values(value)) assertSafeNumbers(item)
}

/** Shared transport has no public raw-path or header override. */
export class Transport {
  #key: string
  #base: URL
  #fetch: typeof globalThis.fetch
  #retries: number
  #timeout: number

  constructor(options: ClientOptions, kind: 'sk' | 'pk') {
    const base = new URL(options.baseUrl)
    if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
      throw new TypeError('Use an HTTPS gateway origin without a path, query, fragment or credentials (HTTP is allowed only for loopback development).')
    }
    if (!new RegExp(`^${kind}_(test|live)_[A-Za-z0-9]+$`).test(options.apiKey)) throw new TypeError(`A ${kind === 'sk' ? 'secret' : 'publishable'} API key is required.`)
    const retries = options.maxRetries ?? 2
    const timeout = options.timeoutMs ?? 15_000
    if (!Number.isInteger(retries) || retries < 0 || retries > 2 || !Number.isInteger(timeout) || timeout < 1 || timeout > 120_000) throw new TypeError('Invalid bounded retry or timeout configuration.')
    this.#key = options.apiKey
    this.#base = base
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#retries = retries
    this.#timeout = timeout
  }

  async execute<K extends OperationName>(operation: K, input: OperationTypes[K]['input'], options: RequestOptions = {}): Promise<OperationTypes[K]['response']> {
    const route = routes[operation]
    if (!route) throw new TypeError('Unknown API operation.')
    const args = input as { path?: Record<string, string>; query?: Record<string, string | number | boolean | undefined>; body?: unknown }
    const path = route.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
      const value = args.path?.[name]
      if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('An API object id is required; paths and URLs are not accepted.')
      return encodeURIComponent(value)
    })
    const url = new URL(path, this.#base)
    for (const [name, value] of Object.entries(args.query ?? {})) if (value !== undefined) url.searchParams.set(name, String(value))
    assertSafeNumbers(args.body)
    if (args.body && typeof args.body === 'object' && 'amount' in args.body && args.body.amount !== null && !Number.isSafeInteger(args.body.amount)) throw new TypeError('amount must be integer minor units.')
    const body = args.body === undefined ? undefined : JSON.stringify(args.body)
    const key = route.idempotent ? options.idempotencyKey ?? globalThis.crypto.randomUUID() : undefined
    if (key !== undefined && (!key.trim() || key !== key.trim() || key.length > 255 || /[^\x21-\x7e]/.test(key))) throw new TypeError('Use an ASCII idempotency key with 1–255 visible characters.')
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#key}`, Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (key) headers['Idempotency-Key'] = key
    const attempts = route.method === 'GET' || route.idempotent ? this.#retries : 0
    for (let attempt = 0; attempt <= attempts; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 100 * 2 ** (attempt - 1)))
      let response: Response
      try {
        response = await this.#fetch(url, { method: route.method, headers, body, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(this.#timeout) })
      } catch {
        if (attempt < attempts) continue
        throw new TransportError(key)
      }
      if (response.status >= 500 && response.status <= 599 && attempt < attempts) { await response.body?.cancel(); continue }
      if (response.ok && operation === 'downloadSettlementStatement') return new Uint8Array(await response.arrayBuffer()) as OperationTypes[K]['response']
      if (response.ok && operation === 'streamEvents') return await response.text() as OperationTypes[K]['response']
      let decoded: unknown
      try { decoded = await response.json(); assertSafeNumbers(decoded) } catch { throw new ProtocolError(undefined, key) }
      const envelope = decoded as { data?: unknown; meta?: { request_id?: string | null }; error?: { code?: string; type?: string; message?: string; request_id?: string | null; param?: string | null } } | null
      if (!response.ok) {
        const error = envelope?.error
        throw new ApiError(response.status, error?.code ?? 'unknown_error', error?.message ?? 'The gateway refused the request.', error?.request_id ?? response.headers.get('X-Request-Id'), error?.param ?? null, key)
      }
      if (!envelope || !Object.hasOwn(envelope, 'data') || !envelope.meta) throw new ProtocolError(undefined, key)
      return decoded as OperationTypes[K]['response']
    }
    throw new TransportError(key)
  }
}
