# Verification

Use this guidance when normal tests and typechecking cannot establish the behavior that matters. It supports the active workflow; it does not create a second testing or review process.

Use the smallest proof that establishes the real outcome. Prefer the matching execution surface over a proxy.

Use the existing development server for runtime or browser checks. If it is unavailable or unusable, report the verification limit instead of managing its lifecycle.

For browser or UI verification, prefer the installed `agent-browser` skill and let that skill own browser commands and session handling. Reuse an authenticated session, profile, or saved state when available. Prefer repository-provided development or test accounts for protected flows.

If the repository already provides an explicit development-only authentication bypass, it may be used as designed for local verification. Do not add, widen, disable, or modify authentication or authorization controls solely to reach unrelated UI. When authentication or authorization is itself under test, exercise the real path rather than bypassing it.

If `agent-browser` is unavailable, use another repository-standard browser tool only when one is already part of the project workflow. Otherwise report that browser verification was not performed. Do not silently treat an unrun browser check as a pass.

For integration or workflow behavior, exercise the narrowest real boundary that proves the contract. Use synthetic or redacted data when records or sensitive values are involved, and follow [Records and sensitive data](records.md).

Do not run a full production build by default. Run it only when build output is part of the behavior being verified or the user requests it.

A failed check is evidence of failure. A check that could not run is unverified, not a pass. Report what was verified, the result, and what remains unverified.
