---
name: anti-slop
description: Discipline that keeps meaningless code out of a change in any language - dead weight whose removal changes no behavior, types and casts that throw away what the code knows, module-patching tests, and Clean Code readability calls - loaded through load_skills by nodes that write code and by review-standards, with a scan after every Edit and Write for the shapes a pattern can find.
when_to_use: A DAG node writes or changes code and lists this skill in load_skills, a review-standards node checks a change against it, or an anti-slop scan note appears after an Edit or Write.
---

# anti-slop

Every line a change adds must carry evidence or signal.
Code is slop when deleting or simplifying it changes no behavior, or when it throws away what the program already knows.
Generated code is prone to it because each piece looks reasonable on its own.

## How it is enforced

1. **Scan.** After every Edit or Write, in the main conversation and in DAG nodes, the plugin scans the added lines for the patterns marked `scan:` below and shows each hit after the tool's result. It sees shapes, not meaning.
2. **Writing.** A node that writes code checks its own diff against the whole list before reporting (see Writing code).
3. **Review.** review-standards applies the list. A hard pattern the diff proves fails the standards verdict (see Reviewing).

## Severity

- **Hard**: removing or simplifying the code provably changes no behavior, or the code discards evidence the program had. Sections 1 to 4.
- **Judgment**: readability (section 5), plus three hard patterns marked "judgment at review", because deciding that they apply takes reading, not proof. Fix these when writing. At review they never fail the verdict.

## Scope

- Only lines the change adds or edits count. Code outside the change is never a finding and never a reason to edit.
- **Never change behavior.** Every fix keeps what the code does for every input, including edge values (`''`, `0`, `false`, an empty list) and data read from disk or the host. A fix that would change behavior is not a fix; leave the code and name the pattern.
- **The repository overrides.** A documented repository rule (CLAUDE.md, AGENTS.md, CONTRIBUTING and similar) that endorses a pattern suppresses it. A line `anti-slop allow: <pattern ids>` in the root CLAUDE.md, AGENTS.md or CONTRIBUTING.md turns those patterns off in the scan too. Surrounding code that already uses a pattern is not an exemption.
- What a formatter, linter or compiler already enforces in the repository is not a finding.
- The examples name TypeScript (TS), JavaScript (JS), Python, Go, Java, Rust and Ruby. Apply each rule to the same construct in any language; a language without the construct is outside that rule.

## 1. Dead weight (hard)

- **Leftovers.** Debug statements (`debugger`, `breakpoint()`, `dbg!`, `binding.pry`, `e.printStackTrace()`), commented-out code, imports, variables or parameters the change introduced but never uses, and `TODO` stubs standing in for requested behavior. Remove them. Requested behavior that is not done is a failure to report, not a TODO. scan: `debug-leftover`, `commented-out-code`, `todo-stub`
- **A handler that adds nothing.** An empty `catch`, `except: pass`, `if err != nil {}` or `rescue; end` swallows the error; a handler that only rethrows the same error does nothing. Let the error propagate, or handle it with a decision the caller can observe. Exempt: a comment inside the handler that says why the error is ignored, and a rethrow-only handler placed before a broader one to exclude its errors. scan: `swallowed-error`, `rethrow-only-catch`
- **Boolean ceremony.** `c ? true : false`, `if (c) return true; return false`, `True if c else False`, `x == true`. Return or use the condition itself. scan: `boolean-ceremony`
- **A pass-through variable.** `const result = f(); return result`, where the name adds nothing the call does not say. Return the expression. A specific name that documents the value is fine. scan: `pass-through-variable` (generic names such as `result`, `data`, `tmp`)
- **A comment that restates the code** (judgment at review). `// increment the counter` above `count++`, a docstring that repeats the signature. Delete it. Keep comments that give the why: a constraint, a measurement, a rejected alternative.
- **A guard for a state that cannot occur** (judgment at review). A null check on a value the type or every caller already guarantees, a `default` branch after a closed union is exhausted, a retry around a call that cannot fail transiently. Delete it. If the state can occur, keep the guard and handle the state.
- **An abstraction nobody needs yet** (judgment at review). An interface with one implementation, a factory or strategy for one product, a configuration option nobody sets, a wrapper that passes its input unchanged to one other call. Inline it until a second real use appears.

