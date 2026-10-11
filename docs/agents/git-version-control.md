# Git and version control

Read this before Git actions that change branches, history, remotes, worktrees, or delivery state. Read-only inspection such as `git status`, `git diff`, `git log`, and `git show` does not require separate authorization when the active task needs it.

- Do not create or switch branches, create worktrees, rebase, commit, push, or open a pull request unless the user requests that action.
- Do not discard local work or rewrite shared history without explicit authorization for the target and impact.
- Implementation stops before Git delivery. The user reviews the code before any requested commit or push.
- When commits are requested, keep each commit to one concern and describe the outcome, not the process.
