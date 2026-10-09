# P3 audit notes

Audited on 2026-10-08 against the working tree (uncommitted changes on top of bc52ef4), run dag_muzcda2e_72zpec, node final-audit, attempt 1. The plan audited is Phase 3 (items 3a-3e) of docs/improvement-plan.md, read with `git show bc52ef4^:docs/improvement-plan.md`. Everything below was re-read or re-run in this node; no upstream Output was trusted. All commands ran from the project root. The probe copy for item 3 lived in a `mktemp -d` directory under `/var/folders/...` (outside the project) and was deleted afterwards (`ls` on it printed "No such file or directory"). The only file this node wrote inside the project is this one.

## Verdicts

Item 1 (3a protocol): PASS
Item 2 (3a eval metric): PASS
Item 3 (3b goal lint): PASS
Item 4 (3c skills/dag-interview): PASS
Item 5 (3d skills/dag-pm): PASS
Item 6 (3e dag-planning Alignment): PASS
Item 7 (README): PASS
Item 8 (whole result): PASS

## Evidence

### Item 1 - 3a protocol

- `grep -n protocolFor hooks/engine/policy.ts hooks/register.ts tests/policy.test.ts`: `hooks/engine/policy.ts:276: export function protocolFor(level: Enforcement, interactive = true): string`; `hooks/register.ts:1716` calls `protocolFor(enforcement, interactive)`.
- `interactive` is set at `hooks/register.ts:1544` (`interactive = e.isInteractive` inside `on('session.start', ...)`), as the plan says.
- `bun -e "import {protocolFor} from './hooks/engine/policy.ts'; console.log(protocolFor('strict', false).includes('Non-interactive session: do not ask the user'), protocolFor('strict').includes('Non-interactive'), protocolFor('strict') === protocolFor('strict', true))"` printed `true false true`, exit 0.
- Added line (git diff of policy.ts): `- Non-interactive session: do not ask the user (no AskUserQuestion, no clarifying questions); decide, and record every assumption in the definition's goal and in the node prompts.` It is pushed only when `!interactive`.
- `tests/policy.test.ts:252` test `a non-interactive session is told not to ask the user, an interactive one is not` asserts both directions for `strict` and `guide`: lines 255-256 `toContain` the non-interactive text for `protocolFor(level, false)`; lines 257-259 assert `protocolFor(level, true)` equals `protocolFor(level)` and that neither contains `Non-interactive session`; line 260 asserts the non-interactive text only appends to the interactive text. The test is among the passing tests of item 8.

### Item 2 - 3a eval metric

- `eval/run.ts:26` adds `askUserQuestions: number` to `TranscriptReport`.
- All three return statements of `readTranscript` carry it: line 80 (`askUserQuestions: 0`, no transcript directory), line 83 (`askUserQuestions: 0`, no transcript file), line 109 (`askUserQuestions`, the final return).
- Counter: `eval/run.ts:88` `let askUserQuestions = 0`; line 98 `if (block.type === 'tool_use' && block.name === 'AskUserQuestion') askUserQuestions += 1`. Line 94 `if (row.isSidechain || !Array.isArray(row.message?.content)) continue` runs before the block loop, so only main-conversation rows are counted.
- Column `AskUserQuestion calls`: header at line 203, separator at line 204, row template at line 188 (`${r.transcript.askUserQuestions}`). A script (`cells.ts` in the session scratchpad, with the `${...}` expressions stripped) counted the cells: header 21, separator 21, row 21. The new column is the 16th, directly after the 15th, `refusals (planning/tools)`.
- `bun eval/run.ts --list`: exit 0.

### Item 3 - 3b goal lint