## 2. Evidence thrown away (hard)

- **A top type in a contract.** A parameter, return type or type alias typed as the language's top type when the code handles something specific: `unknown`, `any` or `object` (TS), `Any` (Python), `interface{}` or `any` (Go), `Object` (Java), `object` or `dynamic` (C#). It pushes the parsing job onto every caller. Use the type the code handles and parse outside data into it once, at the boundary. Exempt: the raw input of a function whose only job is to parse or validate outside data, the parameter a type predicate narrows (`(value: unknown): value is User`), an error `cause`, a catch binding, and a generic constraint. scan: `top-type` (in TS only `any` and `object`, since the scan cannot tell a parser's `unknown` input from a lazy one)
- **An open dictionary as a contract.** `Record<string, unknown>`, `{ [key: string]: any }`, `dict[str, Any]`, `map[string]any`, `Map<String, Object>`. Name the fields with a type, record, dataclass or struct, or use finite keys. Exempt: a parser's intermediate value right after a type predicate such as `value is Record<string, unknown>`. scan: `open-dictionary`
- **Widening a known value.** A value of a known type flows into a broader annotation that forgets it: `const handlers: Record<string, Handler> = { start }` loses the `start` key, and passing a typed `User` to a `(value: unknown) => value is User` guard re-checks what is proven. Let inference keep the type (`satisfies` in TS), and call guards only on unparsed input. Exempt: an empty accumulator such as `const byId: Record<string, User> = {}`.
- **Widen, then assert back.** A value stored as a top type or a broad record and later cast to a narrower type. Keep the original binding and its type.
- **A chained assertion.** `x as unknown as User` forges evidence the compiler refused. Parse the value, or fix the source type. scan: `chained-assertion`
- **An assertion without a reason.** Every unchecked conversion needs a comment directly above it naming the invariant that makes it true, such as `// SAFETY: parseUserId validated the id before branding it.`: `as T` (TS), `cast()` (Python), `x.(T)` without `, ok` (Go), `(User) obj` (Java), an `unsafe` block (Rust), a non-null `!`. If no invariant can be named, the conversion is wrong; parse or use the checked form (`instanceof` patterns, `, ok`) instead. Exempt: `as const`. scan: `unreasoned-assertion`
- **A suppression without a reason.** `@ts-ignore`, `@ts-expect-error` or `eslint-disable` with no reason after it, `# type: ignore` or `# noqa` without a code, a bare `//nolint`, `@SuppressWarnings` without a comment. Name the rule and the reason, or fix the code. scan: `suppression-without-reason`
- **Ad hoc runtime type checks.** `typeof`, `isinstance` or `instanceof` scattered through logic re-decides a type the program should already know. Narrow once, inside a function whose only job is to parse or validate outside input, and pass typed values on. Exempt: existence probes such as `typeof window === 'undefined'`.
- **Reflection by name.** `Reflect.get` and `Reflect.apply`, `getattr(obj, "name")`, `getClass().getMethod("name")`. They bypass the type checker for a member the code could name directly. Use property access or a direct call; parse outside data first. scan: `reflection`

## 3. Tests (hard)

- **Patching modules.** `vi.mock`, `jest.mock`, `Mockito.mockStatic`, `mockConstruction`, PowerMock, or `mock.patch("<project module>")` replace the project's own code behind the test's back, so the test proves wiring no reader can see. Pass the dependency in and hand the test a fake at that seam, as the Mocking section of `dag-workflow:testing` describes. Exempt: the clock, randomness and environment variables through a fixture the test framework provides. scan: `module-mock` (JS, TS and Java)

