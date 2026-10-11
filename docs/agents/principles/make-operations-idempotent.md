# Make Operations Idempotent

Design retryable or restartable operations so they converge to the correct state regardless of how many times the same logical operation runs or where it resumes from. Every state-mutating operation on such a path should answer: "What happens if this retry runs twice? What happens if the previous run crashed halfway?"

Idempotence applies to re-execution of the same logical operation. Distinct intentional operations may legitimately have cumulative effects.

**Why:** Commands, lifecycle operations, and processing loops run where crashes, restarts, and retries are normal. If partial state changes the next run's outcome, every restart becomes a debugging session.

**The pattern:**
- Convergent startup: scan for existing state, clean stale artifacts, adopt live sessions
- Content-based cleanup: compare by content equivalence, not creation order
- Self-healing locks: use PID-based stale lock detection
- Idempotent scheduling: failed work respawns cleanly, fresh input regenerated after each cycle

**The test:**
1. What happens if the same logical operation runs twice in a row?
2. What happens if the previous run crashed at every possible point?
3. Does re-execution converge to the same end state?

If any answer is "it depends on what state was left behind," the operation needs a reconciliation step.
