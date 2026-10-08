# P1 audit notes

Audited on 2026-10-08 against the working tree (uncommitted changes on top of b3f3149), run dag_muz7a22o_p3oq3l, node final-audit, attempt 2. This file replaces the notes of attempt 1. Everything below was re-read or re-run in this attempt; no upstream Output was trusted. The plan table audited is the Phase 1 table of docs/improvement-plan.md (V1, V2, V3; one warning per node with the check numbers collected; English messages; warnings only; shell wrappers out of scope).

## Commands

All commands ran from the project root. Probe files lived in directories made by `mktemp -d` under `/var/folders/...` (outside the project); every one was deleted afterwards (the scripts printed `PROBE_DIR_DELETED`, and `ls` finds no leftover `tmp.*` directory).

| # | Command | Expected | Captured result |
| --- | --- | --- | --- |
| 1 | `command claude plugin test .` | 0 failures | exit 0; last lines `312 pass`, `0 fail`, `Ran 312 tests across 27 files. [3.47s]`; 312 `(pass)` lines, 0 `(fail)` lines; the 7 `tests/lint.test.ts` blocks all show `(pass)` |
| 2 | `command claude plugin validate .` | exit 0 | exit 0, `Validation passed with warnings`; the only warning is `.claude-plugin/marketplace.json`: `description: No marketplace description provided` (not related to P1) |
| 3 | `rg -n 'vacuous' tests/policy.test.ts` | no hit | no output, rg exit 1; `rg -l 'vacuous' tests/` lists only `tests/lint.test.ts` |
| 4 | `rg -n '^## ' README.md` | 18 headings | 18: 불러오기 13, 사용법 29, 실제 사용 예 59, 강제 102, 계획 스킬 117, 결과 전달 127, 정의 형식 134, Jev 를 활용한 자동 판단 190, 검증 206, 자동 복구 239, 컨텍스트 보존 249, 판단 기록 257, 세션과 인계 261, 실행 규칙 273, DAG 패널 296, 설정 357, DAG 형태 평가 387, 개발 411; `git show HEAD:README.md` also has 18 |
| 5 | `rg -n '^## ' skills/dag-planning/references/planning.md` | 8 headings | 8: Decomposition doctrine 7, Category routing 33, Edges, data and write scopes 63, Composing runs 71, Node prompt contract 82, The `verify` contract 103, Verification wave 117, Failure playbook 128; `git show HEAD:` also has 8 |
| 6 | `grep -c '^test(' tests/lint.test.ts` | at least 6 | 7 |
| 7 | `git diff --numstat` of the five modified tracked files | additive docs and lint, fixture-only test edits | README.md +16/-0, planning.md +4/-0, lint.ts +38/-1 (the -1 is the import line gaining `VerificationCheck`), policy.test.ts +3/-3, runtime.test.ts +1/-1; the policy/runtime lines are fixtures only (`contains: 'ok'` added to three file checks, `VERIFY` argv `['check-control']`), no assertion changed |
| 8 | `bun eval/check-definition.ts eval/fixtures/valid-definition.yaml flows/improvement/p1-vacuous-verify.yaml` | OK for both, exit 0 | `OK eval/fixtures/valid-definition.yaml (3 nodes)`, `OK flows/improvement/p1-vacuous-verify.yaml (5 nodes)`, exit 0 |

Pass count recorded: 312 pass, 0 fail, 27 files. `tsc` was not run: it is not an item of this node, there is no local `node_modules/.bin/tsc`, and `bunx` would fetch a package.

## Probes

Each probe is a single node `n` whose prompt holds all five contract markers (`TASK: x. DELIVERABLE: y. SCOPE: z. VERIFY: w. STOP WHEN: done.`), run with `bun eval/check-definition.ts <probe>`. A FAIL consisted only of lines starting `  warning: node "n": vacuous verify`. In the "Actual" column, `...` stands for the closing text of every vacuous warning: ` - declare a file check with nonempty contains text, or a command that exits nonzero when the deliverable is wrong.`

