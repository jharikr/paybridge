# Playbooks

Select the playbook by the requested action. Playbooks supply task-specific reasoning and proof checkpoints. They do not start a second implementation workflow.

During grilling, use the matching playbook to expose design questions, constraints, acceptance criteria, and proof requirements. During implementation, follow its applicable steps inside the active skill's workflow and reuse decisions already settled upstream.

Follow applicable playbook steps in order. If a step would normally apply but is intentionally skipped, record `skip: <reason>`. Do not copy the playbook into a second todo list or execution workflow.

- [Feature](feature.md). Add or change behavior.
- [Bug fix](bug-fix.md). Reproduce and correct a defect.
- [Refactoring](refactoring.md). Change structure while preserving behavior.
