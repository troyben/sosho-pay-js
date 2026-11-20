import { Transport, type ClientOptions, type OperationName, type RequestOptions } from './transport.js'
import type { OperationTypes } from './operations.js'
import type { components } from './schema.js'
export { ApiError, TransportError, ProtocolError } from './errors.js'
export { verifyWebhook } from './webhook.js'
export type { ClientOptions, RequestOptions, OperationName, OperationTypes, components }

/** Server-only entry. The ./public entry exposes only CORS-supported reads. */
export class SoshoPay {
  #transport: Transport
  constructor(options: ClientOptions) {
    if (typeof window !== 'undefined') throw new TypeError('Secret keys belong on your server. Use @soshopay/sdk/public in a browser.')
    this.#transport = new Transport(options, 'sk')
  }
  request<K extends OperationName>(operation: K, input: OperationTypes[K]['input'], options?: RequestOptions) {
    return this.#transport.execute(operation, input, options)
  }
  createPayment(body: components['schemas']['CreatePayment'], options?: RequestOptions) { return this.request('createPayment', { body }, options) }
  getPayment(id: string) { return this.request('getPayment', { path: { id } }) }
  createRefund(id: string, body: components['schemas']['CreateRefund'] = {}, options?: RequestOptions) { return this.request('createRefund', { path: { id }, body }, options) }
}
