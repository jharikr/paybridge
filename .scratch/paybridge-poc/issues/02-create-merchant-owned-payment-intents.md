# 02: Create and retrieve merchant-owned payment intents

**What to build:** A merchant can create a payment intent and retrieve its current persisted state. Recovering a lost creation response returns the original intent and acknowledgment, while another merchant cannot read or mutate that payment.

**Blocked by:** 01: Prove the selected stack.

**Status:** ready-for-agent

**Group:** 2 of 6. Merchant boundary and payment commands.

**Source:** [Approved specification](../spec.md) and [reference contract](../reference-contract.md#8-merchant-api-contract).

**User stories:** 2, 3, 4, 5, 9, 10, 11, 12, 13, 35, 45, 56, 57, 58, 59, 63.

**Testing decisions:** 5, 9, 16, 17.

- [ ] Seed two merchants with distinct synthetic provider-account mappings, Paybridge API credentials, webhook signing secrets and destinations, and permitted return origins. Store Paybridge credential hashes. Keep provider credentials and signing secrets distinguishable from API credentials and available only where their server operations need them. Provider-account assignments remain fixed for the lifetime of the records.
- [ ] Authenticate every merchant command and lookup. Invalid or inactive credentials are rejected. An absent payment and one owned by another merchant both return the generic not-found response. The caller cannot select or override a provider account.
- [ ] Validate positive safe-integer minor-unit amounts, explicit supported currencies and limits, bounded descriptions and business references, required headers, and a return URL within the merchant's configured origin. Permit the agreed local HTTP fixture origins. Reject unexpected fields, unsafe URL schemes, and real card payloads.
- [ ] Creation fixes amount, currency, merchant reference, provider invoice, description input, and return destination. Generate a collision-checked alphanumeric provider invoice of at most sixteen characters; do not truncate the business reference. Enforce the applicable database ownership, amount, state, and uniqueness constraints.
- [ ] Return 201 with the documented lookup Location, a PENDING snapshot at revision one, no latest attempt, and a checkout URL. Create a random payment-bound capability and store its authorization hash. Exact replay also retains the usable capability in the cached response, which must be treated as sensitive data.
- [ ] Scope command identity to merchant and key. Validate non-empty keys of at most 128 characters. Canonicalize validated input, operation, HTTP method, and normalized target while excluding credentials and tracing data. Identical completed requests return the exact original status, body, and relevant headers; changed input conflicts.
- [ ] Commit the intent, creation history, completed command identity, and cached acknowledgment in one transaction. Rollback or a crash before commit leaves no stranded reservation or partial payment. Lost acknowledgment after commit can be recovered after a real process restart using the original key.
- [ ] Concurrent identical creations produce one intent. Different merchants may use the same key. Repeated business references, including within one merchant under different command keys, do not imply the same intent. Paybridge does not own the application's business-order uniqueness rule.
- [ ] Lookup returns only the authenticated merchant's current persisted public snapshot with no-store caching. It never calls the provider or exposes internal provider references, credentials, or the checkout capability. A cached creation acknowledgment is never substituted for current lookup state.
- [ ] Preserve creation history, immutable inputs, command identities, and cached responses for the lifetime of prototype data. Redact sensitive headers, checkout URLs, and cached acknowledgment bodies from diagnostics. Script-like descriptions remain inert JSON.
- [ ] Exercise the routes through real HTTP and persistence, including invalid alternatives, concurrent replay, ownership substitution, rollback, and restart. Generate matching OpenAPI for inputs, headers, responses, and stable error shapes. Tests of replay after later financial state changes belong with the tickets that introduce those changes.