- `hooks/engine/lint.ts` (git diff) pushes the warning last, before `return warnings`, when `definition.goal === undefined || definition.goal.trim() === ''`: `the definition has no goal - set "goal" to one sentence naming the deliverable and its observable done condition; every node sees it.`
- Probe: `eval/fixtures/valid-definition.yaml` has `goal:` on line 5. A copy without that line (`grep -v '^goal:'`, `diff` showed only the line-5 deletion) in a `mktemp -d` directory: `bun eval/check-definition.ts <copy>` printed `FAIL <copy>` and `  warning: the definition has no goal - set "goal" to one sentence naming the deliverable and its observable done condition; every node sees it.`, exit 1.
- Original: `bun eval/check-definition.ts eval/fixtures/valid-definition.yaml` printed `OK eval/fixtures/valid-definition.yaml (3 nodes)`, exit 0.
- The copy and its directory were deleted.
- `tests/lint.test.ts`: positive test at line 95 `a definition without a goal gets the goal warning, after every other warning` (goal `undefined`, `''` and `'   '`, exact text asserted); negative test at line 109 `the same definition with a goal gets no goal warning`. Both pass in item 8.

### Item 4 - 3c skills/dag-interview/SKILL.md

- Frontmatter line 4: `disable-model-invocation: true`.
- Headings: `## Design-tree rounds` (27), `## Ambiguity tracks` (50), `## Facts and decisions` (65), `## Refine` (90), `## Restate gate` (105).
- AskUserQuestion and the limit: lines 41-42, "In `AskUserQuestion`, put the recommended option first ... One call takes at most 4 questions."
- User-stated versus reading split: lines 92-103 (`Decision (user-stated)`, `Constraints (user-stated)`, `My reading`; "Never label your own inference as user-stated.").
- 3-answers-in-a-row rule: line 87, "If your last 3 answers in a row came from reading rather than from the user, send the next question to the user."
- Hand-off: lines 117-121, goal sentence becomes `definition.goal`, every acceptance criterion becomes a `verify` candidate, user-stated constraints go into node SCOPE lines; line 123 forbids `start` of the planned work before the user confirms.
- `grep -n -i -E "agent|write|edit" skills/dag-interview/SKILL.md` hits: line 20 ("It may never use Agent, Write, Edit or mutating Bash.") forbids the tools; line 21 ("... and write no file.") forbids writing; line 37 ("Write a body that states the decision and its options.") is wording advice for a question's text, not a tool call; line 77 ("Let that node write nothing but one notes file ...") belongs to the one-node DAG. No hit instructs the main conversation to use Agent, Write or Edit.
- `grep -n -i -E "ouroboros_|fanout|submit_|lane|seed" skills/dag-interview/SKILL.md`: no hits at all (exit 1), so nothing outside the attribution line (line 126, which names `Q00/ouroboros` without an underscore and does not match).
- Observation, not a criterion: line 72 calls the facts run "read-only", while line 77 lets that node write one notes file so that its `verify` can check a file. The writer is the node, never the main conversation.

### Item 5 - 3d skills/dag-pm/SKILL.md

- Frontmatter line 4: `disable-model-invocation: true`.
- Three question classes in the table at lines 32-36: product decision (Action: ask the user), technical decision (Action: defer to the development phase), unknown (Action: record it as an open item). Lines 38-44 add the three lists and the "Decide later" option.
- PRD by a one-node DAG: lines 61-72, `id`: `write-prd`, `category`: `writing`, `writes`: `docs/prd/<slug>.md`, `verify`: two file checks, one containing `## Open items` and one containing `## Goals`. Lines 74-86 list the eight sections, with `## Open items` written even when it holds only "None".
- `grep -n -i -E "agent|write|edit" skills/dag-pm/SKILL.md` hits: line 3 (frontmatter description, "a one-node DAG write the PRD"); line 16 ("It may NEVER use Agent, Write, Edit or mutating Bash."); line 57 ("Write nothing before the user confirms."); line 61 ("The main conversation cannot write files, so a one-node DAG writes the PRD."); lines 66-86 (`write-prd` node fields and the sections the node writes); line 88 ("Do not write the PRD yourself."); line 89 ("Do not try to spawn an agent."). Every hit forbids the tools for the main conversation or belongs to the one-node DAG.
- `grep -n -i -E "ouroboros_|fanout|submit_|lane|seed" skills/dag-pm/SKILL.md`: no hits (exit 1).

### Item 6 - 3e skills/dag-planning/SKILL.md

