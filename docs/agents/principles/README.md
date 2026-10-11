# Engineering principles

Check this index for design or engineering decisions during grilling, planning, implementation, or review. Match the current decision to the triggers below, then read only the matching leaf principles in full. Reassess when the task introduces a new decision.

Project requirements and the active skill's workflow take precedence. Principles are defaults within the agreed scope.

When a principle materially changes a decision, name it in the reply or final report and state the specific choice it changed and why. Report only principles you actually read and applied. Do not create a principle inventory when none affected the work.

## Core

- [Laziness Protocol](laziness-protocol.md). Sizing a refactor or considering another abstraction, layer, or threaded signal.
- [Foundational Thinking](foundational-thinking.md). Before logic depends on core types or data structures, when sequencing foundational scaffold versus feature work, or when deciding what concurrent actors share.
- [Redesign from First Principles](redesign-from-first-principles.md). A new requirement exposes a mismatch in the existing design.
- [Attack the Premise](attack-the-premise.md). Two fixes sharing a premise have failed the same check.
- [Subtract Before You Add](subtract-before-you-add.md). Sequencing an addition, refactor, or rewrite around existing complexity.
- [Minimize Reader Load](minimize-reader-load.md). Code is hard to trace or its state is hard to follow.
- [Outcome-Oriented Execution](outcome-oriented-execution.md). A rewrite or migration introduces temporary compatibility code, transitional APIs, duplicate paths, or other intermediate states that differ from the intended design.
- [Experience First](experience-first.md). Choosing product behavior, user experience, or feature scope.
- [Exhaust the Design Space](exhaust-the-design-space.md). A material product, UI, interaction, or architectural decision has multiple plausible approaches, no clear project precedent, and would be costly to reverse if chosen poorly.
- [Build the Lever](build-the-lever.md). Work is repetitive, mechanical, migration-heavy, or difficult to verify by hand, and a small rerunnable tool could materially reduce error or proof cost.

## Architecture

- [Model the Domain](model-the-domain.md). Stateful logic branches repeatedly or the same shape assumption appears across files. Encode the domain in a coherent structure instead of scattering conditionals.
- [Boundary Discipline](boundary-discipline.md). Designing validation, error handling, or framework adapters.
- [Type System Discipline](type-system-discipline.md). Designing types, invariants, or typed function signatures.
- [Make Operations Idempotent](make-operations-idempotent.md). Commands or processing can retry, restart, or fail partway through.
- [Migrate Callers Then Delete Legacy APIs](migrate-callers-then-delete-legacy-apis.md). Replacing an internal API whose callers can migrate together without external compatibility requirements.
- [Separate Before Serializing Shared State](separate-before-serializing-shared-state.md). Concurrent actors could write to the same file, branch, key, object, or other mutable state.

## Verification

- [Prove It Works](prove-it-works.md). After a task or before declaring it complete, choose evidence that proves the real artifact rather than a proxy.
- [Fix Root Causes](fix-root-causes.md). Diagnosing a defect or evaluating a proposed fix.
- [Sequence Work into Verifiable Units](sequence-verifiable-units.md). A migration, sweep, staged API replacement, schema transition, or other dependent sequence has phases where later work could hide or compound an earlier failure.
- [Test Behavior, Not Implementation](test-behavior-not-implementation.md). Evaluating whether an existing or proposed test really proves behavior, especially when it relies on mocks, constants, weak assertions, absence checks, fixtures, or implementation details.

## Delegation

- [Guard the Context Window](guard-the-context-window.md). Large outputs, repeated reads, or parallel work threaten the context budget.
- [Never Block on the Human](never-block-on-the-human.md). Routine reversible execution choices arise within an already-authorized implementation task.

## Meta

- [Encode Lessons in Structure](encode-lessons-in-structure.md). A recurring correction could become an executable rule or structural constraint.
