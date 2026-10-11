# Outcome-Oriented Execution

Design rewrites and migrations around the intended final architecture instead of preserving temporary structure merely to keep every intermediate state looking finished.

**When it applies:** A rewrite or migration introduces temporary compatibility code, transitional APIs, duplicate paths, or other intermediate states that differ from the intended design.

**Rule:** Know the target state, define where correctness must be re-established, and avoid turning temporary architecture into permanent architecture.

- State the intended end state before adding transitional machinery.
- Add compatibility layers only when a real consumer, rollout constraint, or migration boundary requires them.
- Keep temporary code visibly temporary and remove it when its migration purpose ends.
- Establish explicit verification boundaries for the transition.
- Keep high-signal checks around actively changing areas.

Temporary breakage may exist inside an agreed implementation sequence when it is scoped and recoverable. The completed handoff should be green unless the agreed plan explicitly allows an unresolved intermediate state. Do not use this principle to justify leaving ordinary work broken.

External compatibility requirements, staged deployments, and independently released consumers may require stable intermediate states. Those constraints take precedence over this default.

For replacing an internal API whose callers can migrate together, also use [Migrate Callers Then Delete Legacy APIs](migrate-callers-then-delete-legacy-apis.md).
