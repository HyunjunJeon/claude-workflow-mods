# Eval baseline for the surface judgment (track A)
Date: 2026-10-20
Plugin HEAD: ec65b71 plus the uncommitted eval/surface.ts, eval/surface-cases.ts and eval/surface-run.ts
Change under test: none in hooks/; this is the first measurement of the chat/board surface question that
`modeRequest(..., askSurface=true)` adds to the mode call (SURFACE_CONFIDENCE = 0.8, copied from MODE_CONFIDENCE with no data).
Runner: `bun eval/surface-run.ts --backend http` (40 cases, --repeat 3, drift check on, --concurrency 4), 240 calls
Result: eval/results/surface-20261020121247.md and .json

## Headline
- Outcomes: 120/120 answered; latency p50 177 ms, p95 221 ms; 0 samples over JEV_TIMEOUT_MS (5000) or MODE_BUDGET_MS (8000).
- At the shipped bar 0.8 over 108 scored samples (36 cases x 3; 4 contested cases unscored): TP 36, FP 0, FN 18, TN 54;
  precision 1.00, recall 0.67, accuracy 0.83.
- Precision stays 1.00 at every bar from 0.50 to 0.95, so on this set the bar only trades recall: 0.83 at 0.50, 0.72 at 0.70-0.75, 0.67 at 0.80-0.85, 0.54 at 0.95.
- Mode drift: 0 of 120 samples changed the applied mode when the surface question was added.
- Agreement: 38/40 cases gave the same raw surface choice in all three repeats (split: en-reply-pick-compare, en-contested-why-written, both near 0.5/0.5).

## The HTTP confidence is a margin, not a probability
In every one of the 120 HTTP answers, for both questions, `confidence` equals the top probability minus the second
(e.g. probabilities chat 0.48 / board 0.52 come back as `choice: board, confidence: 0.04`). The model fallback's prompt
(MODEL_SYSTEM in hooks/engine/jev.ts) instead asks for "your probability that choice is correct". So the same 0.8 bar means
p(board) >= 0.9 on the HTTP backend and p(board) >= 0.8 on the model backend, and the calibration table's buckets are margin
buckets for this run. The same holds for MODE_CONFIDENCE and every other Jev bar; this baseline does not measure the model backend.

## Where the board is missed (FN at 0.8)
| group | board at 0.8 | cases and raw answers |
| --- | --- | --- |
| structure | 15/15 | all board at 0.94-0.98 |
| comparison | 12/12 | all board at 0.96-0.98 |
| change-summary | 6/9 | en-change-summary-last-commit board at 0.76-0.78, just under the bar |
| research | 3/9 | en-research-sync-calls board at 0.50-0.54; ko-research-prompt-language board at 0.60-0.68; en-research-baselines board at 0.94 |
| reply | 0/18 (3 cases expect board) | en-reply-pick-explain chat 0.38-0.54; ko-reply-approve-explain board 0.06-0.22; en-reply-pick-compare chat 0.16 / board 0.02 |

- Short replies that select an explanation never reach the board: the request text ("1", "네 그렇게 해줘") carries the weight
  and state.previousReply does not move the surface the way it moves the mode. The three chat-expected replies are all chat.
- Research requests split by wording; the board lean is right but the margin is low.
- No chat-expected case was applied as board. en-short-explain-lens (labelled chat) leans board at 0.04-0.10 and
  ko-short-explain-node-status is chat at only 0.56-0.62; both stay chat because of the bar.

## Contested cases (unscored)
- ko-contested-design-opinion: board 0.62-0.66 (chat at 0.8, board at 0.6).
- ko-contested-read-diff: chat 0.90-0.92.
- en-contested-why-written, en-contested-explain-module: about 0.5/0.5, no lean.

## Mode accuracy
54/63 samples with an expected mode were correct. All 9 misses are the three research cases labelled dag (0/9):
en-research-baselines dag at 0.42-0.52, en-research-sync-calls dag at 0.18-0.28, ko-research-prompt-language direct at 0.14-0.30.
Every direct-labelled sample was direct.

## Reading
- Lowering SURFACE_CONFIDENCE to 0.5-0.6 would gain 6-9 board samples (change-summary and research) with no false board on
  this set. The set holds 12 chat cases near the boundary at most, so a lower bar needs a few more borderline chat cases before it ships.
- The reply weakness is a criteria problem, not a bar problem. The surface instructions only say "Read state.recent and
  state.previousReply as for the mode question"; spelling the rule out, as the mode instructions do (a short reply is judged
  by the option it selects there, not by its own length), is the change to measure next.
- Decide whether Jev bars are meant as margins or probabilities before comparing backends; a model-backend run is the next measurement.
