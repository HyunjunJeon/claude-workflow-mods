---
name: testing
description: How DAG nodes prove code changes through public interfaces - red before green for new behavior and bug fixes, preservation checks for refactors, and mocks at system boundaries - loaded through load_skills.
when_to_use: A DAG node writes or changes code and has to prove the change with tests, so its prompt lists this skill in load_skills.
---

# testing

A node that changes code also owns its proof.
This skill covers useful tests, test boundaries, anti-patterns, test loops and mocking.
No one can answer questions during a node, and nothing waits for a reply.
Make those choices yourself and record each in `## Output` as `Ruling: <decision> - <why> - <cost if wrong>`.

Follow the repository's test runner, file layout, naming and assertion style.
The examples use bare `test` and `expect` as placeholders for that runner. Do not copy an import from here.

## What a good test is

A good test checks behavior through a public interface, not implementation details.
It remains valid when the implementation changes or is refactored.
Its name reads like a specification: "user can checkout with valid cart" identifies a capability.

```typescript
// GOOD: observable behavior, public API only
test("user can checkout with valid cart", async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe("confirmed");
});

// BAD: asserts how checkout works inside, breaks on a harmless refactor
test("checkout calls paymentService.process", async () => {
  await checkout(cart, paymentMethod);
  expect(paymentService.process).toHaveBeenCalledWith(cart.total);
});
```

Prefer one logical assertion per test.
Name what the code does, not how it works.
Verify through the interface: after `createUser`, call `getUser` instead of querying the database directly.

## Seams: where tests go

A test boundary (seam) is a public interface where behavior is observable without internal access.
Test at these boundaries, never against internals.

Choose test boundaries from the prompt's public interface: exported function, CLI command, HTTP route, tool schema or configuration format.
Focus on critical paths and complex logic; you cannot test every edge case, so the risk categories below choose which ones count.
Choose the boundary before writing its tests. Do not test at an undecided boundary.

List test boundaries in `## Output`, one line per boundary.
State what each test catches and misses.
Example: `checkout(cart, payment) - catches wrong status and total handling; misses real payment-provider behavior (faked at the boundary)`.

If the prompt and referenced code reveal no public interface, do not guess or test internals instead.
End with `DAG_NODE_STATUS: failed: clarification: <which interface should be tested>` so the orchestrator can answer.

### Which edge cases: risk categories

Pick the edge cases by the kind of boundary, not by what comes to mind.
For each boundary, find its row and write at least one named test per category, with an exact input and an exact expected result.
A category that cannot occur at that boundary is skipped; say why in `## Output`.

| Boundary kind | Categories |
| --- | --- |
| library, parser, evaluator | deep, numeric, encoding, state |
| CLI command | protocol, encoding, state, file |
| HTTP route | protocol, encoding, numeric, state |
| web UI | protocol (through its API), encoding (rendering, XSS) |
| file reader or generator | file, encoding, deep |
| data pipeline | numeric, encoding, state, deep |
| concurrent code | state (races, partial writes), protocol |
| auth | protocol, state |

- **deep**: nesting, recursion depth, very large input.
- **numeric**: zero, negative, limits, overflow, precision, off-by-one ranges.
- **encoding**: non-ASCII text, escaping, line endings, a value that breaks out of its format.
- **state**: repeated calls, call order, a failure halfway through, stale data.
- **protocol**: an unknown command, method or flag, a missing or extra argument, the error status or exit code.
- **file**: a missing or unreadable file, an existing output, paths with spaces or `..`.

Add the risks the domain itself implies: circular references in a spreadsheet, path traversal in a site generator's slugs.
Skip the examples the prompt or spec already gives; the main tests cover them.
Auth also needs a security review; that is the run's `review.security` axis, not this table.
In `## Output`, add the categories each boundary covers to its boundary line.

## Anti-patterns

