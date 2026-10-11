# paybridge

Paybridge is Transac's local payment proof of concept. A sample merchant calls Paybridge over HTTP; Paybridge sends synthetic SOAP transactions to a durable mock provider and delivers signed events to the merchant's durable inbox.

Use Node 26.8.1 and Bun 1.3.4. Node runs the applications; Bun manages the locked dependencies and commands.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run demo
```

The demo creates a fresh private `.data/demo-<lowercase-uuid>` directory, launches five owned processes, runs both merchant contexts through direct and headless confirmation, and stops those processes. It retains its three databases, process manifest, operator commands and result on success or failure. Four orders finish PAID, one definite failure and one cancellation remain UNPAID, and one inconclusive payment deliberately remains UNKNOWN. No existing database is reset.

Read the [demo runbook](docs/demo.md) for retained evidence, manual launch and recovery commands. The [verification trace](docs/verification-trace.md) maps all 64 approved stories and 17 testing decisions to named behavioral checks. The [HTTP contract guide](docs/http-contracts.md) records actual OpenAPI comparisons and runtime restrictions.

The mock models immutable account-and-transaction outcomes and simulated authorization/posting. SUCCEEDED does not establish settlement. Synthetic payment references are not live tokenization, and the prototype does not prove live NCBA/4Cs identity retention, concurrency or failover behavior. It collects no real cards and makes no production compliance or exactly-once delivery claim.

## License

Proprietary. Copyright 2026 Jharik A. Richardson. All rights reserved. See [LICENSE](LICENSE).
