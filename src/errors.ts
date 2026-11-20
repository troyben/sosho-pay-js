import type { components } from './schema.js'

export type ApiErrorCode = components['schemas']['ApiError']['code'] | (string & {})

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly requestId: string | null,
    public readonly param: string | null,
    public readonly idempotencyKey?: string,
  ) { super(message); this.name = 'ApiError' }
}

export class TransportError extends Error {
  constructor(public readonly idempotencyKey?: string) {
    super('The gateway response could not be obtained. Recover using the same idempotency key before creating another payment.')
    this.name = 'TransportError'
  }
}

export class ProtocolError extends Error {
  constructor(message = 'The gateway returned an invalid or unsafe response.', public readonly idempotencyKey?: string) {
    super(message); this.name = 'ProtocolError'
  }
}
