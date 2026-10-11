# Never Block on the Human

Within an already-authorized implementation task, the human supervises asynchronously. Agents should stay unblocked on routine execution choices within the agreed scope.

**Why:** Every permission pause stalls the pipeline and makes the human the bottleneck. Since code changes are reversible and reviewable, a wrong decision usually costs less than blocking.

**Pattern:**
- **Proceed, then present.** Within the authorized scope, make routine reversible choices, do the work, and explain consequential decisions afterward.
- **Handle problems within scope.** Fix problems caused by or directly blocking the current work. Report unrelated problems rather than expanding scope.

**Boundaries:**
- **Irreversible actions** (force-push, delete production data, send external messages) still require confirmation.
- **Reversible execution choices within the authorized scope** should proceed without blocking.
- **Product direction and material scope changes** come from the human. Execution within an agreed task should not block.
