# Eval rerun of the code scenarios on git fixtures
Date: 2026-10-10
Plugin HEAD: 1cdaa65 plus this run's uncommitted eval/run.ts and README.md change
Runner: bun eval/run.ts --only parallel-files,pipeline-stats,diamond-app --concurrency 3 --timeout-min 15 --keep, model sonnet
Fixtures: git repositories with one initial commit
Results JSON: eval/results/20261010120527.json

Distinct shapes: 2 (fan-out/fan-in, diamond). Distinct producer shapes: 3 (parallel, chain, diamond). Scenarios matching their expected shape: 3/3.

Verification: 17/17 nodes verified, 0 failed, 0 missing; automatic retries: 0; start/amend refusals: 0 verification_required, 0 invalid_verification.

| scenario | expected | runs | shape | nodes | depth | layer widths | fan-in nodes | verify node | warnings | categories | status | outcome check | skill before start | refusals (planning/tools) | AskUserQuestion calls | verify refusals (required/invalid) | verified/total nodes | auto retries | unfinished nodes | time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| parallel-files | parallel | 1 | fan-out/fan-in (producers: parallel) | 5 | 2 | 3-2 | 2 | true | 0 | quickx2 writingx1 unspecified-lowx2 | completed | PASS | true | 0/0 | 0 | 0/0 | 5/5 | 0 | - | 394s |
| pipeline-stats | chain | 1 | diamond (producers: chain) | 5 | 4 | 1-1-1-2 | 2 | true | 0 | quickx3 unspecified-lowx2 | completed | PASS | true | 0/1 | 0 | 0/0 | 5/5 | 0 | - | 293s |
| diamond-app | diamond | 1 | diamond (producers: diamond) | 7 | 5 | 1-2-1-1-2 | 4 | true | 0 | quickx5 unspecified-lowx2 | completed | PASS | true | 0/1 | 0 | 0/0 | 7/7 | 0 | - | 395s |

## Compared with stages-baseline

The earlier rows in eval/baselines/stages-baseline.md came from non-git fixtures under --timeout-min 9 in four shards, while these came from git fixtures under --timeout-min 15 with the three sessions at once, so time differences are not like for like.

| scenario | before status | now status | before outcome | now outcome | before shape | now shape | before nodes | now nodes | before time | now time | review pair before | review pair now |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| parallel-files | completed (timedOut false) | completed (timedOut false) | PASS | PASS | fan-out/fan-in (producers: parallel) | fan-out/fan-in (producers: parallel) | 4 | 5 | 238s | 394s | absent | review-spec completed, review-standards completed |
| pipeline-stats | completed (timedOut false) | completed (timedOut false) | PASS | PASS | chain (producers: chain) | diamond (producers: chain) | 4 | 5 | 273s | 293s | absent | review-spec completed, review-standards completed |
| diamond-app | completed (timedOut false) | completed (timedOut false) | PASS | PASS | diamond (producers: diamond) | diamond (producers: diamond) | 6 | 7 | 331s | 395s | absent | review-spec completed, review-standards completed |

Node changes: in all three scenarios the earlier run closed on one verification node (verify-files, verify-pipeline, verify-app) and had no review-spec, review-standards or commit node. This run has none of those and closes on the review-spec and review-standards pair, so each gains one node (parallel-files 4 to 5, pipeline-stats 4 to 5, diamond-app 6 to 7). Two producer node ids differ from the earlier run: report-draft is now report (pipeline-stats) and asserts is now test_app (diamond-app). pipeline-stats moves from chain to diamond because its last layer now holds the two reviewers (layer widths 1-1-1-2); the producers are still a chain in both runs, and the runner counts the scenario as matching its expected shape when either the shape or the producer shape equals it. The verify node column stays true in the table because the function isVerificationNode used by the runner (eval/shape.ts, hooks/engine/lint.ts) matches the word review in the ids review-spec and review-standards; the producer shape leaves out those two because nothing depends on them.

## Stage use

- **parallel-files** (run dag_mv2cm4lk_omspbh, expected parallel):
  - definition.review is set: request `Add three project files: an MIT LICENSE for "Example Org" (2026), an .editorconfig that sets 2-space indentation for all` (first 120 of 199 characters), notes /tmp/dag-review/add-project-files-1-c2a822, category unspecified-low, no rules.
  - definition.commit is not set.
  - review-spec: completed (attempt 1, verification passed, error none); last line of /tmp/dag-review/add-project-files-1-c2a822/review-spec-notes.md: `Spec verdict: PASS`. review-standards: completed (attempt 1, verification passed, error none); last line of /tmp/dag-review/add-project-files-1-c2a822/review-standards-notes.md: `Standards verdict: PASS`.
  - commit node: none in the run (no commit node in the definition).
  - git log of the fixture: `fce8b6f fixture`; the working tree still holds the untracked .editorconfig, CONTRIBUTING.md, LICENSE.
  - unrequested commit: no; the scenario prompt does not ask for a commit and the log holds only the initial fixture commit (the reflog holds only `commit (initial): fixture`).
  - checks of the user nodes (license, editorconfig, contributing): 6 file checks and 0 command checks; file text fields used: contains, matches, equals (not used: absent, lastLine); command expect keys used: none (no command checks).
