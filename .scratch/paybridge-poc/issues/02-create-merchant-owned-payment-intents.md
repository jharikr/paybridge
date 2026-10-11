# 02: Create and retrieve merchant-owned payment intents

**What to build:** A merchant can create a payment intent and retrieve its current persisted state. Recovering a lost creation response returns the original intent and acknowledgment, while another merchant cannot read or mutate that payment.

**Blocked by:** 01: Prove the selected stack.

**Status:** completed

**Group:** 2 of 6. Merchant boundary and payment commands.

**Source:** [Approved specification](../spec.md) and [reference contract](../reference-contract.md#8-merchant-api-contract).

**User stories:** 2, 3, 4, 5, 9, 10, 11, 12, 13, 35, 45, 56, 57, 58, 59, 63.

**Testing decisions:** 5, 9, 16, 17.

- [x] Seed two merchants with distinct synthetic provider-account mappings, Paybridge API credentials, webhook signing secrets and destinations, and permitted return origins. Store Paybridge credential hashes. Keep provider credentials and signing secrets distinguishable from API credentials and available only where their server operations need them. Provider-account assignments remain fixed for the lifetime of the records.
- [x] Authenticate every merchant command and lookup. Invalid or inactive credentials are rejected. An absent payment and one owned by another merchant both return the generic not-found response. The caller cannot select or override a provider account.
- [x] Validate positive safe-integer minor-unit amounts, explicit supported currencies and limits, bounded descriptions and business references, required headers, and a return URL within the merchant's configured origin. Permit the agreed local HTTP fixture origins. Reject unexpected fields, unsafe URL schemes, and real card payloads.
- [x] Creation fixes amount, currency, merchant reference, provider invoice, description input, and return destination. Generate a collision-checked alphanumeric provider invoice of at most sixteen characters; do not truncate the business reference. Enforce the applicable database ownership, amount, state, and uniqueness constraints.
- [x] Return 201 with the documented lookup Location, a PENDING snapshot at revision one, no latest attempt, and a checkout URL. Create a random payment-bound capability and store its authorization hash. Exact replay also retains the usable capability in the cached response, which must be treated as sensitive data.
- [x] Scope command identity to merchant and key. Validate non-empty keys of at most 128 characters. Canonicalize validated input, operation, HTTP method, and normalized target while excluding credentials and tracing data. Identical completed requests return the exact original status, body, and relevant headers; changed input conflicts.
- [x] Commit the intent, creation history, completed command identity, and cached acknowledgment in one transaction. Rollback or a crash before commit leaves no stranded reservation or partial payment. Lost acknowledgment after commit can be recovered after a real process restart using the original key.
- [x] Concurrent identical creations produce one intent. Different merchants may use the same key. Repeated business references, including within one merchant under different command keys, do not imply the same intent. Paybridge does not own the application's business-order uniqueness rule.
- [x] Lookup returns only the authenticated merchant's current persisted public snapshot with no-store caching. It never calls the provider or exposes internal provider references, credentials, or the checkout capability. A cached creation acknowledgment is never substituted for current lookup state.
- [x] Preserve creation history, immutable inputs, command identities, and cached responses for the lifetime of prototype data. Redact sensitive headers, checkout URLs, and cached acknowledgment bodies from diagnostics. Script-like descriptions remain inert JSON.
- [x] Exercise the routes through real HTTP and persistence, including invalid alternatives, concurrent replay, ownership substitution, rollback, and restart. Generate matching OpenAPI for inputs, headers, responses, and stable error shapes. Tests of replay after later financial state changes belong with the tickets that introduce those changes.


## Comments

### 2026-10-11 implementation candidate

Implemented the merchant HTTP boundary, separate synthetic credential configuration, transactional creation and exact command replay, current-state lookup, strict validation, migration constraints, and matching OpenAPI. The service and command code live under `apps/paybridge/`; the shared protocol is `contracts/payments.ts`. `docs/merchant-payment-api.md` records fixture values, the selected mock amount ceiling, startup commands, retention, sensitive cached acknowledgments, and the Prisma marker initialization detail.

`bun run typecheck` passed. `bun run test` passed 20 tests in six files, including 11 payment tests through actual HTTP and SQLite. The payment suite proves competing processes, same-process overlap, bounded writer contention, rollback, SIGKILL before commit, lost acknowledgment and replay after restart, ownership and inactive credentials, input and history constraints, strict alternatives, and OpenAPI parity. The deslop pass removed redundant response headers and kept command results and payment identifiers explicitly typed. Independent review is pending. Confirmation, checkout, and replay after later financial changes remain assigned to their dependent tickets.

### 2026-10-11 independent review corrections

The first read-only review identified four defects. Seeded destinations now use the contract's `/api/webhooks/paybridge/{merchantFixture}` routes. Boundary validation rejects NUL and unpaired Unicode surrogates before hashing or persistence; accepted Unicode text remains unchanged, and return URLs reject raw control characters. Creation, cached replay, and lookup now emit `X-Content-Type-Options: nosniff`. OpenAPI documents `Retry-After` for temporary unavailability and its conditional presence for `command_in_progress`. Behavioral regressions failed before each correction and passed afterward. The deslop pass retained the shared validation schema and removed no safeguards.

`bun run typecheck` passed. The full suite passed 21 tests in six files, including 12 payment tests. The corrected candidate is frozen for independent recheck.

### 2026-10-11 independent recheck

The review-agent recheck reported no findings. The reviewer independently passed all 12 payment tests, typechecking, and the diff whitespace check, and confirmed each correction, accepted Unicode preservation, and return URL control rejection. Ticket 02 is complete. The implementation retains the approved testing seams and does not introduce dependent confirmation or provider-outcome behavior.