- **Implementation-coupled**: mocks internal collaborators, tests private methods, asserts on call counts or call order, or verifies through a side channel (querying the database instead of using the interface). The tell: the test breaks when you refactor and behavior has not changed.
- **Tautological**: the assertion recomputes the expected value the way the code computes it (`expect(add(a, b)).toBe(a + b)`, a constant asserted equal to itself, a "snapshot" produced by running the code under test), so it passes by construction and can never disagree with the code. Expected values come from an independent source of truth: a known-good literal, a worked example, the spec. Write `expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15)`, not a `reduce` that mirrors the implementation.
- **Horizontal slicing**: writing all the tests first, then all the code. Bulk tests verify imagined behavior, test the shape of things instead of what callers see, go insensitive to real changes, and commit you to a test structure before you understand the implementation. Work in vertical slices instead: one test, then one implementation, repeat. Each test is a tracer bullet that responds to what the previous cycle taught you.

## Rules of the loop

State the mode in `## Output`.
For mixed changes, supply the evidence for each applicable mode.

When changing existing tests or check policy, record the affected behavior or control, why the task requires the change, and the replacement proof in `## Output`. Do not delete tests, add skip/todo/only, weaken assertions or mocks, narrow discovery, or relax lint/type/security/verify or permission settings merely to make a run pass. A changed requirement can make an assertion stale, but the new assertion must still detect the relevant defect. Removing a prose-only assertion or moving equivalent coverage is not itself a loss of proof.

| Mode | Required procedure and evidence |
| --- | --- |
| **New behavior or bug fix: red before green** | Write the failing test first. Confirm failure for the requested behavior, not a typo, import error or broken fixture. Record the command and failure output. Implement only enough code to pass. Record the passing result. Do not anticipate future tests or add speculative features. |
| **Behavior-preserving refactor: green before and after** | Run relevant existing tests before editing and after the refactor. Record both results and the behavior covered. If coverage is missing, add characterization tests first; they should pass against the original behavior. Do not break production code to manufacture a red baseline. |
| **Tests for existing behavior: initial green is valid** | Use assertions from the public contract or independently established examples. Record added coverage and the passing command. If sensitivity is uncertain, use a controlled negative case or temporary mutation in an isolated copy. Show that the assertion detects the relevant defect. Restore the mutation before final verification. Do not change correct production behavior to justify a test. |

**One slice at a time.** For behavior changes, use one boundary, one test and one minimal implementation per cycle.
Then run the suite for that area.
Keep behavior-preserving cleanup separate from red-to-green work and within the node's scope.

**Never hide a test run.** Run tests in the foreground and read their summary line.
Do not wait on a test inside a loop (`until npm test; do sleep 5; done`), and do not throw its output away (`npm test > /dev/null`).
A hung test then looks like a slow one, and your turn or the 30-second verify limit runs out with no failure to read.
A test that hangs is a failing test: find the loop or the wait in the code under test.

## Mocking

Mock at system boundaries only:

- external APIs (payment, email, and similar)
- time and randomness
- the database, sometimes (prefer a test database when the repository has one)
- the file system, sometimes (prefer a temporary directory)

Never mock your own classes or modules, internal collaborators, or anything you control. If you are tempted to, the seam is in the wrong place.

Make system boundaries easy to fake.
Pass the external dependency into the code instead of creating it inside. This is dependency injection.

```typescript
// Easy to fake: the client comes in
function processPayment(order, paymentClient) {
  return paymentClient.charge(order.total);
}

// Hard to fake: the client and its secret are built inside
function processPayment(order) {
  const client = new StripeClient(process.env.STRIPE_KEY);
  return client.charge(order.total);
}
```

Prefer SDK-style interfaces to one generic fetcher.
Use one function per external operation, such as `getUser`, `getOrders` and `createOrder`.
Each fake returns one specific shape. Test setup needs no conditional logic.
The tested endpoints are visible, and each has its own type.
A single `fetch(endpoint, options)` wrapper makes the fake branch on the endpoint.

## In a DAG node

The node owns the change and its proof.
Its declared `verify` should run the test file or area suite that covers the change.
The plugin reruns that proof after the report.
Use the evidence for the mode above: red-to-green, before-and-after green, or independent assertions with a passing run.
An initially passing test is not necessarily vacuous.
An assertion that passes by construction or cannot detect a relevant defect is not evidence.