### Required probes

| Probe | Definition under test | Expected | Actual |
| --- | --- | --- | --- |
| v1-pos | one file check `a.md`, no contains | FAIL (exit 1), warning names check 1 | exit 1; `node "n": vacuous verify - check 1 is a file check without contains, so it only proves the file exists (touch passes it) ...` |
| v1-neg | same file check with `contains: x` | OK (exit 0) | exit 0; `OK v1-neg.yaml (1 nodes)` |
| v2-pos | eight command checks: `true`, `:`, `echo ok`, `printf ok`, `exit 0`, `yes`, `sleep 1`, `/bin/true` | FAIL, ONE warning naming checks 1-8 | exit 1; one warning line: `check 1 runs true, which always passes; check 2 runs :, ...; check 3 runs echo ...; check 4 runs printf ...; check 5 runs exit ...; check 6 runs yes ...; check 7 runs sleep ...; check 8 runs true, which always passes ...` (the `/bin/true` basename is stripped) |
| v2-neg-bun-test | command `bun test` | OK | exit 0, OK |
| v2-neg-git-diff | command `git diff --check` | OK | exit 0, OK |
| v3-pos | eight command checks: `test -e a.md`, `test -f a.md`, `test -d out`, `test -s a.md`, `[ -f a.md ]`, `ls a.md`, `stat a.md`, `cat a.md` | FAIL, ONE warning naming every check number | exit 1; one warning line: `check 1 only tests that a path exists; ...; check 8 only tests that a path exists ...` with all eight numbers |
| v3-neg-n | `test -n x` | OK | exit 0, OK |
| v3-neg-r | `test -r x` | OK | exit 0, OK |
| v3-neg-grep | `grep -q x a.md` | OK | exit 0, OK |
| coll-one-node | node with check 1 file without contains, check 2 file with contains `x`, check 3 `true` | FAIL, exactly ONE warning naming check 1 and check 3, not check 2 | exit 1; one warning: `check 1 is a file check without contains, ... (touch passes it); check 3 runs true, which always passes ...`; the string `check 2` is absent |
| coll-two-nodes-2 | nodes `m1` (file without contains) and `m2` (`true`), plus a sound node `verify-all` (category `unspecified-low`, depends on both, file with contains and `bun test`) | FAIL, exactly TWO warnings, one per vacuous node | exit 1; exactly two lines: `node "m1": vacuous verify - check 1 is a file check without contains ...` and `node "m2": vacuous verify - check 1 runs true, which always passes ...`; nothing for `verify-all` |
| coll-mixed | node `m1` with check 1 sound file check and check 2 `true`, plus a sound verifier | FAIL, ONE warning naming check 2 only | exit 1; one warning: `node "m1": vacuous verify - check 2 runs true, which always passes ...` |
| warnings-only | v1-pos, v2-pos, v3-pos, coll-one-node, coll-two-nodes (first variant) filtered with `grep` for `verification_required` or `invalid_verification` and for any non-warning line | no error-code line, no other line | 0 error-code lines in all five; vacuous warning lines 1, 1, 1, 1, 2; the only extra line was the existing quick-final-audit warning in the first coll-two-nodes variant, because my verifier node defaulted to `quick` (my probe's fault; coll-two-nodes-2 above fixes it and prints exactly two lines) |
| err-control | node without `verify` | error code, not a warning | exit 1; `verification_required: Declare verify checks for nodes: n. ...` (the error path is separate from the warnings and still works) |
| fp-fixture | the two repo files of Commands row 8 | OK for both | OK for both, exit 0 |
| fp-flows | `bun eval/check-definition.ts` on every `flows/improvement/*.yaml` | OK, or a warning is a finding | `p0-eval-baseline.yaml` OK (7 nodes), `p1-vacuous-verify.yaml` OK (5 nodes), `p2-planning-doctrine.yaml` OK (12 nodes), `p3-alignment.yaml` OK (9 nodes); each exit 0; no warning, so no finding; no flow file was edited |

### Pre-existing warnings (item 3), probed through the same checker

| Probe | Definition under test | Expected | Actual |
| --- | --- | --- | --- |
| pre-no-markers | prompt `do something` | missing TASK and STOP WHEN | `node "n": the prompt lacks TASK: and STOP WHEN - follow the node prompt contract (TASK, DELIVERABLE, SCOPE, VERIFY, STOP WHEN).` |
| pre-host-blocked | file check on `REPORT.md` with contains | host-blocked report name | `node "n": "REPORT.md" is named like a report, and Claude Code 2.1.288 refuses subagent writes to REPORT*, ... use a different name such as n-notes.md ...` |
| pre-under-split | one producer, `writes` a.md, b.md, c.md | under-split producer | `node "n": one producer owns 3 files (a.md, b.md, c.md) - give each independent file its own node ...` |
| pre-no-verification-node | two producers, no verification node | missing verification node | `the graph has no verification node - add a node that depends on the producers ...` |
| pre-quick-final-audit | `verify-all` on `quick` depending on two producers | quick final audit | `node "verify-all": the final audit requires judgment across inputs, while quick is reserved for mechanical checks - it runs on unspecified-low instead ...` |

### Extra edge probes (not required; run to hunt for false positives and negatives)

| Probe | Definition under test | Expected by the code and plan | Actual |
| --- | --- | --- | --- |
| x-bracket-e | `[ -e a.md ]` | FAIL (V3) | FAIL, `check 1 only tests that a path exists` |
| x-usr-bin-test | `/usr/bin/test -d out` | FAIL (basename) | FAIL |
| x-win-path (json) | `C:\tools\echo ok` and `C:\tools\bun test` | FAIL for check 1 only (backslash basename) | FAIL, `check 1 runs echo, which always passes`; check 2 not named |
| x-bracket-z | `[ -z x ]` | OK | OK |
| x-test-compound | `test -f a -a -f b` | OK (`-a` is another operator) | OK |
| x-test-or | `test -e a.md -o -n b` | OK (`-o`, `-n`) | OK |
| x-test-eq | `test a = b` | OK (no dash flag) | OK |
| x-test-no-flag | `test a` | OK | OK |
| x-bun-e | `bun -e process.exit(1)` | OK | OK |
| x-sh-c | `sh -c true` | OK (shell wrappers out of scope) | OK, no warning |
| x-case-True | `True` | OK (names are case sensitive) | OK |
| x-prefix-truefalse | `truefalse` | OK (exact basename match) | OK |
| x-exit-1 | `exit 1` | FAIL (V2 ignores arguments) | FAIL, `check 1 runs exit, which always passes` |
| x-test-negated | `test ! -e a.md` | FAIL by the literal V3 wording (`!` is not a dash argument) | FAIL, `check 1 only tests that a path exists` |
| x-empty-contains (json) | file check with `contains: ""` | refused before the lint | exit 1, `invalid_verification: contains must be nonempty text.` |

## Code and tests

- `hooks/engine/lint.ts` read in full. V1: `kind: 'file'` with falsy `contains` (line 60). V2: `ALWAYS_PASSING_PROGRAMS` = `true`, `:`, `echo`, `printf`, `exit`, `yes`, `sleep` (line 42). V3: `EXISTENCE_ONLY_PROGRAMS` = `ls`, `stat`, `cat` (line 43), and `test`/`[` (line 44) whose arguments starting with `-` are at least one and all in `-e`, `-f`, `-d`, `-s` (lines 45, 52-56). The program is the text after the last `/` or `\` of `argv[0]` (line 48). A check gets the first reason that applies: V1, V2, V3 (lines 58-66); the two sets cannot overlap. One warning per node lists every offending check with its 1-based number (lines 90-98). The message is English and the lint returns strings only, so nothing can refuse a definition. The loop sits after the host-blocked loop and before the producer under-split warnings.
- `hooks/register.ts` carries the lint output into `start` (lines 869-877, `warnings`), `amend` (line 958, `warnings`) and `/dag run` (lines 1136-1138, under `Warnings:`).
- `tests/lint.test.ts` read in full: 7 top-level blocks. V1 positive (line 15) and negative (23); V2 positive (27, all seven programs plus `/bin/true` and `C:\tools\echo`) and negative (42, `bun test`, `git diff --check`); V3 positive (47, `test` -e/-f/-d/-s, `[ -f x ]`, `/usr/bin/test`, `ls`, `stat`, `cat`) and negative (67, `-n`, `-r`, `[ -z ]`, `-f a -a -f b`, `a = b`, `grep -q`); collection (76: exact warning string, `check 2` absent, a sound second node adds nothing, `verificationProblem` is undefined). Every rule has a positive and a negative test and the count 7 is at least 6.
- `tests/policy.test.ts` holds no `vacuous` text (Commands row 3). Its diff is three fixture lines, no assertion.
- All five pre-existing warnings are still in `lintDefinition` (missing TASK or STOP WHEN lines 71-77, host-blocked 79-89, under-split producers 99-111, missing verification node 112-114, quick final audit 115-120) and the pre-existing probes above reproduced each one.
- Mutation check (extra): I copied the repo (without `.git` and `.claude/dag`) into a `mktemp -d` directory, confirmed the unmutated copy gives 312 pass, 0 fail, then applied one mutation at a time and ran `command claude plugin test` on the copy. All 12 mutants were caught by at least one test: drop `yes` (V2 positive), drop `:` (V2 positive), drop `sleep` (V2 positive), add `-n` to the flag set (V3 negative), drop `cat` (V3 positive), drop `[` (V3 positive), `some` instead of `every` (V3 negative), no dash flag required (V3 negative), no basename stripping (V2 and V3 positive), V1 disabled (V1 positive and collection), V1 inverted (8 failures), 0-based check numbers (V1, V2, V3 and collection). The copy was deleted (`MUTANT_DIR_DELETED`).

## Docs

README.md `## 검증` (line 206) gains `### 빈 검증 경고` (lines 223-237). planning.md section "The verify contract" (heading at line 103) gains four bullets (lines 108-111). I compared each statement with the code and with the probes above.

| Item | README.md `### 빈 검증 경고` | planning.md bullets 108-111 | Code and probes |
| --- | --- | --- | --- |
| Warning only | 225: "경고일 뿐이라 실행을 거부하지는 않습니다" | 108: "It is a warning only: the run still starts" | matches (no error code in any FAIL probe; lint returns strings) |
| One warning per node, check numbers | 225: "노드마다 경고는 하나이고 ... 위치(1부터 셈)로 모두 나열합니다" | 108: "one per node, naming each offending check by its 1-based number" | matches (coll-one-node, coll-two-nodes-2) |
| Where it shows up | 225: `start`/`amend` `warnings`, `/dag run` under `Warnings:`; message starts `node "<id>": vacuous verify - check 1 ...` | 108: `start` and `amend` return it | matches register.ts 869-877, 958, 1136-1138 and the real string |
| V1 | 229: file check without `contains`; `touch` passes it | 109: same | matches (v1-pos, v1-neg) |
| V2 list | 230: last path name of `argv[0]` is `true`, `:`, `echo`, `printf`, `exit`, `yes`, `sleep`; arguments irrelevant | 109: same seven programs, directory prefix stripped, arguments ignored | matches the set and the basename rule (v2-pos, x-exit-1, x-win-path) |
| V3 list | 231: `test`/`[` with at least one `-` argument and all in `-e`, `-f`, `-d`, `-s`; or `ls`, `stat`, `cat` | 109: `test`/`[` using only `-e`, `-f`, `-d`, `-s`, or `ls`, `stat`, `cat` | matches (v3-pos, x-bracket-e) |
| Not flagged | 233: `test -n`, `-r`, `-z`, or `test a = b`; `/bin/true` judged by last name | 109: other operators and no-flag `test a = b` not flagged | matches (v3-neg-*, x-test-eq, x-bracket-z) |
| First rule wins | 225: only the first matching rule applies to a check | not stated (not required) | matches lint.ts 58-66 |
| What to write instead | 235: a file check with `contains`, or a command that exits nonzero (tests, `grep -q`) | 110: nonempty `contains` text, or a command that exits nonzero | matches the warning text |
| `sh -c` limit | 237: the lint sees only the program name and the flags above; `sh -c '...'` is not analyzed, a `true` or `touch` inside gives no warning | 111: "reads only the program name in `argv[0]` and, for `test` and `[`, their dash flags: a shell wrapper such as `sh -c '...'` is not analyzed" | matches (x-sh-c is OK; `test`/`[` flags are read by `isExistenceTest`) |
| Headings | all 18 `## ` headings present, same as HEAD; the new block is a `###` inside `## 검증`; +16/-0 lines | all 8 `## ` headings present, same as HEAD; +4/-0 lines | matches Commands rows 4, 5, 7 |

Note on attempt 1: its notes reported that planning.md line 111 said the lint "reads only the program in `argv[0]`", which would contradict the code. I re-read the file in this attempt: line 111 now reads "The lint reads only the program name in `argv[0]` and, for `test` and `[`, their dash flags", which matches `isExistenceTest`. That mismatch is gone.

Observations that are not failures:
- docs/improvement-plan.md Phase 1 lists `tests/policy.test.ts` as the file for the lint tests, while the audit item and the work put them in `tests/lint.test.ts`. The V1-V3 table itself is implemented as written, and the item requires policy.test.ts to hold no V1-V3 test, which holds.
- README.md `## 계획 스킬` (line 125) and planning.md line 100 list when `start` returns warnings and do not include the vacuous verify warning (nor the older host-blocked and under-split ones in README). Neither text claims the list is complete, and the new warning is documented in the verify sections, so there is no contradiction.
- README.md line 225 says the message starts with `node "<id>": vacuous verify - check 1 ...`, while the real first clause can carry another number (coll-mixed starts with `check 2`). The trailing `...` marks it as an illustration of the shape, and the prefix `node "<id>": vacuous verify - check ` is exact, so it is not counted as a contradiction.
- `test ! -e x` is flagged because `!` is not a dash argument. That follows the literal V3 wording and is not documented as an exception.
- The V2 text "항상 통과" and the message `which always passes` also cover `exit 1`, which fails when run. That follows the plan table (every `exit` check is vacuous), and the docs say the same.
- The plan's acceptance line "compare the eval warnings column with the baseline" is deferred to the eval re-run after Phase 2 according to flows/improvement/p1-vacuous-verify.yaml; it is not an item of this node.
- After all commands, `git status --short` shows only the audited changes plus this notes file; `.claude/dag/` was not touched.

## Verdict

Item 1 holds: 312 pass, 0 fail; validate exits 0.
Item 2 holds: every required probe produced its expected result, the two repo definitions and the other four flow files print OK, and every FAIL is a warning line.
Item 3 holds: 7 test blocks with a positive and a negative test per rule; policy.test.ts has no `vacuous`; all five pre-existing warnings are still produced.
Item 4 holds: both documents state warning-only behaviour, one warning per node with check numbers, the exact V1-V3 lists as coded, what to write instead and the `sh -c` limit, with no statement that contradicts the code; README.md keeps 18 headings and planning.md 8.
No mismatch between the plan table, the code, the tests and the docs was found.

P1 audit: PASS
