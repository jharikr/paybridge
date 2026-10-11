---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once implementation is complete:

1. Run /deslop to simplify the changes.
2. Run /review-agent to find and fix actionable bugs.
3. Run /code-review and address any findings.