# Issue tracker

Issues and specs live as local Markdown files under `.scratch/`.
GitHub Issues is the planned future tracker. Continue using local files
until the owner requests migration.

## Conventions

- Use lowercase feature directories at `.scratch/<feature-slug>/`.
- Store the feature spec at `.scratch/<feature-slug>/spec.md`.
- Store each implementation ticket in its own file at
  `.scratch/<feature-slug>/issues/<NN>-<slug>.md`.
- Number tickets from `01` in dependency order, with blockers first.
- Record dependencies near the top as `Blocked by:` with ticket numbers
  and titles.
- Append comments and conversation history under `## Comments`.

## Publish to the issue tracker

Create the spec or individual ticket files at the paths above.
Create directories as needed.

## Fetch the relevant ticket

Read the referenced file. Resolve a ticket number within its feature
directory. If the feature is ambiguous, ask which feature the user means.

## Future migration

When the owner requests migration, transfer specs, tickets, dependencies,
and conversation history to GitHub Issues. Record the corresponding
GitHub links in the local files and update this guidance.
