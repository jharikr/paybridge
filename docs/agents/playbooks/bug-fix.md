# Bug fix

Use to reproduce and correct a reported defect. For diagnosis-only requests, stop at the evidence and proposed correction. The active skill owns implementation, testing, review, and delivery.

1. Establish expected and observed behavior. Reproduce the failure on the relevant surface before changing production code. If access or tooling prevents reproduction, state the specific limit and the evidence still available.
2. Trace the mechanism with evidence. Read [Fix Root Causes](../principles/fix-root-causes.md). Inspect the code, runtime state, and relevant history needed to separate hypotheses from causes. Use [Records and sensitive data](../records.md) when diagnostics could expose sensitive values.
3. Define the correction boundary and the observable regression seam. Reuse accepted planning decisions. Keep the proposed fix tied to the reproduced failure.
4. Apply the smallest correction supported by the evidence. Recheck a hypothesis when new evidence contradicts it. Separate additional discovered work from the agreed defect.
5. Repeat the original reproduction and the relevant regression checks. Verify on the same surface where practical. An inconclusive result remains inconclusive.

Report the defect, root cause, correction, and verification through the active workflow's normal report. Redact sensitive evidence.
