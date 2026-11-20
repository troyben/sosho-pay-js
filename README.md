# Soshopay TypeScript SDK 1.0.0

Node 22+; native fetch, no runtime dependencies. The server entry includes Node crypto.
The separate `@soshopay/sdk/public` entry contains no Node imports or secret-key writes.

Install in your application after the first public registry release:

```sh
npm install @soshopay/sdk
npx --no-install soshopay --help
```

The first public release is pending; the command becomes available when version 1.0.0 is
published to npm. Until then, install the downloadable tarball. From an SDK source checkout:

```sh
cd sdks/typescript
npm ci
npm run build
npm test
npm pack
# In your integration project: npm install /absolute/path/soshopay-sdk-1.0.0.tgz
```

The downloadable tarball is also available in the dashboard's Developers downloads. Set
`SOSHO_BASE_URL`, a Sandbox `SOSHO_SECRET_KEY` and a durable `SOSHO_IDEMPOTENCY_KEY`, then run
`node node_modules/@soshopay/sdk/examples/payment.mjs` in the consuming application. It refuses
Live keys and polls up to 30 times, exiting successfully only when the payment succeeds.

```typescript
import { SoshoPay, ApiError } from '@soshopay/sdk'
const client = new SoshoPay({
  baseUrl: process.env.SOSHO_BASE_URL!, // HTTPS origin, no /v1 suffix
  apiKey: process.env.SOSHO_SECRET_KEY!,
})
// Persist a unique attempt key with your order BEFORE sending.
const result = await client.createPayment({
  amount: 100, currency: 'USD', rail: 'ecocash',
  customer: { msisdn: '+263770000001' }, reference: 'ORDER-1',
}, { idempotencyKey: order.paymentAttemptKey })
const payment = await client.getPayment(result.data.id)
// Only payment.data.status === 'succeeded' authorizes fulfillment.
```

`client.request(operationId, {path, query, body}, options)` exposes every generated operation.
Examples: `request('listPayments', {query: {limit: 20}})`;
`request('getWebhookDelivery', {path: {id: endpointId, deliveryId}})`;
`request('downloadSettlementStatement', {path: {id: batchId}})` returns a `Uint8Array`.
`streamEvents` returns a finite SSE text batch. Other operations return the full `data`/`meta` envelope. Use `meta.next_cursor` for pagination.
Money is integer minor units, and unsafe JSON integers are rejected rather than rounded.
API types and route/retry metadata are generated from the committed OpenAPI; do not edit them.

`maxRetries` is 0–2 (default 2), `timeoutMs` 1–120000 (default 15000 per attempt).
Only GET or server-idempotent payment/refund writes retry network failures/5xx. No 4xx retries;
no automatic retries of webhook-management or Sandbox writes. One key and serialized body are
preserved. An omitted payment/refund key is random; recover using the exception's
`idempotencyKey`, and use durable caller keys for real orders. Never assume a failed transport
means no charge occurred. HTTPS is required except loopback development; redirects are refused.

`ApiError` exposes `status`, `code`, `requestId`, `param`, `idempotencyKey`.
`TransportError` and `ProtocolError` are separate. Catch known error codes and handle unknown
ones safely; do not expose server messages or secrets in customer-facing logs.

```typescript
import { verifyWebhook } from '@soshopay/sdk'
const valid = verifyWebhook(secret, rawRequestBytes, signatureHeader)
// Parse only after verification; deduplicate event IDs in a durable inbox.
```

Verification uses exact raw bytes, HMAC-SHA256, constant-time comparison and a maximum
five-minute past/future window. Never disable timestamp checks. Use a separate webhook secret.

```typescript
import { PublicSoshoPay } from '@soshopay/sdk/public'
const publicClient = new PublicSoshoPay({baseUrl, apiKey: 'pk_test_...actualKey'})
await publicClient.getPayment(paymentId)
```

Only `getPayment`, `listPaymentEvents`, `listEvents` are exposed, matching gateway CORS.
Publishable keys are merchant-scoped; enforce customer/order ownership in your own application.

`examples/payment.mjs` is executed by unit and isolated-Sandbox CI contract tests and embedded
in the docs/PDF. `tests/sandbox.contract.mjs` refuses any target except the isolated CI loopback
Sandbox; it is not a Live diagnostic. See `/docs/` on the gateway for the complete guides.

## CLI and offline fixtures

The tarball includes `soshopay`: run `npx --no-install soshopay --help`. Commands are `login`,
`payments create --file payment.json --idempotency-key ATTEMPT`, `listen --forward-to
http://127.0.0.1:3000/webhooks`, and `events replay evt_ID --forward-to URL`. All require Sandbox
keys in the environment. Login validates the connection without persisting credentials. Listener/replay
use a local-only signing secret (`SOSHO_LOCAL_WEBHOOK_SECRET`, or a random secret printed once),
the production body/signature format, and literal loopback forwarding without redirects. No API key
is sent locally. Use idempotent handlers and `--after evt_ID` to resume listening. See the CLI guide.

`@soshopay/sdk/testing` exports `createTestClient([envelopeOrResponse, ...])`, returning a real
client and captured `requests` without network access, plus `webhookPayload(event, localSecret,
timestamp)` for signed offline handler fixtures. These helpers do not simulate gateway state.

## License

MIT. See [LICENSE](./LICENSE). This license covers this SDK, not the gateway application.
