---
name: debugging
description: Discipline for DAG nodes that diagnose or fix a failing behavior, loaded through load_skills.
when_to_use: A node prompt asks the worker to find the cause of a bug, a failing test or a performance regression, or to fix one using a reproduction command produced by an earlier node.
---

# debugging

Use this skill for difficult bugs inside a DAG node.
A node worker cannot ask anyone questions or wait for answers.
Put content that would require consultation in `## Output`.
If only a person can supply missing information, stop with `DAG_NODE_STATUS: failed: clarification: <question>` as the final report line.

Two node roles use this skill:

| Role | Work |
| --- | --- |
| **Diagnosis node** | Run phases 1 to 4. Follow the Output template below. |
| **Fix node** | Run phases 5 and 6 with the reproduction command from the prompt. |

Diagnosis may edit tracked source only for temporary instrumentation tagged as in Phase 4, within its declared write scope.

The fix node runs the reproduction command first:

- If it exits 0, change nothing. End with `DAG_NODE_STATUS: failed: missing-input: reproduction no longer fails`.
- If it fails differently from the prompt, change nothing. Report the observation. End with `DAG_NODE_STATUS: failed: missing-input: reproduction fails differently: <symptom>`.

Skip a phase only when your prompt says so or you can justify it in `## Output`.

## Redact

Redact secrets before reporting commands, outputs or captured artifacts. Replace each secret with `<REDACTED>`.
Use environment variables in loops so credentials stay out of written content.
Captured artifacts carry auth headers. Quote only the lines needed for diagnosis.

If the redacted output is not enough to diagnose the bug, end with `DAG_NODE_STATUS: failed: clarification: <what redacted artifact or access is needed>`.

## Phase 1: Build a feedback loop

The main task is a precise pass/fail signal for this bug.
Bisection, hypothesis tests and instrumentation depend on that signal; the remaining work is mechanical.
Reading code cannot replace the signal.
Give this step extra effort. Try different approaches before giving up.

### Ways to construct one, in roughly this order

1. **Failing test.** Use a test boundary that reaches the bug: unit, integration or end to end.
2. **HTTP script.** Use curl or a small client against a dev server you start.
3. **CLI invocation.** Supply a fixture and compare stdout with a known-good snapshot.
4. **Headless browser script.** Use Playwright or Puppeteer to drive the UI and assert on DOM, console or network.
5. **Replay a captured trace.** Save a real request, payload or event log to disk. Replay it through the code path in isolation.
6. **Throwaway harness.** Start a minimal system, such as one service with mocked dependencies. Reach the bug with one call.
7. **Property or fuzz loop.** For "sometimes wrong output", try 1000 random inputs and look for the failure.
8. **Bisection harness.** If the bug appeared between two known commits, datasets or versions, automate "boot at state X, check, repeat". Use `git bisect run` to drive it. Bisect only in a separate checkout outside the project. Use `git worktree add` with a temporary directory, then remove it afterwards. Never bisect in the shared working tree: it moves HEAD while other nodes write there.
9. **Differential loop.** Run the same input on old and new versions, or two configurations. Compare the outputs.

### Tighten the loop

Once you have a loop, make it better:

- Faster: cache setup, skip unrelated init, narrow the test scope.
- Sharper: assert on the specific symptom, not "did not crash".
- More deterministic: pin time, seed the RNG, isolate the filesystem, freeze the network.

A 30-second flaky loop gives little benefit. A 2-second deterministic loop is much more effective.

### Non-deterministic bugs

The goal is a higher reproduction rate, not a clean repro. Loop the trigger 100 times, run it in parallel, add stress, narrow timing windows, inject sleeps. A bug that fails 50% of the time is debuggable; one that fails 1% is not until you raise the rate.

### When you cannot build a loop

Do not guess. List what you tried, then end with `DAG_NODE_STATUS: failed: clarification: <what environment access, redacted artifact or permission is needed>`. Examples of what to ask for: access to the environment that reproduces it, a redacted captured artifact (HAR file, log dump, core dump), or permission to add temporary instrumentation to a deployed system. Form no hypothesis without a loop.

### Completion criterion

Phase 1 is done when you can name ONE command (a script path, a test invocation, a curl) that you have already run at least once, with its invocation and redacted output recorded, and that is:

- [ ] **Red-capable**: it drives the real bug path and asserts the exact symptom, so it can go red on this bug and green once fixed. "Runs without erroring" does not count.
- [ ] **Deterministic**: the same verdict every run (for flaky bugs, a pinned and high reproduction rate).
- [ ] **Fast**: seconds, not minutes.
- [ ] **Runnable unattended**: no step needs a person.

If you catch yourself reading code to build a theory before this command exists, stop. Jumping to a hypothesis is the exact failure this skill prevents. No red-capable command, no Phase 2.

## Phase 2: Reproduce and minimise

Run the loop and watch it go red. Confirm:

- [ ] It produces the failure your prompt describes, not a different failure nearby. Wrong bug means wrong fix.
- [ ] It fails across multiple runs, or at a high enough rate for a non-deterministic bug.
- [ ] You captured the exact symptom (error message, wrong output, slow timing) so a later node can verify the fix addresses it.

Reduce the repro to the smallest scenario that still fails.
Remove inputs, callers, configuration, data and steps one at a time.
Rerun after each removal. Keep only elements needed for the failure.
Stop when removing any remaining element makes the loop pass.
This reduces possible causes and supplies the Phase 5 regression test.
Keep temporary harnesses and fixtures untracked, in the scratchpad or within the declared write scope.

## Phase 3: Hypothesise

Write 3 to 5 ranked hypotheses before testing any.
One hypothesis can bias you toward the first plausible idea.
Each must be falsifiable and predict a result:

> If X is the cause, changing Y will make the bug disappear or worse.

If a hypothesis has no prediction, refine or discard it.
Put the ranked list in `## Output`.
Do not show it to anyone first or wait for feedback. Proceed with your ranking.

## Phase 4: Instrument

Each probe must map to a specific prediction from Phase 3. Change one variable at a time.

Tool preference:

1. Use a debugger or REPL if available. One breakpoint is more useful than ten logs.
2. Use targeted logs at boundaries that distinguish hypotheses.
3. Never "log everything and grep".

Tag every debug log with a unique prefix such as `[DEBUG-a4f2]`.
A tag lets one search find logs for cleanup; untagged logs can remain unnoticed.
Before diagnosis ends, remove its instrumentation and search for the tag to confirm removal.
Record findings in `## Output`, not in the code.

For performance regressions, logs are usually unsuitable.
First measure a baseline with a timing harness, `performance.now()`, profiler or query plan.
Then bisect. Measure before fixing.

## Phase 5: Fix and regression test

Decide whether the regression test has a suitable test boundary (seam).
It must exercise the real bug pattern at its call site.
A shallow test can give false confidence: one caller cannot reproduce a multi-caller bug.
Likewise, a unit test may miss the chain that triggered the bug.

If no correct seam exists, record that as a finding in `## Output`: the architecture is preventing the bug from being locked down. Do not fake a test.

If one exists:

1. Turn the minimised repro into a failing test at that seam.
2. Watch it fail. If you forced the red by mutating code or a fixture, `diff` against a pristine copy to prove the mutation landed.
3. Apply the fix.
4. Watch it pass.
5. Re-run the Phase 1 loop against the original, un-minimised scenario.

## Phase 6: Cleanup

Required before you report done:

- [ ] Rerun the Phase 1 loop and confirm the original repro no longer fails.
- [ ] The regression test passes, or `## Output` records the absence of a seam.
- [ ] Search for the tag and confirm no `[DEBUG-` instrumentation remains.
- [ ] Delete only your disposable prototypes within the declared write scope. Keep the reproduction script and all files it, the regression tests or any `verify` needs. This includes indirectly loaded fixtures and helpers. They must run after your report and during final audit. Untracked files can still be required.
- [ ] State the correct hypothesis in `## Output` so future debuggers can use the finding.

## Output template

A diagnosis node ends its report with an `## Output` containing these fields:

```
Reproduction command: <the exact argv line, runnable from the project root>
Observed failure: <exit code and the symptom line, redacted>
Hypotheses:
1. If <X> is the cause, changing <Y> will make the bug disappear or worse. (ranked, falsifiable; 3 to 5 in total)
Root cause: <file and line, or "not yet determined">
```

Adapted from mattpocock/skills (MIT), skills/engineering/diagnosing-bugs; see THIRD_PARTY_NOTICES.md at the repository root.
