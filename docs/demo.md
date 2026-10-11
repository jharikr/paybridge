# Run the synthetic proof of concept

The retained demo runs the existing public HTTP routes and trusted operator CLIs. It starts five Node processes: mock API, Paybridge API, merchant API, Paybridge provider/webhook worker, and merchant inbox worker. Each application opens only its own SQLite file. The demo's independent, read-only inspection counts ledger effects and checks persisted evidence; it does not supply financial outcomes to runtime code.

Use Node 26.8.1 and Bun 1.3.4. Install the committed dependency versions before running:

```sh
bun install --frozen-lockfile
bun run demo
```

An explicit parent keeps evidence outside a disposable checkout:

```sh
bun run demo --data-parent /absolute/private/data-parent
```

Each invocation exclusively creates `demo-<lowercase-uuid>` under that parent. It never opens an existing run directory as a fresh database. The parent may already exist; keep it private. New run directories use mode 0700 and files use 0600. Startup allocates loopback ports before seeding the fixture origins. Fresh merchant A returns use `127.0.0.1` and merchant B returns use `localhost` at the same allocated merchant port. Both hosts reach one merchant listener and have distinct URL origins. The manifest records both return origins. `--paybridge-port 3100` can reserve a specific available Paybridge port; the other ports remain automatically allocated. A busy port produces a retained failed result and leaves the listener alone.

The script prints only a started/completed/failed event, its retained directory, and a fixed failure code when applicable. It keeps capabilities, cached creation bytes, credentials, signatures, raw SOAP and card-shaped fields out of output. The databases necessarily contain sensitive fixture configuration and cached capability-bearing acknowledgments. Protect the directory even though every transaction is synthetic.

## What the standalone demo establishes

The complete run creates seven orders. Both merchants use `demo-shared-order` independently. Merchant A first declines through direct confirmation, rejects a delayed stale command, then deliberately retries with a new command number and the current revision. Merchant B confirms through capability-bound headless checkout and receives an empty 303 with the stored merchant return destination. Accepted 202 and 303 responses leave orders UNPAID. Creation and confirmation replays preserve the original acknowledgment after financial state changes.

Other orders exercise definitive incomplete failure, pending cancellation and harmless repeat cancellation, lost approval and lost decline responses, and failure before acceptance. UNKNOWN rejects fresh confirmation. Trusted reconciliation commands resolve the recorded approval and decline using independently exported mock evidence, accept identical resolution replay, reject conflicting replacement, and reject absent evidence. The failed resolution permits a new deliberate attempt. The absent case remains IN_PROGRESS with payment UNKNOWN and order UNPAID.

The script checks capability substitution, cross-merchant lookup and return rejection, stable one-order bindings, and navigation-only leave in all six states. Cancellation retains the original binding. Return navigation itself never establishes completion.

For the outage phase, the demo SIGKILLs its merchant API before starting financial work. All seven initial financial notifications survive failed delivery. It then SIGKILLs its Paybridge worker and mock process, restarts those applications against the same files, restarts the merchant API and starts the inbox worker. Local order GET establishes inbox-applied PAID before any merchant payment lookup or return can apply that state independently. Delivery recovery leaves Paybridge financial records and mock ledger facts unchanged. Final repeated return preserves each original paid timestamp.

Expected completed totals are seven orders, eight attempts, seven accepted mock identities, four simulated financial effects, eleven delivered and processed events, four PAID orders and three UNPAID orders. Final payments are four SUCCEEDED, one FAILED, one CANCELLED and one UNKNOWN. One case intentionally remains unresolved.

The standalone journey is representative. The focused suites below separately prove malformed/mismatched responses, delayed acceptance versus delayed response, duplicate identity, real overlapping claims with a received late response, all crash boundaries, signed-byte rejection, lost acknowledgments, duplicate/reordered notifications, revision gaps, lookup races and atomic rollback. Those assertions must pass against the same implementation; the approval demo cannot substitute for them.

## Retained evidence and interruption

| File                                            | Contents                                                                                                                                                                                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `result.json`                                   | Completion or fixed failure code; successful runs include allowlisted IDs, states and aggregate results.                                                                                                                                              |
| `manifest.json`                                 | Fixed origins, absolute database paths, last completed stage and start/stop records for owned application PIDs. Writes replace the prior manifest atomically.                                                                                         |
| `implementation.json`                           | Node version, capture time and SHA-256 of all files under `apps/`, `contracts/`, `scripts/` and `tests/`, including documentation there, plus `package.json`, `bun.lock` and `tsconfig.json`. Root `README.md`, `AGENTS.md` and `docs/` are excluded. |
| `paybridge.db`, `merchant.db`, `mock-fourcs.db` | Retained commands, records, signed receipts, financial history and independent mock ledger. SQLite journal sidecars may remain after a crash and belong with their database.                                                                          |
| `operator/*.json`                               | Exact synthetic list/start/resolve/replay/conflict commands, including the rejected absent-evidence command.                                                                                                                                          |

