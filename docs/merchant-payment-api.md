# Merchant payment commands and lookup

Run `node apps/paybridge/server.ts` from the repository root. The local server binds `127.0.0.1:3100`, migrates `.data/paybridge.db`, and inserts the two synthetic merchants if absent. Optional positional arguments choose a database path and port. `MERCHANT_ORIGIN` and `PAYBRIDGE_ORIGIN` select absolute service origins; defaults are `http://127.0.0.1:3101` and `http://127.0.0.1:3100`. HTTP configuration accepts loopback hosts only. Existing merchant records keep their original configuration and active status across restarts.

The fixtures are synthetic. Merchant A uses ID `merchant-a`, API credential `mock-paybridge-key-a`, provider account `mock-account-a`, and provider merchant key `mock-provider-key-a`. Merchant B uses the corresponding `-b` values. Paybridge stores SHA-256 hashes of the API credentials. Provider merchant keys live in the server-only provider account configuration. Webhook signing secrets are `mock-webhook-secret-a` and `mock-webhook-secret-b`, stored separately from API credentials. Destinations are `/api/webhooks/paybridge/merchant-a` and `/api/webhooks/paybridge/merchant-b` at the configured merchant origin. Both merchants use that origin for return URLs.

## Creation

`POST /v1/payment-intents` requires `Authorization: Bearer <Paybridge API credential>`, an `Idempotency-Key` of 1 to 128 characters, and `Content-Type: application/json`.

```json
{
  "merchantReference": "REG-2026-00124",
  "amount": 7500,
  "currency": "XCD",
  "description": "Nursing registration",
  "returnUrl": "http://127.0.0.1:3101/payment-return"
}
```

XCD is the only supported currency and has two minor-unit decimal places. Amounts must be positive integers at most 9,999,999,999 minor units. This ceiling is a mock-adapter choice, not a verified live-provider limit. References contain 1 to 128 UTF-16 code units. Optional descriptions contain at most 256. Return URLs contain at most 2048, belong to the merchant's configured origin, and contain no URL credentials or fragment. NUL and unpaired Unicode surrogates are rejected in persisted text, and return URLs also reject control characters. Accepted text is preserved unchanged. Extra body and query fields are rejected, including card payloads and provider-account overrides. Descriptions remain inert text.

A committed creation returns `201`, a lookup `Location`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and the public payment snapshot plus `checkoutUrl`. The snapshot starts at PENDING, revision 1, with null `latestAttempt`. The checkout URL contains a random 256-bit capability bound to that payment. The separate authorization column stores its hash. The cached creation body retains the usable capability so replay can recover it. That cached body is sensitive local payment data and must stay out of logs and diagnostics. The [sample merchant guide](../apps/merchant/README.md) covers headless checkout and verified return.

Command identity is scoped to the authenticated merchant and key. The request hash includes the operation, HTTP method, normalized route, and recursively key-sorted validated input. It excludes credentials and request tracing. Repeating the same command returns its original status, body bytes, and relevant headers. Changing the command input returns `409 idempotency_conflict`. An observable unfinished reservation returns `409 command_in_progress` and `Retry-After: 1`. A SQLite writer timeout returns `503 temporarily_unavailable` and `Retry-After: 1`; repeat the original command and key.

One short transaction reserves the key, checks invoice uniqueness, creates the intent and PAYMENT_CREATED history, and records the completed acknowledgment. Startup verifies Prisma's contract marker with a nontransactional query. The reservation then acquires write access before dependent reads because the selected SQLite driver begins deferred transactions. Invoice allocation retries at most five random candidates; a database unique constraint also protects the value. Amount, currency, reference, provider invoice, description, merchant ownership, checkout hash, and return URL cannot be edited. Repeated merchant references under different keys create distinct intents, including within one merchant.

## Confirmation

`POST /v1/payment-intents/{paymentId}/confirm` requires the merchant's Bearer credential, an `Idempotency-Key`, and this strict JSON body:

```json
{
  "mockPaymentMethodRef": "pm_mock_approved",
  "expectedRevision": 1
}
```

The synthetic reference must be one of the controlled fixtures in `contracts/fourcs.ts`. Card fields and provider-account overrides are rejected. The revision must be a positive safe integer. The command hash includes the reference, expected revision, operation, method, and normalized payment target. Matching completed commands return their exact cached acknowledgment before checking current state. Reusing the key for a changed reference, revision, payment, or operation returns `409 idempotency_conflict`.