## 4. JavaScript and TypeScript forms (hard)

- **Two eager passes.** Adjacent `.filter(...).map(...)` or `.map(...).filter(...)` on an array builds a throwaway array. Use one pass: `flatMap`, a loop that pushes, or an iterator pipeline (`.values().filter().map().toArray()`) where the runtime has one. Check callback indexes and truthiness before rewriting. scan: `two-pass-filter-map`
- **Copying the accumulator.** A `reduce` callback that returns `{ ...acc }`, `[...acc, x]`, `Object.assign({}, acc, ...)` or `acc.concat(...)` re-copies everything gathered so far on every step. Mutate the accumulator the reduce started with and return it. scan: `growing-copy`
- **Conditional empty spread.** `...(timeout !== undefined ? { timeout } : {})`. Assign the field directly when the consumer accepts `undefined`; otherwise set it in a plain `if` after building the object. scan: `conditional-empty-spread`

## 5. Readability (judgment)

Clean Code rules that hold in any language.

- **Deep nesting.** More than three levels of nested blocks where an early return or a guard clause would flatten them.
- **A flag argument.** A boolean or mode parameter that switches a function between behaviors, so call sites read `render(doc, true)`. Split the function, or pass a named option.
- **An unnamed magic value.** A literal with domain meaning (a limit, a timeout, a status code) used more than once, or whose meaning the use site does not show. Name it as a constant, with the source of the number in its comment.
- **A query that changes state.** A function named as a question (`get`, `is`, `has`, `find`, `check`) that also writes, mutates its arguments or does I/O beyond reading. Rename it to say the effect, or split the read from the write. Exempt: memoization.
- **A double negative.** `if (!isNotReady)`, `disableNoCache`. Name the positive.
- **A name that describes form, not meaning.** `UserShape`, `userList`, `strName`, `dataObj`. Name the concept: `User`, `users`, `name`. Exempt: members the code does not own (`schema.shape`) and naming conventions the repository documents.
- **One function, several jobs.** A new function whose name needs "and", or whose body mixes levels such as parsing, policy and I/O. Split it where the level changes.

Left out on purpose: formatting (indentation, spacing, wrapping, import order) belongs to the formatter and the file's existing style. Fixed limits on function length or argument count push generated code into single-use helpers, which are dead weight under section 1. "Comments are a failure" is wrong here: a comment that gives the why is required.

## Writing code

Treat each scan note after an Edit or Write as a review comment: fix the hit, or keep the code and name the exemption or repository rule in `## Output`.
Before you report, read your own diff (`git diff` plus any new files) against sections 1 to 5, including what no scan can see.
Fix every hit in the lines you added or edited, hard or judgment, and leave neighbouring code alone.
Do not trade one pattern for another: replacing `as User` with `as unknown as User`, or silencing a check with a disable comment, is still a hit.
Reuse logic the change or the repository already has instead of writing it again.

## Reviewing

In a review-standards node, this skill is a rule source: list `dag-workflow:anti-slop` under `## Rule sources`.
A hard pattern from sections 1 to 4 is a breach under `## Rule breaches` only when the diff proves it.
Quote the added line as file:line, name the pattern, and give the proof in a few words: for dead weight, why removing it changes no behavior; for thrown-away evidence, the type the code had.
Write each breach as `anti-slop: <pattern> - <file:line> - <proof>; <fix>`.

Patterns marked "judgment at review" and everything in section 5 go under `## Judgment calls` as `possible anti-slop: <pattern> - <file:line>`, never under breaches.
Where a pattern is also a smell in the review-standards baseline (an abstraction nobody needs is Speculative Generality or Middle Man), report it once, under the smell's name.
A hit you cannot prove from the diff, or one an exemption or a repository rule covers, is not a breach; record it as a judgment call only if it is worth a reader's attention.
