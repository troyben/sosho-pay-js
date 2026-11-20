import { PublicSoshoPay } from '../dist/public.js'

const client = new PublicSoshoPay({ baseUrl: 'https://gateway.example', apiKey: 'pk_test_example' })
void client.getPayment('pay_example')
void client.listPaymentEvents('pay_example')
void client.listEvents({ limit: 10 })
// @ts-expect-error Browser clients expose no payment writes.
void client.createPayment({ amount: 100 })
// @ts-expect-error Browser clients expose no arbitrary request method.
void client.request('resetSandbox')
