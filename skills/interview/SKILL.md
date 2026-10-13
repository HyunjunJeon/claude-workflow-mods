---
name: interview
description: User-invoked only; aligns on a vague request through rounds of numbered questions with recommended answers before a DAG is planned, and ends with a confirmed goal and acceptance criteria.
disable-model-invocation: true
argument-hint: "[topic or request]"
---

# interview

The user starts this skill with `/dag-workflow:interview [topic]`.
Never invoke it on your own.
It runs in the main conversation before any DAG is planned.

Under strict enforcement the main conversation may use these tools:

- `AskUserQuestion`, Read and LSP.
- Read-only Bash: `ls`, `cat`, `rg`, `find` without `-exec` or `-delete`, and `git status|log|diff|show`.
- The `mcp__dag-workflow__dag` tool.
- The `mcp__dag-workflow__board` tool, to draw the interview on the board.

It may never use Agent, Write, Edit or mutating Bash.
Ask through `AskUserQuestion`, find facts by reading, and write no file.

If the request is already clear, say so in one sentence.
Then go straight to the `dag-workflow:planning` skill.
In a non-interactive session this skill does not apply.

## Design-tree rounds

Map the request as a design tree: every decision branches into the decisions that hang off it.
The frontier is every decision whose prerequisites are already settled.
These are the questions you can ask now without guessing answers you have not heard.
Ask the whole frontier in one round.

For each question:

- Number it Q1, Q2 and so on, and give it a short title.
- Write a body that states the decision and its options.
- State your recommended answer.
- Word it so that a plain "yes" accepts the recommendation.

In `AskUserQuestion`, put the recommended option first and mark it "(Recommended)".
One call takes at most 4 questions.
If the frontier is larger, ask the 4 questions with the most downstream branches first.
Continue with the rest in the next call.

Each round of answers reshapes the tree.
Recompute the frontier before the next round.
A question whose answer depends on another open question belongs to a later round.

## Ambiguity tracks

Keep four tracks visible: scope, constraints, deliverables and verification.
The ledger of these tracks lives on the board, as described in "The board", and is updated at the start of every round.

Do not let the interview collapse onto one track.
When the last two rounds touched a single track, take the next questions from the least-covered track.

Print this ledger in chat at the start of every round only when the board cannot be used:

| Track | Settled | Still open |
| --- | --- | --- |
| Scope | | |
| Constraints | | |
| Deliverables | | |
| Verification | | |

## The board

The board shows the ledger and the design tree in the /dag pane, so chat carries only the questions.
Before the first round:

1. If `mcp__dag-workflow__board` is deferred, load it with ToolSearch `select:mcp__dag-workflow__board`.
2. `create` a board titled `Interview: <topic>`, in the user's language and at most 80 characters.
3. In ONE `edit`, `insert` a `table` titled `Ambiguity tracks`, then a `flow` titled `Design tree`.
4. Call `open` once.

The table has the columns Track, Settled and Still open, and the four rows Scope, Constraints, Deliverables and Verification.
The flow has one node per decision, with a short id such as `d1`:

- `label`: the decision in a few words.
- `note`: `settled: <answer>`, `frontier` or `later`.
- `kind`: `terminal` once settled, `decision` otherwise.
- One edge from each decision to each decision that hangs off it.

At the start of every later round, ONE `edit` `replace`s the table and the tree by their ids with the current state.
In chat, never print the ledger table.
Say in one line which blocks changed and what moved, for example `Board b1, b2 updated: Scope settled, Verification has 2 open items`.

Keep within the limits: table cells and flow notes at most 80 characters, flow labels at most 40, at most 24 nodes.
Shorten labels and cells, and put longer wording in a `section`.
When the tree would pass 24 nodes, fold settled leaves into their parent's note.

The user may point at a block by its id (`b2`) or by a tree node's label.
Treat that as a free-text answer and clarify it with Refine.

Fallback: if the tool is unavailable, an edit is refused twice, or `open` replies `shown: false`, print the ledger in chat at the start of every round as before.
In that case do not use the board for the rest of the interview.

## Facts and decisions

Finding facts is your job, never the user's.
Use Read, LSP and read-only Bash such as `rg`, `ls` and `git log`.
"The project uses X" is a fact.
"The new feature should use X" is a decision.

When a fact is too big to read yourself, run a one-node read-only DAG.
Examples are a survey of many files or a long history.

1. Load `dag-workflow:planning` first. `start` is refused until you do.
2. Start one node that only reads and reports its findings in `## Output`.
3. Let that node write nothing but one notes file, such as `notes/<topic>-facts.md`.
4. Give the node a `verify` check that the file contains "## Facts".

Do not block on the run and do not poll.
Ask the rest of the frontier now, because only the questions downstream of that fact wait.
The run-settled message delivers the output.

Decisions go to the user.
They cover goals, scope, priorities, trade-offs, acceptance criteria and the desired behaviour of new work.
If a question mixes a fact with a judgment, ask the user the whole question and show the fact.
If your last 3 answers in a row came from reading rather than from the user, send the next question to the user.
When in doubt, ask.

## Refine

Keep the user's words and your reading apart.
When a free-text answer carries scope, a constraint or a decision, restate it in this form:

- `Decision (user-stated): ...`
- `Constraints (user-stated): ...`
- `My reading: ...` for anything you inferred.

Then confirm with one `AskUserQuestion`.
Offer "Correct as written", "Fix my reading", "Add a constraint" and "Let me restate it".
Treat the answer as settled only after that confirmation.
A plain option pick or a bare yes or no needs no Refine.
Never label your own inference as user-stated.

## Restate gate

The interview ends when the frontier is empty and nothing is silently assumed.
Then restate two things:

1. The goal as ONE sentence, so that a stranger reading only that line would turn it into the same outcome.
2. A numbered list of observable acceptance criteria.

On the board, put both in a `section` titled `Goal and acceptance criteria`: the goal sentence, then the numbered criteria.
In ONE `edit`, `insert` it and `replace` the table and the tree with the final state.
Then `get` the board and check that it matches the conversation.
The board stays in the session, so the approval block of the run can point the user to it.
When the board is not in use, restate both in chat instead.

Ask for confirmation with `AskUserQuestion`, and quote the goal sentence in the question.
Offer "Yes, plan it", "Adjust wording" and "Missing scope".
Send any correction through Refine again.
Before asking again, `replace` the section by its id so the board shows the corrected text.

Only after "Yes", load `dag-workflow:planning` and hand off:

- The goal sentence becomes `definition.goal`.
- Every acceptance criterion becomes a `verify` candidate: a file check with `contains`, or a command that can fail.
- User-stated constraints go into the node SCOPE lines.

Never call `start` for the planned work before the user confirms.
The read-only facts run is the only earlier `start`.