A new confirmation requires PENDING or definite FAILED, the current revision, and no PROCESSING or UNKNOWN attempt. An old revision returns `409 payment_revision_conflict`; an unacceptable state returns `409 payment_not_confirmable`. The client must obtain a deliberate new confirmation after refreshing a stale view. Paybridge does not turn a stale instruction into another attempt automatically.

One transaction reserves the key, guards the payment, allocates the next attempt number and a unique 16-character alphanumeric provider transaction ID, persists the owning provider account and synthetic input, moves the payment to PROCESSING, increments its revision, appends ATTEMPT_CREATED history, enqueues provider work, and caches the completed acknowledgment. A rejection rolls back its key reservation. The partial unique index permits at most one unresolved attempt per intent. Provider transaction identity, account, attempt number, and synthetic input cannot change afterward.

The response is `202 Accepted`, with the lookup `Location`, `Cache-Control: no-store`, and the exact accepted attempt ID, attempt number, PROCESSING status, revision, and status URL. This acknowledges queued work, not approval. The worker can be stopped while commands are accepted. No provider call occurs in this transaction, and provider completion does not replace the cached 202. After a definite failure, a deliberate new key and the current failed revision can create another attempt. A delayed key using the earlier revision still conflicts. See [provider worker](provider-worker.md) for execution and outcome rules.

## Cancellation

`POST /v1/payment-intents/{paymentId}/cancel` requires the merchant's Bearer credential. It has no request body and needs no command key. Only PENDING can change to CANCELLED. The transaction increments the revision, appends PAYMENT_CANCELLED history, and stores one `payment.cancelled` webhook payload with the exact event identity and payment snapshot. Repeating cancellation returns the unchanged 200 snapshot without a new event, revision, or webhook. Other states return `409 payment_not_cancellable`.

Cancellation and confirmation compete through database writes. Only one can win for a pending payment. The losing command retains no partial attempt, reservation, event, or webhook. Cancellation is permanent; a payer leaving checkout does not call this operation.

## Lookup

`GET /v1/payment-intents/{paymentId}` requires the merchant's Bearer credential and returns the current persisted public snapshot with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. It does not contact the provider. An absent payment and one belonging to another merchant both return `404 payment_not_found`. Lookup includes the latest attempt ID, number, status, and an optional sanitized failure code when an attempt exists. It never includes the checkout capability, provider invoice or transaction ID, merchant configuration, or credentials.

`GET /openapi.json` describes the actual routes, Bearer authentication, command-key header, response headers, bounds, and JSON errors. String limits use UTF-16 code units at runtime while JSON Schema counts Unicode code points. Return-origin authorization is contextual and is documented in the URL schema. Each error has `error.code`, `error.message`, and a generated `error.requestId`.

## Persistence and verification

Prisma owns the database contract and migration history in `apps/paybridge/`. The initial migration adds SQLite checks, ownership foreign keys, unique indexes, and triggers for immutable inputs, revision coupling, append-only history, and retention of completed acknowledgments. These constraints exceed what this Prisma contract authoring release can express; keep their behavioral checks when extending migrations. Payment records, history, command identities, and cached responses remain for the lifetime of prototype data. No reset or purge command is provided.

`bun run test tests/payments` exercises real HTTP and SQLite, including concurrent creation from two Node processes, writer contention, rollback, SIGKILL before commit, lost acknowledgment after commit, restart replay, ownership, inactive credentials, retention constraints, validation, and OpenAPI. Confirmation and cancellation tests also cover same-key and different-key races, ownership, strict synthetic input, rollback, a killed precommit command, lost responses, and exact restart replay. A separate upgrade test applies the new migration to a database containing ticket 02 payments, history, and completed command records, then checks exact creation replay and the retained constraints. Failure injection exists only in the test server entrypoints and their optional precommit callbacks. Production HTTP exposes no failure controls.

The acceptance migration adds attempt and outbox tables without rebuilding prior tables. New triggers retain attempt identity, valid payment transitions, outbox ownership, immutable webhook bytes, and lifetime retention. Outbox due times and leases use UTC ISO strings, matching existing lifecycle timestamps. Provider and webhook claim fields are populated only in PROCESSING and cleared when work is rescheduled or completed.
