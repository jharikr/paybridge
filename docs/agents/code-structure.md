# Code structure

## Conditional logic

- Prefer explicit branches for complex conditions or multi-step decisions.
- Compact value selections, such as unanswered/yes/no, may remain inline when they are easy to follow.

## Spacing

- Separate logical phases with one blank line, such as authorization, file preparation, storage writes, and commit.
- Keep an operation and its immediate error or cancellation check together.
- Keep closely related declarations together.
