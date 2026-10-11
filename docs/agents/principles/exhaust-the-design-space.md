# Exhaust the Design Space

Compare multiple concrete alternatives before committing when a material decision has no established precedent and choosing poorly would be expensive to reverse.

**When it applies:** A product, UI, interaction, or architectural decision has multiple plausible approaches, no clear project precedent, and enough uncertainty that the differences matter to behavior, maintainability, or user experience.

**Rule:** Explore 2 to 3 genuinely different options before choosing. The comparison can be written alternatives, state diagrams, API shapes, sketches, or runnable prototypes. Use the cheapest form that can answer the decision.

- State the decision and the criteria that distinguish the options.
- Make the alternatives meaningfully different. Small variations of the same shape do not count.
- Compare the tradeoffs that matter to the current task.
- When the choice depends on observing behavior, interaction, or implementation feasibility, use the installed `prototype` skill. Let that skill own prototype execution.
- Carry the chosen result back into the active workflow. Do not create a second implementation workflow from this principle.

**Do not apply it:** Mechanical implementation with an established pattern, a bug fix or refactor with a clear target state, a low-cost reversible choice, or a decision whose constraints leave only one credible option.
