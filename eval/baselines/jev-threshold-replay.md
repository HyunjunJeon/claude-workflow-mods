# Jev threshold replay (P15a)

Measured 2026-10-28 from the Jev decision logs (`.claude/dag/decisions/*.json`) of three projects:
- `/Users/jhj/Desktop/personal/claude-workflow-mods`: routing 104, recovery 6
- `/Users/jhj/Desktop/personal/zoetrope`: routing 36, recovery 0
- `/Users/jhj/Desktop/personal/ResearchStudio`: routing 5, recovery 1

Every record was answered by the HTTP backend at bar 0.9 (`threshold` field). Records without a confidence: 0.
Recorded as applied at 0.9: routing 37, recovery 3; the replay at 0.9 must give the same numbers.

Method: a decision applies at bar t when its `confidence` is at least t (`hooks/register.ts` compares `choice.confidence < threshold`).
Jev's choice is `selected` for an applied record; a low-confidence record does not store the choice, so the replay takes the
option with the highest probability. Among applied records with probabilities, 0 have a top probability that differs from `selected`.
`confidence` is the reply field Jev gives separately from the probabilities, and it can be lower than the top probability
(for example confidence 0.5 with implementation at 0.6).

## Routing

Proposed category: what the definition gave. A change: the applied choice differs from the proposed category.
No outcome tells whether a routing choice was right, so this table counts only what would change.

| bar | decisions | applied | of which change the category | changes (proposed -> Jev) |
| --- | --- | --- | --- | --- |
| 0.6 | 145 | 79 | 10 | standard->hard x4, trivial->standard x3, standard->debugging x1, unspecified-low->unspecified-high x1, quick->visual-engineering x1 |
| 0.7 | 145 | 61 | 5 | standard->hard x3, standard->debugging x1, unspecified-low->unspecified-high x1 |
| 0.8 | 145 | 52 | 2 | standard->hard x1, unspecified-low->unspecified-high x1 |
| 0.9 | 145 | 37 | 1 | standard->hard x1 |

Per project at each bar (applied / decisions):

| project | 0.6 | 0.7 | 0.8 | 0.9 |
| --- | --- | --- | --- | --- |
| claude-workflow-mods | 60/104 | 45/104 | 36/104 | 23/104 |
| zoetrope | 15/36 | 13/36 | 13/36 | 12/36 |
| ResearchStudio | 4/5 | 3/5 | 3/5 | 2/5 |

Routing confidence distribution: <0.6 66, 0.6-0.7 18, 0.7-0.8 9, 0.8-0.9 15, >=0.9 37.

## Recovery

A recovery decision retries the failed node automatically only when it applies and the choice is transient or implementation
(`hooks/engine/recovery.ts`). The outcome column approximates whether the choice was right: the verification status of the
node's next attempt after the decision. That attempt may have been a manual retry or amend with a changed prompt, so it does
not prove an automatic retry would have succeeded.

| run / node | confidence | Jev choice (top probability) | recorded outcome | next attempt |
| --- | --- | --- | --- | --- |
| dag_mvc92ge4_llzzx1 / verify-sync | 0.46 | implementation (0.57) | low-confidence | no verification record after it |
| dag_mvf9cutv_cyx2jf / fix-main-turn | 1 | implementation (1) | applied | attempt 2: passed |
| dag_mvfxa06v_a3uv28 / request-lint | 0.94 | implementation (0.95) | applied | failed (another recovery decision followed) |
| dag_mvfxa06v_a3uv28 / request-lint | 0.41 | implementation (0.53) | low-confidence | attempt 3: passed |
| dag_mvfxa06v_a3uv28 / request-lint | 0.76 | implementation (0.81) | low-confidence | attempt 5: passed |
| dag_mvfyr8a7_mk3w4j / ab-prep | 0.97 | implementation (0.98) | applied | attempt 2: passed |
| dag_mvrskjyp_hfwvsq / flows-annotate | 0.5 | implementation (0.6) | low-confidence | attempt 2: passed |

| bar | decisions | would retry automatically | of which the next attempt passed |
| --- | --- | --- | --- |
| 0.6 | 7 | 4 | 3 |
| 0.7 | 7 | 4 | 3 |
| 0.8 | 7 | 3 | 2 |
| 0.9 | 7 | 3 | 2 |

## Cross-check

A second count, written separately in Bun over the same logs, gave the same numbers: routing 145 decisions, applied
79/61/52/37 at 0.6/0.7/0.8/0.9 with 10/5/2/1 category changes; recovery 7 decisions with a confidence at or above the bar
4/4/3/3. At 0.9 the replay equals the recorded applied counts (routing 37, recovery 3).

## Limits

- Recovery has 7 decisions from 5 nodes in 2 projects; three of them are one node (request-lint). No bar can be chosen from
  recovery data on its own merits; read the table as what each bar would have done on these cases.
- All 7 recovery choices were implementation, so every recovery retry in this data would have used Opus.
- flows-annotate (0.5) passed on attempt 2 only after the user chose how to fix the lint rule and an amend added a node:
  the failure needed a decision, so implementation was not the right call there even though the next attempt passed.
- Routing has no correctness signal. The changes at lower bars are mostly upgrades (standard->hard, trivial->standard),
  which cost more per node; the table does not show whether they helped.
- Decision logs keep the last 200 records per session, and pruned runs leave decisions without run files; the recovery rows
  all still have their run files.
