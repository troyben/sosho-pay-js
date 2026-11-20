import { Transport, type ClientOptions } from './transport.js'
import type { OperationTypes } from './operations.js'
export { ApiError, TransportError, ProtocolError } from './errors.js'
export type { components } from './schema.js'

/** No secret-key client, writes, webhook secrets or node imports in this entry. */
export class PublicSoshoPay {
  #transport: Transport
  constructor(options: ClientOptions) { this.#transport = new Transport(options, 'pk') }
  getPayment(id: string) { return this.#transport.execute('getPayment', { path: { id } }) }
  listPaymentEvents(id: string) { return this.#transport.execute('listPaymentEvents', { path: { id } }) }
  listEvents(query?: OperationTypes['listEvents']['input']['query']) { return this.#transport.execute('listEvents', { query }) }
}
