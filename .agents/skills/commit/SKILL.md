---
name: commit
description: Stage and commit current-task changes using Conventional Commits when explicitly invoked. Support draft previews and requests to commit all changes.
disable-model-invocation: true
---

Create one Conventional Commit. If asked only for a message or draft,
return the proposed message and files to be committed without changing
Git state.

1. Read repository instructions and inspect Git status, staged and
   unstaged diffs, and relevant untracked files.
2. Determine what to include:
   - By default, use the current conversation and diff to select changes
     belonging to the task the user wants committed.
   - If the user says "commit all changes" or equivalent, include all
     tracked and untracked changes that Git does not ignore.
   - If the intended scope is unclear, ask which changes to include.
3. Stage the selected changes yourself. Do not require the user to run
   `git add`. Keep unrelated changes out of the commit, including changes
   that were already staged. Preserve partial staging where relevant.
4. Inspect the staged diff and verify that it contains the intended
   changes. This is an internal check; continue without requesting
   confirmation.
5. Write the message using these rules:
   - Shape: `type(scope)!: description`
   - Scope and `!` are optional. Omit empty parentheses.
   - Use `feat` for new functionality and `fix` for bug fixes.
   - Otherwise use the appropriate repository type, such as docs,
     refactor, perf, test, build, ci, chore, style, or revert.
   - Choose a scope naming the affected component when useful.
   - Mark incompatible changes with `!` and explain the impact and
     migration in a `BREAKING CHANGE: ...` footer.
   - Separate the subject, optional body, and footers with blank lines.
   - Use the body to explain why when the subject is insufficient.
   - Use footer syntax such as `Refs: #123`. Never invent references.

   Style defaults, unless repository rules differ:
   lowercase type and scope; imperative description; no final period;
   aim for a subject of at most 72 characters.
   These defaults are stricter than the specification.

6. Run required repository checks. Do not bypass hooks or claim
   checks passed unless verified.
7. Commit using the exact message. Never push or amend unless requested.
8. Verify success. Return the short commit hash and subject, or report
   the failure without claiming a commit was created.