The process manifest covers the five long-running application roles and their restarts. Short-lived inspection/reconciliation commands are awaited and stopped by their caller. On normal success, failure, SIGTERM or SIGINT, the demo stops only processes it created and retains the directory. It checks interruption at bounded phase boundaries; an active HTTP call, SQLite lock wait or polling phase can finish first. SIGKILL of the demo driver or host failure cannot execute cleanup. Preserve its manifest and records and establish actual process ownership before manually stopping a survivor. PID reuse means a historic PID alone is insufficient evidence of ownership.

A failed run is evidence. Inspect its fixed code and last manifest stage, preserve all files, and run a new demonstration in a fresh directory after fixing the cause. There is no reset command or retention purge. Ordinary integration tests remove only their own temporary test directories; that test lifecycle is distinct from this retained command.

## Manual launch and recovery

For manual exploration, allocate a fresh private directory and choose every origin before first startup. Fixture seeding inserts absent contexts and never rewrites existing destinations. Changing ports later cannot silently repair stored return or callback URLs. Use the same origins and files when restarting a retained run.

```sh
umask 077
paybridge_demo_dir="$(node --input-type=module -e 'import {randomUUID} from "node:crypto"; import {resolve} from "node:path"; process.stdout.write(resolve(".data", `manual-${randomUUID()}`))')"
mkdir -p .data
mkdir "$paybridge_demo_dir"
```

Run the following in five terminals with the same absolute directory value. The ports shown must be free; select alternatives and update all corresponding origins before seeding if they are occupied. Leave existing owner servers alone.

```sh
node apps/mock-fourcs/main.ts "$paybridge_demo_dir/mock-fourcs.db" 3102

MERCHANT_ORIGIN=http://127.0.0.1:3101 PAYBRIDGE_ORIGIN=http://127.0.0.1:3100 \
  node apps/paybridge/server.ts "$paybridge_demo_dir/paybridge.db" 3100

node apps/merchant/server.ts "$paybridge_demo_dir/merchant.db" 3101 \
  http://127.0.0.1:3100 http://127.0.0.1:3101

node apps/paybridge/worker.ts "$paybridge_demo_dir/paybridge.db" http://127.0.0.1:3102

node apps/merchant/worker.ts "$paybridge_demo_dir/merchant.db"
```

For these manual commands, merchant A permits `http://127.0.0.1:3101` and merchant B permits `http://localhost:3101` for returns. The merchant stores each context's matching return URL. Supplying the other context's origin to payment creation is rejected. Both hostnames must resolve to loopback on the local machine. Existing seeded rows, including earlier runs that used one return origin, remain unchanged on restart.

Defaults are documented in [provider work](provider-worker.md), [webhook delivery](webhook-delivery.md), and [inbox processing](merchant-inbox.md). The automated demo uses a 1-second provider deadline below a 5-second lease, 25-ms polling and bounded 100-to-500-ms delivery/inbox retries. No production fault endpoint is enabled. APIs report readiness through parent IPC; only the mock prints a listening message when run directly. The demo already implements bounded readiness for all five processes.

Use the [merchant routes](../apps/merchant/README.md) for order/create/confirm/recover and [payment API](merchant-payment-api.md) for authenticated current lookup and cancellation. The return routes are `/{merchantFixture}/payment-return?paymentId=...`, and signed callbacks target `/api/webhooks/paybridge/{merchantFixture}`. Treat cached acknowledgments as historical responses. Read the local order before lookup/return when checking whether inbox processing paid it.

For investigations, save a private `{"kind":"list"}` command file and invoke `node apps/paybridge/reconcile.ts DATABASE COMMAND_FILE`. Inspect the exact listed provider account and transaction ID with `node apps/mock-fourcs/inspect.ts MOCK_DATABASE PROVIDER_ACCOUNT TRANSACTION_ID`. The [reconciliation guide](reconciliation.md) gives executable command shapes and evidence matching rules. The operator must verify the evidence source; local JSON is not a cryptographic provider attestation. Absence cannot prove final failure.

## Verification and limits

```sh
bun run typecheck
bun run test
```

The full command includes stack, payment, mock, provider, recovery, reconciliation, merchant, checkout, webhook, inbox, HTTP contract and demo checks. `bun run test tests/demo` checks retained execution and lifecycle behavior. Focused directories can be passed to the same test command when investigating a specific failure. Vitest runs at most four files concurrently while preserving actual within-test process races and each existing timeout.

The [verification trace](verification-trace.md) records the exact final run and maps the six concern groups, 64 stories and 17 testing decisions to observable assertions. The [HTTP contract guide](http-contracts.md) explains generated documentation and stricter runtime rules. There is no interactive API documentation UI.

The mock's immutable finality and account/transaction deduplication are selected simulation assumptions. The provider's live retention window, concurrent execution, failover, duplicate-result semantics and finality require provider confirmation. Synthetic references do not establish live tokenization or safe real-card recovery. SUCCEEDED means mock authorization and posting, not settlement. The prototype promises neither exactly-once distributed delivery nor production compliance, and includes no real card collection, onboarding portal, other provider or customer deployment. An inconclusive UNKNOWN can remain open indefinitely.
