# Boundary Discipline

Place validation, type narrowing, and error handling at trust boundaries. Establish domain invariants at state-creation and mutation boundaries. Once data has entered trusted domain types, avoid redundant defensive validation. Business logic lives in pure functions. The shell is thin and mechanical.

**Why:** Scattered validation is noisy, redundant, and gives a false sense of safety. Keep logic out of framework wiring so it can be tested without the framework.

**The pattern:**
- **At trust boundaries** (CLI args, config files, external APIs, network protocols): validate, return errors, handle defensively.
- **At mutation boundaries:** enforce domain invariants that the type system or storage model cannot guarantee.
- **Inside trusted domain code:** typed data, error propagation, no redundant re-validation. Trust established invariants and types.
- **Across the boundary.** Expose domain concepts, not the boundary's private representation. Keep general-purpose mechanism inside and special-purpose policy at the edge.

**Applications:**

Validation and error handling:
- Validate config at parse time (the boundary), not inside business logic
- Parse raw data into domain types at the boundary
- Do not re-export transport, storage, framework, or wire types through the public surface
- No redundant nil checks deep in call chains if the boundary already validated

Code organization:
- Business logic in pure functions with no framework dependencies
- Parse functions: pure transforms from raw bytes to typed state
- Prompt construction: structured state in, string out
- Scoring and assessment: pure transforms from state to results

**The tests:**
- "Is this data crossing a trust boundary or establishing a domain invariant?" If neither, validation is probably redundant.
- "Can this be a pure function that the shell just calls?" If yes, extract it.
