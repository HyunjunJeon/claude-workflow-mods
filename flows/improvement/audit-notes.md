# Flows audit notes

Audit of the four phase definitions under `flows/improvement/` against `docs/improvement-plan.md` and `skills/dag-planning/references/planning.md`.
Run `dag_muz4fqxy_4rj8gi`, node `audit`, date 2026-10-08. Read-only: no definition file was edited. The helper scripts used for the mechanical checks ran from the session scratchpad, outside the project.

## Checker output (check 1, verbatim)

Command: `bun eval/check-definition.ts flows/improvement/p0-eval-baseline.yaml flows/improvement/p1-vacuous-verify.yaml flows/improvement/p2-planning-doctrine.yaml flows/improvement/p3-alignment.yaml` (exit 0)

```
OK flows/improvement/p0-eval-baseline.yaml (7 nodes)
OK flows/improvement/p1-vacuous-verify.yaml (5 nodes)
OK flows/improvement/p2-planning-doctrine.yaml (12 nodes)
OK flows/improvement/p3-alignment.yaml (9 nodes)
```

## Standards applied (decided once, used for every file)

- A plan item with no node is acceptable only when it cannot be done inside the run (reload forbidden by D1, user action, manual tmux step, a separate usage-spending eval run) and the plan or the file documents that. Otherwise it is a failure.
- A node the plan does not name is acceptable only when it serves a named deliverable or a named acceptance criterion (audit, progress row, forced test-fixture repair, documentation of a named deliverable) and the file header or the node prompt discloses it. Otherwise it is a failure.
- A verify check "can fail" when it is a file check with nonempty `contains` that is absent from the tree today (or an invariant guard that can break), or a command whose program is a real checker that exits nonzero on a wrong deliverable.

## flows/improvement/p0-eval-baseline.yaml (7 nodes)

1. `bun eval/check-definition.ts`: PASS. Prints `OK ... (7 nodes)`.
2. Plan coverage: PASS.
   - Plan P0 step 2 ("`bun eval/run.ts --concurrency 4`로 8개 시나리오 전체 ... 요약을 아래 진행 기록에 옮긴다") maps to `shard-1`..`shard-4` (two scenarios each, all 8 ids of `eval/scenarios.ts`: single-edit, parallel-files, map-reduce-docs, pipeline-stats, diamond-app, debug-fix, wide-harvest, research-write), `baseline-combine` and `progress-log`.
   - Steps 1, 3 and 4 are user actions, declared nodeless in the file header (line 2-3: "The other Phase 0 steps (commit, decisions D1-D5, access to the shared document) are user actions and have no nodes here.") and in the plan (`## 실행 정의`: "P0의 커밋, 결정(D1–D5), 공유 문서 접근은 사용자가 직접 하는 일이라 노드가 없다.").
   - Beyond the plan, both disclosed in the header (line 14-19): the four shards with `--concurrency 1 --timeout-min 4` instead of one `--concurrency 4` run (still 4 sessions at a time, forced by the 600000 ms Bash cap), and the extra nodes `baseline-combine` and `baseline-audit` (the independent audit the workflow goal requires). A tracked `eval/baselines/` folder is added because the plan notes `eval/results/` is gitignored. See Notes 3.
