# Encode Lessons in Structure

Encode recurring fixes in mechanisms (tools, code, metadata, automation) instead of textual instructions. Every error, human correction, and unexpected outcome is a learning signal. Capture it, route it, and close the loop.

**Why:** Textual instructions are easy to miss. They require the reader to notice, remember, and comply. Structural mechanisms (lint rules, metadata flags, runtime checks, automation scripts) enforce the rule without cooperation.

**Pattern:**
When you catch yourself writing the same instruction a second time:
1. Ask: can this be enforced reliably by a lint rule, metadata flag, type, runtime check, script, or other structural mechanism at reasonable maintenance cost?
2. If yes and the mechanism earns its cost, encode it. Delete the instruction only when the mechanism fully captures the intent.
3. If no (requires judgment), make the instruction more prominent and add an example of the failure mode

**Pick the least costly mechanism that reliably enforces the requirement.** Prefer stronger compile-time or CI enforcement when it fits naturally, but do not add broader machinery solely to make enforcement stronger. Use the [Laziness Protocol](laziness-protocol.md) as the bound.

**Corollary:** If the structural mechanism fully enforces the rule, do not keep a redundant instruction. If it enforces only part of the rule, keep the remaining guidance.

**Feedback loop:**
- **Capture every correction.** When the human intervenes or tests fail, decide if it's a one-off or a pattern.
- **Route to the right layer.** One-off -> brain note. Recurring fix -> skill or lint rule. Systemic issue -> principle.
- **Close the loop.** Don't just record. Apply now or create a concrete todo.

**Anti-patterns:**
- Acknowledging without recording ("I'll keep that in mind" does not persist)
- Recording without routing (a brain note about a lint rule that should exist is wasted unless the lint rule gets implemented)
- Fixing without generalizing (fixing one instance while leaving the recurring pattern intact)
