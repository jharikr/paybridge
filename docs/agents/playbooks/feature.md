# Feature

Use for new or changed behavior. The active skill owns interviewing, implementation, testing, review, and delivery. This playbook supplies the feature-specific decisions and checkpoints.

1. Establish the intended behavior, affected users, constraints, and acceptance criteria. Reuse an agreed brief, spec, or ticket. Resolve only gaps that affect the requested behavior.
2. Name the data shape, invariants, and interfaces that organize the feature before implementation logic spreads across files. Read [Model the Domain](../principles/model-the-domain.md) when its trigger matches. Explore alternatives while a material design choice remains open.
3. Identify the observable behavior and seams that implementation can test or verify. Reuse seams already agreed during grilling or planning.
4. Implement the accepted behavior in small verifiable units inside the active implementation workflow. Keep scope tied to the agreed feature. Apply additional principles only when new decisions trigger them.
5. Verify the acceptance criteria on the matching surface. An inconclusive or wrong-surface check is not a pass. Record remaining gaps rather than widening the feature to hide them.

Report the behavior delivered, consequential choices, verification, and unresolved requirements through the active workflow's normal report.