3. Disjoint writes: PASS. The only concurrent nodes are the four shards: `eval/baselines/p0-shard-1.md` .. `p0-shard-4.md`. `baseline-combine`, `baseline-audit` and `progress-log` are a chain. The runner's own output (`eval/results/<stamp>.*`, `/tmp/dag-shapes/<stamp>`) is not a declared write and is kept distinct by the seconds windows (line 73: `s>=15*k+3&&s<=15*k+9`, windows 3-9, 18-24, 33-39, 48-54).
4. Every verify can fail: PASS. Shards: 3 file checks with `contains` plus a `bun -e` script that compares each row with the Results JSON. `baseline-combine`: 3 file checks plus a `bun -e` recomputation. `baseline-audit`: 5 file checks (for example line 336 `contains: "Cells compared: 160/160"`). `progress-log`: 3 file checks (`| P0 | 완료 | 20`, `eval/baselines/p0-baseline.md`, `run dag_`). No file check lacks `contains`; none is satisfied by the tree today (no `eval/baselines/` yet). No command program is true, :, echo, printf, exit, yes, sleep, test, [, ls, stat or cat. Verified against `eval/run.ts` `markdown()`: row prefix `| ${r.id} | ${r.expect} |`, shape cell `${run.shape} (producers: ${run.producerShape})`, row end `| ${r.seconds}s |`, summary formats, 20 header columns (so 8 x 20 = 160), 14-digit stamp (`toISOString` minus `-:T`, first 14 chars). `bun -e <script> 1 a b` gives `process.argv.slice(1)` = `["1","a","b"]`, which the scripts rely on.
5. Prompt contract: PASS. All 7 prompts carry `TASK:`, `DELIVERABLE:`, `SCOPE:`, `VERIFY:` and `STOP WHEN`. All 7 carry the prohibition, for example (shard-1, line 70): "NEVER commit, push, install anything or reload plugins, and never edit anything under .claude/." Prompts refer only to repository files, the plugin header line `(run dag_..., attempt N)` and the pasted upstream outputs.
6. Shared facts: PASS. Key `improve-p0-eval-baseline-1` (line 22). Last node `progress-log` (line 359), "Update ONLY the P0 row", row `| P0 | 대기 | | |`.
7. Plan section: PASS. Row matches: `flows/improvement/p0-eval-baseline.yaml`, `improve-p0-eval-baseline-1`, 7 nodes, `/dag run flows/improvement/p0-eval-baseline.yaml`.

## flows/improvement/p1-vacuous-verify.yaml (5 nodes)

1. `bun eval/check-definition.ts`: PASS. Prints `OK ... (5 nodes)`.
2. Plan coverage: PASS.
   - V1, V2, V3 with the exact program and flag sets, one warning per node, English message, warnings only, shell wrappers out of scope: `lint-rules` (line 52-58: "Out of scope and NOT to be built: looking inside shell wrappers such as sh -c ... Decision D2 of the plan: warnings only.").
   - `hooks/engine/lint.ts` and the positive and negative test per rule: `lint-rules`. README verification section: `readme-doc`. `planning.md` verification paragraph: `planning-doc`. Existing tests, `tsc`, `validate`: `lint-rules` VERIFY (line 66-70) and `final-audit` (`claude plugin test .`, `claude plugin validate .`).
   - Beyond the plan, disclosed in the `lint-rules` prompt (3), and forced by the criterion "기존 테스트 전부 통과": fixture-only edits in `tests/policy.test.ts` and `tests/runtime.test.ts`. The new tests go to the new `tests/lint.test.ts`, where the plan says `tests/policy.test.ts` (Notes 2).
   - Plan acceptance "eval 결과의 warnings 열을 기준선과 비교" has no node of its own. The plan schedules the only eval re-run after P2 ("P2 ─▶ eval 재실행") and the P2 criterion lists "경고 수", so the comparison happens in that separate re-run (`## 실행 정의`: "P2 뒤의 eval 재실행은 `p0-eval-baseline.yaml`을 새 key로 다시 쓴다."). Treated as a documented deferral. See Notes 1.
3. Disjoint writes: PASS. Concurrent pair `readme-doc` (`README.md`) and `planning-doc` (`skills/dag-planning/references/planning.md`). `lint-rules` runs first, `final-audit` and `progress-log` after.
4. Every verify can fail: PASS. `lint-rules`: 2 file checks with `contains: vacuous verify`, a `bun -e` probe, `claude plugin test .`, `bun eval/check-definition.ts ...`. I ran the probe against the unmodified repo: it printed `{"bad":[],"good":[]}` and exited 1, so it fails before the work and can pass only with the rule. `readme-doc` and `planning-doc`: 4 file checks each (`vacuous verify`, `touch`/`printf`, `sleep`, `sh -c`), none present in those files today. `final-audit`: file `P1 audit: PASS` plus `claude plugin test .` and `claude plugin validate .`. `progress-log`: file `| P1 | 완료 | 20`. The file itself satisfies V1-V3.
5. Prompt contract: PASS. All 5 prompts carry the five markers and the prohibition, for example (line 63): "NEVER commit, push, install or reload plugins (no git commit, no git push, no claude plugin install, no /reload-plugins)." Prompts depend on the plugin pasting upstream Outputs, which `dependsOn` guarantees. The statement "A prototype showed that the new rules turn exactly these 7 existing tests red" names the 7 tests; I confirmed they exist (`tests/policy.test.ts` lines 136, 170, 177, 187, 199 and `tests/runtime.test.ts` lines 554, 567; `VERIFY` constant on line 6 of `tests/runtime.test.ts` is `['test', '-d', '/work']`).
6. Shared facts: PASS. Key `improve-p1-vacuous-verify-1` (line 12). `tests/lint.test.ts` is created by `lint-rules` (line 21, "a NEW file") and the prompt says "a later phase appends more lint tests to this file". Last node `progress-log`, "Update ONLY the P1 row".
7. Plan section: PASS. Row matches: path, `improve-p1-vacuous-verify-1`, 5 nodes, run command.

## flows/improvement/p2-planning-doctrine.yaml (12 nodes)

1. `bun eval/check-definition.ts`: PASS. Prints `OK ... (12 nodes)`.
2. Plan coverage: PASS.
   - 2a two-axis review: `draft-2a` -> `synthesize-planning`; the `review-spec` and `review-standards` nodes that apply it to this run are both end nodes with no aggregator (D5).
   - 2b safe-but-wrong checklist: `draft-2b` (the five plan items verbatim, `partial/supporting-output`). 2c vertical slices and expand/migrate/contract: `draft-2c`. 2d debug chain with D3(a), `[DEBUG-` tag and B2: `draft-2d`. `synthesize-planning` merges 2a-2d into `planning.md` and `SKILL.md`.
   - 2e: `skill-debugging`, `skill-review-standards`, `skill-testing` (D4-b, with the "agree the test seams with the user" step removed from the tdd extract) and `third-party-notices` (MIT notices).
   - Plan acceptance `validate`: `review-standards` verify runs `claude plugin validate .`. Plan 2e's "먼저 노드 1개짜리 실행으로 load_skills 해석 확인" and the eval re-run are not nodes; both are disclosed in the header (line 18-20: "Not part of this run: confirming that load_skills: [...] resolves inside a node ... needs /reload-plugins first (never while a run is active, decision D1)"; line 15-16: "The eval re-run that follows P2 ... reuses flows/improvement/p0-eval-baseline.yaml under a new key; it is not a node of this file.").
   - Phase 3 and Phase 1 material is excluded (synthesize-planning point 5; review-spec "Extras").
3. Disjoint writes: PASS. Wave 1 is 8 concurrent nodes with 8 distinct files (4 `notes/p2-*.md`, 3 `skills/dag-node-*/SKILL.md`, `THIRD_PARTY_NOTICES.md`). `synthesize-planning` (`planning.md`, `SKILL.md`) can overlap the skill and notices writers and shares no path with them. `review-spec` and `review-standards` write `notes/p2-review-spec.md` and `notes/p2-review-standards.md`.
4. Every verify can fail: PASS. Every file check carries `contains`; every command is `bun -e` (banned-phrase scripts), `git diff --check -- skills/dag-planning` or `claude plugin validate .`. The three `contains: "---\nname: dag-node-...\ndescription: "` checks parse to a real newline (I printed the parsed strings: lengths 42, 49, 40, `includes('\n')` true) and match the frontmatter shape of `skills/dag-planning/SKILL.md` (`name` first, `description` second). The one file check that is true today, `progress-log` `contains: "| P3 | 대기 | | |"`, is a deliberate guard that fails if P3 ran first (Notes 6).
5. Prompt contract: PASS. All 12 prompts carry the five markers. All carry the prohibition, for example (line 83): "NEVER run git commit or git push, never run an install command (npm, bun add, pip, brew), never reload plugins (/reload-plugins), and never edit anything under .claude/." The wording names no `claude plugin install`, but "an install command" covers it (Notes 5). `gh api` failures end with `DAG_NODE_STATUS: failed: missing-input: ...` instead of invented text.
6. Shared facts: PASS. Key `improve-p2-planning-doctrine-1` (line 37). Skill names `dag-node-debugging`, `dag-node-review-standards`, `dag-node-testing` are used with identical spelling in every node and verify. Last node `progress-log` (line 541): "Update ONLY the P2 row", leaves the P3 row byte-identical.
7. Plan section: PASS. Row matches: path, `improve-p2-planning-doctrine-1`, 12 nodes, run command.

## flows/improvement/p3-alignment.yaml (9 nodes)

1. `bun eval/check-definition.ts`: PASS. Prints `OK ... (9 nodes)`.
2. Plan coverage: PASS.
   - 3a protocol flag (`protocolFor(level, interactive)`, `policy.ts:276`, `register.ts:1716`, tests): `protocol-flag`. I confirmed the anchors: `hooks/engine/policy.ts:276` `export function protocolFor(level: Enforcement): string`, `hooks/register.ts:1716` `protocolFor(enforcement)`, `let interactive = true` at line 90 and `interactive = e.isInteractive` at line 1544. 3a eval column: `eval-ask-count`.
   - 3b goal lint after Phase 1: `goal-lint` (fails on purpose when `tests/lint.test.ts` is missing). 3c: `skill-interview`. 3d: `skill-pm` (`write-prd`, `## Open items`). 3e: `planning-alignment` (one round, skipped when non-interactive).
   - Acceptance: tests, `tsc`, `validate` in `protocol-flag`, `goal-lint`, `final-audit`. "eval 8개에서 AskUserQuestion 0회" and the tmux check are not nodes; the header says so (line 20-21: "the \"eval 8 scenarios show AskUserQuestion 0\" criterion and the tmux interview check are NOT part of this run") and `final-audit` always writes `Manual tmux interview check: OPEN` and the NOT RUN line.
   - Beyond the plan, disclosed in the header (line 10-16): the `readme` node (documents the six lanes) and the test repairs in `tests/runtime.test.ts` and `tests/shape.test.ts` inside `goal-lint`, forced by the new warning (I confirmed `tests/shape.test.ts:37` `expect(m.warnings).toBe(5)` and the `FAN_IN` / `COMPLIANT` definitions in `tests/runtime.test.ts`). See Notes 8.
3. Disjoint writes: PASS. Wave 1 has five nodes with disjoint files (`policy.ts`/`register.ts`/`tests/policy.test.ts`, `eval/run.ts`, `skills/dag-interview/SKILL.md`, `skills/dag-pm/SKILL.md`, `skills/dag-planning/SKILL.md`). `goal-lint` overlaps `protocol-flag` only on `tests/policy.test.ts`, and `dependsOn: [protocol-flag]` orders them (header line 13). `readme`, `final-audit`, `progress-log` come after.
4. Every verify can fail: PASS. All file checks carry `contains` and none is true in the tree today (I checked `Non-interactive session: do not ask the user`, `protocolFor(enforcement, interactive)`, `askUserQuestions`, `the definition has no goal`, `/dag-workflow:dag-interview`, `비대화형`, `goal 누락`, `non-interactive` in `SKILL.md`). Commands: `claude plugin test .`, `claude plugin validate .`, `bun eval/run.ts --list`, `bun eval/check-definition.ts eval/fixtures/valid-definition.yaml`, `grep -F "| P3 | 완료 | 20" docs/improvement-plan.md`. `eval-ask-count` leans on two file checks, since `--list` only proves the file still loads. Timing against the 30-second command limit: `claude plugin test .` 4.1 s (305 pass, 0 fail), `claude plugin validate .` 0.7 s, `--list` instant.
5. Prompt contract: PASS. All 9 prompts carry the five markers and "Never commit, push, install or reload plugins." (for example line 57).
6. Shared facts: PASS. Key `improve-p3-alignment-1` (line 22). `goal-lint` writes `tests/lint.test.ts` and its prompt says "tests/lint.test.ts, which Phase 1 created". Skill names `dag-interview` and `dag-pm` are consistent (`/dag-workflow:dag-interview`, `/dag-workflow:dag-pm`). Last node `progress-log` (line 317): "Update only the P3 row", "The rows P0, P1 and P2 and everything else in the file stay exactly as they are."
7. Plan section: PASS. Row matches: path, `improve-p3-alignment-1`, 9 nodes, run command.

## Cross-file checks 6 and 7

| File | key (file line) | `## 실행 정의` key | nodes (checker) | plan nodes | last node | row edited |
| --- | --- | --- | --- | --- | --- | --- |
| p0-eval-baseline.yaml | `improve-p0-eval-baseline-1` (22) | same | 7 | 7 | progress-log | P0 |
| p1-vacuous-verify.yaml | `improve-p1-vacuous-verify-1` (12) | same | 5 | 5 | progress-log | P1 |
| p2-planning-doctrine.yaml | `improve-p2-planning-doctrine-1` (37) | same | 12 | 12 | progress-log | P2 |
| p3-alignment.yaml | `improve-p3-alignment-1` (22) | same | 9 | 9 | progress-log | P3 |

- The four paths, keys, node counts and `/dag run <path>` commands in the `## 실행 정의` table (plan lines 130-135) were compared by script with the parsed files: all equal. The section also states "파일은 D2–D5의 추천안을 전제로 쓰였다", which matches the D2, D3(a), D4(b) and D5 comments in the P1 and P2 headers.
- `tests/lint.test.ts`: created in P1 (`lint-rules` writes it, "a NEW file"), extended in P3 (`goal-lint` writes it and fails on purpose when missing). Consistent.
- Skill names: P2 creates `dag-node-debugging`, `dag-node-review-standards`, `dag-node-testing`; P3 creates `dag-interview`, `dag-pm`; no other file uses a different spelling.
- Every file's definition passes the P1 and P3 lints it describes: each has a `goal`, and none uses a vacuous check (no file check without `contains`, no true/:/echo/printf/exit/yes/sleep/test/[/ls/stat/cat program).
- Shared file `docs/improvement-plan.md` is written by the four `progress-log` nodes, each only on its own row. They must run as separate, non-overlapping runs in the order P0, P1, P2 (then the eval re-run), P3.

## Notes (not failures)

1. P1 has no node and no header sentence for the plan acceptance "eval 결과의 warnings 열을 기준선과 비교". It is covered only through the plan-level eval re-run after P2. Suggest one header line in `p1-vacuous-verify.yaml` saying the warnings column is compared in that re-run.
2. P1: the plan names `tests/policy.test.ts` as the home of the lint tests ("`tests/policy.test.ts`(기존 `lintDefinition` 테스트 위치)"); the flow puts the new tests in `tests/lint.test.ts` and `final-audit` requires `rg -n 'vacuous' tests/policy.test.ts` to find nothing. This matches the shared fact for this audit (check 6) and P3 relies on it.
3. P0: one `--concurrency 4` run became four shards of `--concurrency 1 --timeout-min 4`; a scenario slower than 4 minutes is recorded as a timed-out row. The shards also assume nested `claude -p` works inside a node's Bash (not provable from the repository). The `eval/baselines/` files are new tracked files the plan did not ask for.
4. Cross-phase hazard in P0: `baseline-audit` hardcodes the column count (line 336 `contains: "Cells compared: 160/160"`, prompt "each row has 20 cells"). P3's `eval-ask-count` adds a column (21, so 168). The order P0, P1, P2, eval re-run, P3 keeps the first re-run valid; a re-run of `p0-eval-baseline.yaml` after P3 would fail that check until the number is changed.
5. P2 prohibition wording: "never run an install command (npm, bun add, pip, brew)" never says `claude plugin install`. Accepted as covered by "an install command"; the P1 and P3 wording is more explicit.
6. P2 `progress-log` verify `contains: "| P3 | 대기 | | |"` is already true today. It is a guard (fails if P3 ran before P2), not a deliverable check.
7. P2 applies the two-axis review (`review-spec`, `review-standards`) to a run that changes documents and skills, not code, although its own 2a doctrine says documentation runs keep a single verification node. The header (line 34-36) presents it as the standing final-audit exception; both reviews run on `unspecified-low`.
8. P3: the `readme` node documents the deliverables but the plan's P3 section names no README work; the header discloses it as a component (line 10-16).
9. Ordering hazards: P2 must run after P1 (both edit the `planning.md` verification paragraph; P1 `planning-doc` and P2 `synthesize-planning`), P3 after P1 (`tests/lint.test.ts`). The P1 `final-audit` negative probes expect exit 0 for goal-less probe definitions; after P3's goal lint lands they would print the goal warning, so re-running P1 after P3 needs the probes to include a `goal`.
10. Stale wording, harmless: several prompts say the tree "already holds uncommitted edits" in `README.md`, `planning.md` and `lint.ts`; `git status` now shows only `docs/improvement-plan.md`, `eval/check-definition.ts`, `eval/fixtures/` and `flows/` as untracked. The instructions are conditional ("never revert") and stay correct.

Flows audit: PASS
