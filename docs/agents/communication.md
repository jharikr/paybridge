# Communication

`AGENTS.md` owns the global communication defaults. Use this file for plans, implementation reports, reviews, and handoffs unless the active skill defines a more specific output format.

- Keep plans concise. Record decisions, important assumptions, affected areas, verification, and unresolved questions rather than obvious mechanics.
- Terse is not an excuse to drop required content. Preserve the details, tradeoffs, choices, and open decisions the active workflow requires.
- Frame consequential work for both the consumer and the maintainer. State what changes for the person using the behavior and what the next engineer inherits before low-level implementation detail when that distinction matters.
- Explain consequential decisions, tradeoffs, deviations, unresolved issues, and remaining risk.
- Distinguish verified observations from inference or assumptions. Label material uncertainty and cite evidence when available.
- Do not hand the user a check you can run within the authorized environment. Never claim a check ran when it did not. For completed implementation or review work, state what was verified and what remains unverified.
- When a principle materially changed a decision, follow the reporting rule in the [principle index](principles/README.md).