- **pipeline-stats** (run dag_mv2cml8b_toedmq, expected chain):
  - definition.review is set: request `Create gen.py that writes data.csv with columns n and square for n = 1..20 and run it. Then create stats.py that reads d` (first 120 of 276 characters), notes /tmp/dag-review/pipeline-stats-1-e8c843, category unspecified-low, no rules.
  - definition.commit is not set.
  - review-spec: completed (attempt 1, verification passed, error none); last line of /tmp/dag-review/pipeline-stats-1-e8c843/review-spec-notes.md: `Spec verdict: PASS`. review-standards: completed (attempt 1, verification passed, error none); last line of /tmp/dag-review/pipeline-stats-1-e8c843/review-standards-notes.md: `Standards verdict: PASS`.
  - commit node: none in the run (no commit node in the definition).
  - git log of the fixture: `d2d7fb7 fixture`; the working tree still holds the untracked data.csv, gen.py, report.md, stats.json, stats.py.
  - unrequested commit: no; the scenario prompt does not ask for a commit and the log holds only the initial fixture commit (the reflog holds only `commit (initial): fixture`).
  - checks of the user nodes (gen, stats, report): 9 file checks and 2 command checks; file text fields used: contains, lastLine (not used: absent, matches, equals); command expect keys used: none.
- **diamond-app** (run dag_mv2coklf_w1frw6, expected diamond):
  - definition.review is set: request `Build a tiny Python app: settings.py exposing SETTINGS = {"greeting": "hi", "repeat": 2}; greeter.py with greet(name) re` (first 120 of 418 characters), notes /tmp/dag-review/diamond-app-1-a15280, category unspecified-low, no rules.
  - definition.commit is not set.
  - review-spec: completed (attempt 1, verification passed, error none); last line of /tmp/dag-review/diamond-app-1-a15280/review-spec-notes.md: `Spec verdict: PASS`. review-standards: completed (attempt 1, verification passed, error none); last line of /tmp/dag-review/diamond-app-1-a15280/review-standards-notes.md: `Standards verdict: PASS`.
  - commit node: none in the run (no commit node in the definition).
  - git log of the fixture: `d2d7fb7 fixture`; the working tree still holds the untracked greeter.py, main.py, repeater.py, settings.py, test_app.py.
  - unrequested commit: no; the scenario prompt does not ask for a commit and the log holds only the initial fixture commit (the reflog holds only `commit (initial): fixture`).
  - checks of the user nodes (settings, greeter, repeater, main, test_app): 10 file checks and 8 command checks; file text fields used: contains, absent (not used: matches, lastLine, equals); command expect keys used: stdout.

### Findings

- Review stage declared: 3 of 3 planners (parallel-files, pipeline-stats, diamond-app) set definition.review, each with category unspecified-low and a notes folder under /tmp/dag-review/. In eval/baselines/stages-baseline.md the same three scenarios, and all 8 scenarios of that run, had no definition.review and no review node. Each scenario ran once, and the fixtures (non-git before, git now), the concurrency (1 before, 3 now) and the time limit (9 before, 15 minutes now) all differ, so this shows that the stage was declared on git fixtures, not why.
- Commit stage declared: 0 of 3. No planner set definition.commit and no commit node ran, which is the expected result because no scenario prompt asks for a commit. Each closing text says nothing was committed.
- Review or commit nodes that failed: none. All six review nodes (review-spec and review-standards in each scenario) finished completed on attempt 1 with verification passed, error none and no recovery, and each notes file ends with its PASS verdict line. There was no commit node, so there is no commit error to quote.
- Commits the scenario did not ask for: none. Each fixture log holds only the `fixture` commit and the reflog only its creation; the files the nodes wrote are untracked.
- pipeline-stats: report.md did not exist when the reviewers ran. Its goal text says the table is drafted by node report into /tmp/dag-pipeline-stats-1/table-draft-notes.md and that the main session copies it to report.md after the run settles, so the review-spec notes judge that draft file in place of report.md and do not raise its absence. The request quoted in definition.review still says "Finally write report.md".
- parallel-files: the user node contributing finished on attempt 3. Its first verification failed on a planner-written check, file matches `\A# Contributing$` (JavaScript regular expressions have no `\A`), the file itself was correct, and the planner amended the check. This is not a review or commit node and is unrelated to the stages.

## Sources

- Results JSON: eval/results/20261010120527.json
- Results MD: eval/results/20261010120527.md
- Fixtures folder (kept with --keep): /tmp/dag-shapes/20261010120527, with parallel-files, pipeline-stats, diamond-app below it
- parallel-files: dag_mv2cm4lk_omspbh, run file /tmp/dag-shapes/20261010120527/parallel-files/.claude/dag/runs/dag_mv2cm4lk_omspbh.json
- pipeline-stats: dag_mv2cml8b_toedmq, run file /tmp/dag-shapes/20261010120527/pipeline-stats/.claude/dag/runs/dag_mv2cml8b_toedmq.json
- diamond-app: dag_mv2coklf_w1frw6, run file /tmp/dag-shapes/20261010120527/diamond-app/.claude/dag/runs/dag_mv2coklf_w1frw6.json
