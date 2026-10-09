---
name: review-standards
description: Standards-axis review discipline for DAG review nodes, loaded through load_skills - pin the diff, find the documented coding standards, apply a Fowler smell baseline as labelled judgment calls, and report a PASS or FAIL standards verdict.
when_to_use: A DAG node, typically named review-standards, whose prompt asks whether a change follows the repository coding standards and loads this skill through load_skills.
---

# review-standards

Review only the Standards axis: documented repository coding rules and the code-smell baseline.
Another node, usually `review-spec`, checks whether the change implements the request.
Do not judge the spec or repeat that review.

Do the entire review yourself. Do not delegate.
A node cannot ask the user questions or wait for answers.
If input is missing or a decision is not yours, fail instead of guessing:

- `DAG_NODE_STATUS: failed: missing-input: <what is missing>` when something that should exist does not (an unresolved ref, an empty review target).
- `DAG_NODE_STATUS: failed: clarification: <question>` when only the user can decide (for example two standards documents contradict each other and nothing says which one wins).

## Step 1: pin the diff

Use the prompt's diff command verbatim.
First resolve named refs (`git rev-parse --verify <ref>^{commit}` for a commit ref).
If a ref does not resolve, end with `DAG_NODE_STATUS: failed: missing-input: <the ref that does not resolve>`.

| Review target | Read |
| --- | --- |
| Working tree | Run `git status --short --untracked-files=all` and the supplied diff command, or `git diff HEAD` if none is supplied. Read in-scope untracked files as additions, even if the tracked diff is empty. |
| Commit range | Review only that range. Unrelated working-tree files do not make an empty range non-empty. |

Exclude workflow-owned reports and files outside the prompt's review scope.

Record the exact command and, for a range, the commit list. This makes the review reproducible.

A working-tree target is empty only when it has neither tracked changes nor in-scope untracked additions.
A commit-range target is empty when that range has no changes.
Only then end with `DAG_NODE_STATUS: failed: missing-input: the review target is empty`.
New-file-only work is a valid target.

## Step 2: find the standards sources

Find every repository file that documents coding rules.
Examples include `CONTRIBUTING.md`, `CODING_STANDARDS.md`, `CLAUDE.md`, `AGENTS.md`, and convention sections in `README.md` or `docs/`.
If `CODING_STANDARDS.md` or `CONTRIBUTING.md` exists, include it.

Skip rules already enforced by formatters, linters, type checkers or pre-commit hooks. Do not report what those tools catch.
List the rule files in the report.
If none exist, say so and review only against the smell baseline.

## Step 3: the smell baseline

Always check these twelve Fowler smells (Refactoring, ch. 3), in addition to repository rules.
Use them even when no rules are documented.
Apply these two limits:

- **The repository overrides.** A documented repository standard always wins. Where it endorses something the baseline would flag, suppress the smell.
- **Always a judgment call.** Every smell is a labelled heuristic ("possible Feature Envy"), never a hard violation.

Each line reads what it is, then how to fix it.

- **Mysterious Name**: a function, variable or type whose name does not reveal what it does or holds; rename it, and if no honest name comes, the design is murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file of the change; extract the shared shape and call it from both places.
- **Feature Envy**: a method that reaches into another object's data more than its own; move the method onto the data it envies.
- **Data Clumps**: the same few fields or parameters keep travelling together; bundle them into one type and pass that.
- **Primitive Obsession**: a primitive or string stands in for a domain concept that deserves its own type; give the concept a small type of its own.
- **Repeated Switches**: the same `switch` or `if` cascade on the same type recurs across the change; replace it with polymorphism or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files of the diff; gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons; split it so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters or hooks added for needs nobody has stated; delete them and inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller should not depend on; hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward; cut it and call the real target directly.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits; drop the inheritance and use composition.

## Step 4: report

Write the report in your final answer.
Write a notes file only if the prompt names one.
Edit nothing else: no source, test or document files.

The standards report uses these three sections, in this order, each holding `none` when empty:

- `## Rule sources`: the files you reviewed against (Step 2), or `none - baseline only` when the repository documents nothing.
- `## Rule breaches`: each documented-standard violation cites the file and the rule it breaks, and the file and line in the diff that breaks it. These are hard findings.
- `## Judgment calls`: each possible smell is named as a judgment call ("possible Duplicated Code") and quotes the hunk.

Add one summary line with both counts and the worst issue, if any.
Keep the entire report within 400 words.
Do not judge the spec or report findings covered by tooling.

Close the report with the verdict as its own line:

- No documented-standard violation: the last line of the notes file is exactly `Standards verdict: PASS`. Judgment calls alone never fail the node.
- Otherwise the last line is exactly `Standards verdict: FAIL`, and the final line of your answer is `DAG_NODE_STATUS: failed: <n> documented-standard violations`.

Write the text Standards verdict: PASS nowhere else in the report, because the node's verify looks for it.

If requested, the notes file contains these sections and the verdict.
In the final answer, add the runtime-required `## Output` before the final status line.
Include key findings and the report path if a file was requested.
Do not add `## Output` to the notes file.
On PASS, finish with the completion line required by the prompt.

Adapted from mattpocock/skills (MIT), skills/engineering/code-review (Standards axis and smell baseline; the smells are from Fowler, Refactoring, ch. 3); see THIRD_PARTY_NOTICES.md at the repository root.
