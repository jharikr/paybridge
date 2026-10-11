# Build the Lever

Automate work when a small rerunnable tool materially reduces repetition, error, or verification cost.

**When it applies:** The work is mechanical, repetitive, migration-heavy, or difficult to verify by hand, and a script, codemod, generator, query, or check would make execution safer or the result easier to prove.

**Rule:** The tool must earn its cost. Do not build machinery merely because the task is non-trivial.

- Do the first representative unit by hand when that helps expose the recipe.
- Build the smallest tool that can repeat or prove that recipe safely.
- Make it safe to rerun when practical.
- Compare the tool's result against the known-good example or another independent check before using it broadly.
- Prefer one deterministic tool over many hand-applied copies of the same mechanical change.
- Keep the tool with the work only when it remains useful after the immediate task.

**Do not apply it:** A few obvious edits, exploratory work where the shape is still changing, or a one-off where the tool would cost more to understand and verify than the work itself.

This principle does not require every application to produce a new file, and it does not turn delegated work into a new skill by default. The [Laziness Protocol](laziness-protocol.md) still applies. Build only enough automation to make the current work cheaper, safer, or more reproducible.

Distinct from [Encode Lessons in Structure](encode-lessons-in-structure.md), which turns a recurring instruction into a durable guardrail. For proving the finished behavior, use [Prove It Works](prove-it-works.md).
