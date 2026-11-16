# Headless checkout

Creation returns a payment-specific URL containing a random checkout capability. Treat that URL and the cached creation acknowledgment as credentials. Paybridge stores the capability hash for authorization, omits request logging, and returns `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

| Method and route                               | Behavior                                                                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /checkout/{paymentId}?token=...`          | Returns payment ID, amount, XCD currency, state, revision, and confirm/leave paths for PENDING or FAILED. Other states return `409 payment_not_confirmable`.                                     |
| `POST /checkout/{paymentId}/confirm?token=...` | Requires `Idempotency-Key` and JSON `mockPaymentMethodRef` plus `expectedRevision`. Commits one accepted attempt and returns an empty `303` response with the merchant return URL in `Location`. |
| `POST /checkout/{paymentId}/leave?token=...`   | Takes no body or command key. Returns the same navigation redirect in all six states without changing payment records or work.                                                                   |

Supply the capability query parameter on each operation. The displayed paths contain no capability. Missing, invalid, differently bound, or inactive-owner capabilities return a generic payment-not-found error. Merchant API credentials and checkout capabilities are separate authorization methods. Generated OpenAPI records both schemes and the routes that use them.

Checkout confirmation uses the same transaction as merchant confirmation. Its command identity includes the owning merchant, operation, normalized target, synthetic reference, and expected revision. The `confirm_checkout` operation prevents a merchant API command from being mistaken for a checkout replay. A completed same-request command returns its exact cached `303` and `Location` before evaluating the current state. A new stale command returns `409 payment_revision_conflict` without retaining an attempt, work item, or key reservation. Retry after a definite failure requires a deliberate new key and the failed revision.

The return destination comes from the immutable payment input and the merchant's configured permitted origin. A URL builder preserves existing query values and replaces `paymentId` with the bound payment ID. Caller-supplied redirect fields are rejected. URL credentials, fragments, unsafe schemes, and unapproved origins are rejected at creation. Descriptions remain inert data and are omitted from checkout display. This flow has no payer UI or card-entry form.

Leave is navigation only. It cannot stop a provider request, resolve UNKNOWN, advance a revision, emit a financial event or webhook, or permit another attempt. The former checkout cancellation route does not exist. Permanent cancellation is the authenticated merchant API operation and is permitted only from PENDING.

The [sample merchant](../merchant/README.md) checks its own order binding on return and obtains authoritative state through authenticated lookup when needed. A redirect acknowledges navigation or durable acceptance; it does not establish payment success.

`tests/checkout/` exercises real HTTP APIs, provider workers, and separate databases. It covers capability substitution, all-state navigation, direct/checkout races, stale-command rejection after decline, restart replay of a lost redirect, rollback, safe URLs, actual OpenAPI response media and headers, and shared merchant snapshot application. The mock ledger supplies independent synthetic outcome evidence. These tests do not establish live-provider guarantees.
