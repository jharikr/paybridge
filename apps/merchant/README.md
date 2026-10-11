# Sample merchant orders and payments

The sample keeps orders, payment bindings, and outgoing commands in its own SQLite database. Both synthetic merchants use the same application. Each fixture route selects that merchant's server-side Paybridge credential. The application communicates with Paybridge only over HTTP.

Run the API with Node after `bun install --frozen-lockfile`:

```sh
node apps/merchant/server.ts .data/merchant.db 3101 http://127.0.0.1:3100 http://127.0.0.1:3101
```

The arguments are database path, listening port, Paybridge origin, and advertised merchant origin. Defaults match the command above. Port `0` chooses an ephemeral listening port for tests. Advertised origins are explicit because Paybridge's allowed return origin and registered webhook destination must match them. Seeded configuration remains fixed for the lifetime of the records. Starting a process never resets its database.

The contexts are `merchant-a` and `merchant-b`, with synthetic Paybridge credentials `mock-paybridge-key-a` and `mock-paybridge-key-b`. Return destinations are `/{merchantFixture}/payment-return`; registered callbacks are `/api/webhooks/paybridge/{merchantFixture}`. The return handler verifies the bound order; ticket 10 adds callback receipt. Fixture routes select a local demo context; they are not merchant login or production authentication.

## HTTP flow

All routes return `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. `/openapi.json` describes the requests, responses, and response headers, including command identity, lookup location, and temporary-failure retry timing. Bodies reject additional fields, including credentials, payment IDs, and real card fields. Bodyless commands reject a supplied body. Order and command IDs from another context return a generic not-found error.

| Method and route                                                        | Input and result                                                                                                                                                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /{merchantFixture}/orders`                                        | JSON `businessReference`, integer minor-unit `amount`, `currency: "XCD"`, and optional `description`. Returns `201` with a new order or `200` for identical input under the same reference. Changed financial input conflicts. |
| `GET /{merchantFixture}/orders/{orderId}`                               | Local order, owner, business input, paid state, and optional bound intent ID.                                                                                                                                                  |
| `POST /{merchantFixture}/orders/{orderId}/payment`                      | No body. Prepares or resumes creation and returns its exact `201` acknowledgment. Repeats reuse the same intent binding, including after cancellation or an unknown outcome.                                                   |
| `GET /{merchantFixture}/orders/{orderId}/payment`                       | Retrieves the bound intent's current Paybridge snapshot with the owning merchant's credential. Applies its common payment facts through the shared snapshot transaction and returns the full lookup response.                  |
| `GET /{merchantFixture}/payment-return?paymentId=...`                   | Checks the receiving fixture and known order binding. Returns the local order-paid state and its accepted payment snapshot, refreshing through authenticated Paybridge lookup when needed.                                     |
| `POST /{merchantFixture}/orders/{orderId}/confirm`                      | JSON `commandNumber`, `mockPaymentMethodRef`, and `expectedRevision`. Returns the original `202` acceptance or a retained rejection.                                                                                           |
| `GET /{merchantFixture}/orders/{orderId}/commands`                      | Lists command IDs, operations, numbers, and PREPARED/COMPLETED status. Does not expose credentials, request bodies, or cached checkout capabilities.                                                                           |
| `POST /{merchantFixture}/orders/{orderId}/commands/{commandId}/recover` | No body. Resends the exact stored command and key or returns its cached acknowledgment.                                                                                                                                        |

Creation and confirmation acknowledgments include `X-Merchant-Command-Id` and retain Paybridge's `Location`. They establish the original command's acceptance, not its current financial outcome. The sensitive creation acknowledgment includes a checkout capability, so cached bodies are retained locally but excluded from diagnostics.

A confirmation example:

```json
{
  "commandNumber": 1,
  "mockPaymentMethodRef": "pm_mock_declined",
  "expectedRevision": 1
}
```

