# Refactoring

Use for structural changes that preserve behavior. The active skill owns implementation, testing, review, and delivery. If the work introduces behavior or fixes a defect, split that work or route it to the matching playbook.

1. Pin the behavior contract that must remain unchanged. Use existing tests, direct checks, snapshots, or an equivalence harness that represents the real contract. Add characterization coverage only when the relevant behavior lacks evidence.
2. Name the structural problem and the organizing shape the code is missing. Read [Model the Domain](../principles/model-the-domain.md) when its trigger matches. Boring local code can remain when the shape is already clear.
3. Define the target structure before moving code. Read [Minimize Reader Load](../principles/minimize-reader-load.md) when indirection or mutable state is the problem. Use `codebase-design` when an interface or seam remains materially undecided.
4. Subtract before adding new structure when existing dead code, wrappers, validators, or orphan references block the target shape. Keep the change no larger than needed to reach the agreed structure.
5. Move in small behavior-preserving units and keep the pinned behavior green. For an internal API replacement whose callers can migrate together, follow [Migrate Callers Then Delete Legacy APIs](../principles/migrate-callers-then-delete-legacy-apis.md). Check strings, docs, examples, and other non-code references when renames or moves can affect them.
6. Prove behavior is unchanged on the real artifact. For a larger reshape, use an equivalence check, recorded baseline, or matching-surface smoke run when ordinary tests do not establish equivalence.
7. Confirm the refactor reduced concrete reader load or removed invalid states, branching, duplication, or hidden mutable state. If the new shape does not improve the stated structural problem, reconsider it.

Report the structural change, behavior preserved, and evidence through the active workflow's normal report. Do not claim new behavior as part of a refactor.
