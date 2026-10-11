# Test Behavior, Not Implementation

Use this principle to judge whether a test is meaningful evidence. The TDD skill owns the normal test-writing workflow. This principle audits the quality of the test that results.

**When it applies:** An existing or proposed test relies heavily on mocks, constants, weak assertions, absence checks, test-built fixtures, or implementation details, or there is doubt that the test would fail for a real defect.

A strong test calls the subject through the interface its users rely on and checks an observable result. The expected result should be independent of the implementation under test. A literal expected value is often the clearest form, but the real requirement is independence.

Use the `undefined` check as a smell test: if every imported collaborator returned `undefined`, would this test still pass? If yes, inspect the assertion closely. It may not prove behavior. This is a diagnostic, not an automatic deletion rule.

Common weak shapes include:

- no assertion, or assertions such as `toBeDefined`, `toBeTruthy`, or `not.toThrow` with no behavioral result
- assertions only about whether a mock was called
- expected values computed by the same implementation being tested
- tests that merely restate a constant, config value, table row, or prompt string
- fixtures that assert only values the test itself constructed while the subject never performs meaningful work
- absence-only assertions where the positive behavior is never established

**Improve the evidence:** Run the subject with a concrete input and assert an observable output, state change, emitted payload, persisted value, or other user-visible effect. If a mock is necessary, assert the meaningful data or resulting behavior rather than only the call count. Delete a test only when no useful behavioral contract remains.

Compile-time type tests and tests of relationships across independent data structures can still be valid even when they do not fit the runtime pattern above.