After lookup establishes FAILED at revision 3, a deliberate confirmation can use command number 2, `pm_mock_approved`, and expected revision 3. Each new command takes the next number and gets a new stable key. Command numbers count instructions, including rejected instructions. They do not count financial attempts. Repeating an old number with changed input conflicts. A PREPARED confirmation must be recovered before starting another number.

A stale-revision rejection is retained as a completed command. Read the current payment, then submit a deliberate new command number if appropriate. A read never resubmits anything. Paybridge guards PROCESSING, UNKNOWN, SUCCEEDED, and CANCELLED against new attempts. The sample never creates another intent to bypass those states.

## Durable boundaries

Before HTTP, a short transaction stores the normalized request bytes, route, operation, command number, merchant/order ownership, and generated idempotency key as PREPARED. Both supported operations use POST. Creation always has command number 1. No external call occurs inside a database transaction.

After validating the response against the owning order and expected command, another transaction stores the exact acknowledgment body, status, and relevant headers. Successful creation stores its intent binding in that same transaction. Only then is the command COMPLETED. Confirmation cannot proceed without the committed binding. Terminal HTTP rejections are retained too. Transport failure, timeout, transient server failure, rate limiting, and an in-progress remote command leave PREPARED work for exact recovery. Temporary unavailability returns `503` and `Retry-After: 1`.

The merchant HTTP client bounds the full response to 16,384 bytes and a three-second deadline, follows no redirects, and validates JSON at the boundary. Paybridge credentials and response bodies do not enter logs. A restarted caller can list commands and explicitly recover one, or repeat its original create/confirm call. There is no outgoing scheduler or automatic retry with a new key.

Database constraints scope business references and keys to the merchant, enforce order ownership, permit one intent binding per order, and prevent multiple PREPARED commands for one order/operation. Triggers retain records, freeze order financial input and command identity, preserve completed acknowledgments, and guard payment binding identity. Startup warms Prisma's contract marker outside command transactions; multi-row commands acquire the SQLite write lock before reading their guarded state. Contention is bounded by the installed driver's five-second busy timeout.

Payment bindings start with a null local snapshot and applied revision 0. Acknowledgments never write that view or pay an order. `applyPaymentSnapshot` in `snapshots.ts` accepts a validated common snapshot and the receiving merchant inside an existing merchant transaction. It acquires the write lock before reading, checks the payment/order owner, amount, currency, and business reference, then applies only a newer revision. A successful snapshot updates the order to PAID in that transaction. Equal or older revisions preserve the accepted view and original paid timestamp; revision gaps are valid. Ticket 11 can include receipt completion in the same transaction.

Lookup and return use this operation. Return refreshes PENDING, PROCESSING, UNKNOWN, and FAILED through Paybridge HTTP; FAILED can legitimately advance to PROCESSING after a deliberate retry. SUCCEEDED and CANCELLED can use the retained final local snapshot. A return query never supplies financial facts or creates a binding. The result contains only facts common to lookup and notifications, without invented attempt details or timestamps. The ordinary payment lookup still returns the full received Paybridge response, while a delayed response cannot regress the locally accepted revision. External fulfillment is out of scope.

## Verification

The merchant tests launch real Node APIs and provider workers with separate synthetic databases. They inspect independently persisted records and mock effects. Cases cover both merchants sharing a reference, ownership substitution, strict payloads, OpenAPI, immutable constraints, declined-then-approved attempts, cancelled/unknown binding retention, stale commands, concurrent processes, bounded contention, and local completion rollback.

Recovery tests send SIGKILL before send, after response receipt, and inside local completion. They also lose a response after remote commit and restart both the caller and Paybridge API. Recovery preserves exact acknowledgment bytes, the original key/request, one intent binding, and one attempt per accepted command.

Checkout and return tests also hold a real lookup response until newer revisions apply, race return and lookup across merchant processes, and kill a merchant during the snapshot transaction. They prove retained ownership, unchanged records on rejection or rollback, revision-gap acceptance, and a single durable paid timestamp. IPC coordination exists only in test fixtures; it exposes no product control route.
