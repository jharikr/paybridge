# Sequence work into verifiable units

Break multi-step work into phases that can be checked independently before later phases make failures harder to localize.

**When it applies:** A migration, sweep, staged API replacement, schema transition, or other dependent sequence has multiple phases where later work could hide or compound a failure introduced earlier.

**Rule:** Each meaningful phase should end with evidence that the phase is sound before work builds on top of it.

- Define the boundary of the current phase and the check that closes it.
- Make the change for that phase.
- Run the relevant check before starting the dependent phase.
- If a phase intentionally cannot be fully verified yet, record what remains unresolved and where the next proof occurs.
- Prefer phase boundaries that isolate causes rather than arbitrary batches of files.

Do not use this principle to restate ordinary red-green TDD steps. The TDD and `implement` skills already own normal implementation slicing and test cadence. This principle operates above that level when the overall change itself has dependent stages.

This principle also does not prescribe commits, branches, or pull-request structure. Git delivery follows the repository's Git guidance when the user requests it.

Use [Prove It Works](prove-it-works.md) to choose credible evidence for each phase. Use [Build the Lever](build-the-lever.md) when a rerunnable tool makes repeated phase work safer or cheaper.