- `grep -n "^## "`: `## Alignment` at line 53, `## The shape` at line 72, so Alignment sits before The shape (and after `## Planning - MANDATORY first step`, line 23).
- Limits to one round: line 55 "ask at most one round of questions"; one AskUserQuestion call with at most 4 numbered questions (line 64).
- Only when ambiguous: lines 56-60, only when deliverable kind, scope or acceptance criteria is ambiguous and Read or `rg` cannot settle it; line 62 skips silently if nothing is ambiguous.
- Non-interactive: line 66, "If the injected protocol marks the session non-interactive, skip the round and decide."
- Points to both skills: line 68 names `/dag-workflow:dag-interview` and `/dag-workflow:dag-pm`; line 69 says they are user-invoked only and must never be invoked.

### Item 7 - README.md

- `grep -n -E "dag-interview|dag-pm|비대화형|AskUserQuestion calls|goal 누락" README.md` hits: `/dag-workflow:dag-interview` and `/dag-workflow:dag-pm` at lines 122, 131, 133, 139-140, 144; `비대화형` at lines 111, 122, 139; `AskUserQuestion calls` at line 432; `goal 누락` at line 127.
- Description against file:
  - Line 111 (protocol): `session.start`'s `isInteractive` false adds one line telling the model not to ask. Matches `hooks/register.ts:1544` and the `policy.ts` line.
  - Line 122 (Alignment): one round, only on real ambiguity, 4 numbered questions with a recommended first option, skipped when non-interactive, suggest but never invoke the two skills, goal to `definition.goal` and criteria to `verify`. Matches `skills/dag-planning/SKILL.md` lines 53-70.
  - Line 127 (goal 누락): warning for a missing or whitespace-only goal, one per definition, appended after the other warnings. Matches `lint.ts` and the lint tests.
  - Lines 131-139 (dag-interview): rounds, Q numbers, "(Recommended)" first, 4 per call, tracks and ledger, facts versus decisions, no polling, Refine, Restate gate, hand-off, clear request goes straight to planning, not applied when non-interactive. Matches `skills/dag-interview/SKILL.md`.
  - Lines 140-144 (dag-pm): three classes, "Decide later", confirm before writing, `write-prd` node with `writes` `docs/prd/<slug>.md`, the section order, verify on `## Open items` and `## Goals`. Matches `skills/dag-pm/SKILL.md`.
  - Line 432 (eval column): `AskUserQuestion calls` right after `refusals (planning/tools)`, main conversation only. Matches `eval/run.ts` (column 16 after column 15, `isSidechain` rows skipped).

### Item 8 - whole result

- `command claude plugin test .`: exit 0. `315 pass`, `0 fail`, `Ran 315 tests across 27 files. [3.69s]`; 0 `(fail)` lines in the output (run twice, same result).
- `command claude plugin validate .`: exit 0, `Validation passed with warnings`. The only warning is for `.claude-plugin/marketplace.json`: `description: No marketplace description provided`, unrelated to Phase 3.
- `bunx -p typescript@5 tsc -p . --noEmit`: exit 0, no output (about 1 s, the package was already cached).
- `git status --short` at the time of this audit (not a verdict criterion; the working tree holds uncommitted work from earlier phases; this notes file is the only addition this node makes):

```
 M README.md
 M eval/run.ts
 M flows/improvement/p3-alignment.yaml
 M hooks/engine/lint.ts
 M hooks/engine/policy.ts
 M hooks/register.ts
 M skills/dag-planning/SKILL.md
 M tests/lint.test.ts
 M tests/policy.test.ts
 M tests/runtime.test.ts
 M tests/shape.test.ts
?? AGENTS.md
?? hooks/engine/AGENTS.md
?? hooks/ui/AGENTS.md
?? skills/dag-interview/
?? skills/dag-pm/
?? tests/AGENTS.md
```

## Open checks

Eval 8 scenarios AskUserQuestion=0 check: NOT RUN (it spends account usage and takes 10-20 minutes)
Manual tmux interview check: OPEN

## Final verdict

Audit: PASS
