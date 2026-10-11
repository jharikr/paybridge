# paybridge

Paybridge belongs to the Transac project. Application setup is pending the owner's next command. Correctness, access control, auditability, and historical integrity matter for payment records.

## Runtime

- Use Bun and bunx when application setup requires JavaScript tooling.
- No application runtime, framework, database, or development server has been configured yet. Follow the owner's next setup command before choosing them.
- Once a development server exists, leave its lifecycle to the owner unless the task requires managing it or the owner asks.
- Confirm database targets and data retention requirements before schema changes. No migration policy has been chosen yet.
- Keep repository and new folder names lowercase.

## Autonomy

- Project requirements and the active skill's workflow take precedence over general guidance.
- Advice, explanation, diagnosis, and review authorize an answer, not implementation.
- Resolve routine facts and reversible choices autonomously. Keep material product decisions with the user.
- Always pause before irreversible or externally visible actions such as force-pushes, deploys, destructive data changes, or customer messages. Confirm the target and impact, then get explicit authorization.
- No is an acceptable answer. Give your real judgment. Decline, push back, or reject added scope when it is not justified. Agreement is not the default.

## Engineering guidance

- For writing & structuring code, and coding conventions see [Code structure](docs/agents/code-structure.md).
- For version-sensitive behavior, use repository guidance, installed skills, or authoritative documentation rather than memory.
- For design or engineering decisions during grilling, planning, implementation, or review, check the [principle index](docs/agents/principles/README.md) and read the matching principles.
- For feature, bug-fix, or refactoring work, use the matching [playbook](docs/agents/playbooks/README.md). Supporting guidance must not start a second workflow when the active skill already owns execution.
- Work involving regulatory rules, records, authorization, audit history, historical data, privacy, or sensitive data must use [records guidance](docs/agents/records.md).

## Verification and delivery

- When tests and typechecking cannot prove runtime, browser, UI, or integration behavior, use [verification guidance](docs/agents/verification.md).
- Before Git actions that change branches, history, remotes, worktrees, or delivery state, use [Git and version control](docs/agents/git-version-control.md).

## Communication

Lead with the result. Concision is not permission to omit required context. Never fabricate links, citations, transcript references, evidence, test results, or verification claims. For plans, implementation reports, reviews, and handoffs, use [communication guidance](docs/agents/communication.md) unless the active skill defines a more specific format.

## Writing

Read and apply `.agents/skills/unslop/SKILL.md` to all prose, documentation, prompts, explanations, and commit messages unless the owner explicitly asks otherwise.

## Agent skills

### Issue tracker

Track issues and specs in `.scratch/<feature-slug>/`. Read
[issue tracker guidance](docs/agents/issue-tracker.md) before ticket operations.

### Domain docs

Use a single-context layout with root `GLOSSARY.md` and `docs/adr/`.
Read [domain guidance](docs/agents/domain.md) before exploring domain concepts.
