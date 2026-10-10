---
name: planning
description: Mandatory planning doctrine for dag-workflow. Load it BEFORE the first mcp__dag-workflow__dag start or amend in a session - the plugin refuses that start until this skill is loaded. Covers turning a task into a dependency-ordered DAG of subagent nodes, how results flow along dependsOn, the node prompt contract, the verification wave, and recovering runs.
when_to_use: Any task in a session where dag-workflow enforces DAG orchestration - planning a DAG, writing node prompts, reading a run-settled summary, retrying or amending a run, chaining a follow-up run.
argument-hint: "[task]"
---

# planning

Use `mcp__dag-workflow__dag` to run every task as a DAG of subagent nodes.
The main conversation plans, reads, orchestrates and verifies.
Edit, Write, mutating Bash, Agent and other work tools run inside nodes.
This skill explains how to plan those nodes.
A one-step task uses one node and follows the same rules.

If `mcp__dag-workflow__dag` is unavailable, the mod is off.
`--safe-mode`, `disableAllHooks` and `allowManagedModsOnly` keep skills loaded but remove the tool and hooks.
Tell the user that DAG orchestration is off for this session.
Do the work directly.
Make no claims about runs, nodes, panes or checkpoints.
Do not follow the rest of this skill.

## Planning - MANDATORY first step

Before defining any graph, read `${CLAUDE_SKILL_DIR}/references/planning.md` in full with the Read tool.
A graph defined without that reading is unplanned work.
The reference contains the planning rules omitted here:

- Node decomposition: vertical slices, expand-migrate-contract and the debug chain.
- Model routing through `category` and disjoint parallel write scopes.
- Data passed through `dependsOn` and the node prompt contract.
- The verification wave, two-axis review template and safe-but-wrong audit checklist.
- The failure playbook.

Reading does not replace planning.
Give each independent file or named section its own node.
Use a synthesis node that depends on those nodes to assemble their results.
A producer with three or more deliverables needs further splitting.

If the cause is unknown, use a diagnosis node followed by a dependent fix node.
If verification needs the reproduction command found during diagnosis, use two runs: diagnosis, then fix.
See the Debug chain in the reference.

Before `start`, state one concise run plan:

- Components and waves.
- A one-line reason for every non-`quick` category.
- Edges and the data each edge carries.
- The verification node.

Execute that plan.

## Alignment

After reading the reference and before writing the run plan, ask at most one round of questions.
Ask only when one of these is ambiguous and Read or `rg` cannot settle it:

- Deliverable kind, such as a CLI versus a document.
- Scope: the files or components that are in or out.
- Acceptance criteria: the observable result that counts as done.

Look up facts; never ask for them.
If nothing is ambiguous, skip the round silently and plan.
Put the round in a single AskUserQuestion call with at most 4 numbered questions.
Give each question a recommended answer as its first option, so a plain yes accepts it.
If the injected protocol marks the session non-interactive, skip the round and decide.
Write every assumption into `definition.goal` and the node prompts.
When the request is large and vague, suggest `/dag-workflow:interview` (multi-round interview) or `/dag-workflow:pm` (PRD interview).
Those skills are user-invoked only; never invoke them.
After the answers, write the confirmed goal into `definition.goal` and the acceptance criteria into `verify`.

## The shape

A run is a declarative definition with these fields:

| Field | Meaning |
| --- | --- |
| `key` | Stable idempotency key. Starting the same key with the same definition returns the existing run. |
| `name` | Human-readable name. |
| `goal` | Run goal. |
| `nodes` | Nodes to execute. |

Two optional definition fields, `review` and `commit`, make the plugin generate the review pair and the commit node for a code-changing run.

Each node has these fields:

| Field | Meaning |
| --- | --- |
| `id` | Node identifier. |
| `prompt` | Self-contained English instruction. |
| `category` | Routes the node to a model. |
| `dependsOn` | Optional list of node ids that must complete first. |
| `verify` | Required: 1-16 checks that the runtime executes after the node reports completion. |
| `writes` | Optional project-relative files or folders the node will change. Makes overlapping scopes across sessions visible. |

Each check uses one of these forms:

- `{"kind": "file", "path": "<path>", "contains"?, "absent"?, "matches"?, "lastLine"?, "equals"?}`; every given text field must hold.
- `{"kind": "command", "argv": ["<program>", "<arg>"], "expect"?: {"exit"?, "stdout"?, "stderr"?}}`; without `expect.exit` only exit 0 passes.

`start` and `amend` refuse nodes without checks (`verification_required`).
Paths in `writes` cannot be absolute, contain `..`, or point inside `.claude`.
A relative verify path may not contain a `.claude` segment in any case; an absolute one is read-only and may not reach `.claude/dag`.

Optional extras are `agent`, `label`, `task_summary`, `description` and `load_skills`.
`agent` selects a subagent type, such as `Explore`.
`load_skills` names plugin skills to load first:

- `dag-workflow:debugging` for diagnosis and fix nodes.
- `dag-workflow:review-standards` for the review-standards node.
- `dag-workflow:testing` for nodes that write code and tests.

`dependsOn` controls order and passes data.
When a node starts, the plugin adds its direct dependencies' outputs to its prompt.
Each output includes the `## Output` section, up to 4,000 characters, and the full report path.
List as dependencies exactly the nodes whose results a node consumes - no more, no fewer.

```json
{
  "action": "start",
  "definition": {
    "key": "docs-refresh-1",
    "name": "Docs refresh",
    "goal": "README.md documents the current DAG tool actions in hooks/engine/tool-spec.ts, with an independent audit report.",
    "nodes": [
      { "id": "audit", "category": "quick", "writes": ["notes/docs-audit.md"],
        "verify": [{ "kind": "file", "path": "notes/docs-audit.md", "contains": "## Stale pages" }],
        "prompt": "TASK: Compare README.md with hooks/engine/tool-spec.ts. DELIVERABLE: notes/docs-audit.md with a '## Stale pages' section listing missing or wrong action descriptions. SCOPE: read those two files, write only the report. VERIFY: recheck each finding against the tool schema. STOP WHEN: every action has been checked and the report exists." },
      { "id": "rewrite", "category": "writing", "dependsOn": ["audit"], "writes": ["README.md"],
        "verify": [
          { "kind": "file", "path": "README.md", "contains": "/dag run" },
          { "kind": "command", "argv": ["git", "diff", "--check", "--", "README.md"] }
        ],
        "prompt": "TASK: Correct README.md using the audit. DELIVERABLE: updated action descriptions. SCOPE: edit README.md only. VERIFY: compare the changed descriptions to hooks/engine/tool-spec.ts and run git diff --check -- README.md. STOP WHEN: each finding is addressed." },
      { "id": "verify", "category": "unspecified-low", "dependsOn": ["rewrite"], "writes": ["notes/docs-verify.md"],
        "verify": [
          { "kind": "command", "argv": ["claude", "plugin", "validate", "."] },
          { "kind": "file", "path": "notes/docs-verify.md", "lastLine": "Action audit: PASS" }
        ],
        "prompt": "TASK: Independently compare every documented action with hooks/engine/tool-spec.ts. DELIVERABLE: notes/docs-verify.md with evidence per action; end the file with Action audit: PASS only if all match. SCOPE: read README.md and hooks/engine/tool-spec.ts, write only the report. VERIFY: run claude plugin validate . and record its result. STOP WHEN: every action has a supported verdict; report failed if any mismatch remains." }
    ]
  }
}
```

The plugin adds the reporting contract to each node prompt.
Each final report ends with an `## Output` section and a `DAG_NODE_STATUS: completed|failed: <reason>` line.
Your prompt specifies the facts, values, file paths and decisions that dependents need in Output.

## Goal before start

Every run has a goal.
Write `definition.goal` as one actionable sentence that names the graph's deliverable.
Every node sees it.
Treat completion claims as false until captured evidence proves them.
The runtime's `verify` checks gate each node.
The verification node supplies evidence for the whole result.
The run is done when the goal's observable condition holds, not merely when the last node reports.

## Running a DAG

- `start` returns immediately with `run_id`, a snapshot and `warnings`. Treat every warning as a definition defect. The contract audit has one exception: the three-files warning on a node identified as a vertical slice in your plan. Cancel and start the corrected definition under a new key, or `amend` it before the affected nodes run.
- If `start` returns `awaiting_approval: true`, the user must approve the run in the /dag pane or with /dag approve; tell the user once and end your turn. Do not poll; a message arrives when it is approved or rejected.
- Do not poll. Each finished node sends a short progress note with an output excerpt. The plugin sends the run-settled message as a prompt with every node's output and report path. Between messages, plan or read independently, or end your turn.
- `snapshot {run_id}` is a one-off read for a midpoint decision. `wait {run_id}` returns the same snapshot and cannot block.
- One run covers one phase. If the next phase depends on this one's findings, read the settled outputs. Then `start` a run under a new key, with the needed facts in its prompts.
- Group related changes into one phase run with one verification wave at the end (one review pair for code), not a review pair per small change.
- The user can execute definition files with `/dag run <file.yaml|json>` and watch runs in the `/dag` pane.
- To run a definition that already exists as a file (for example `flows/<name>.yaml`), call `start {path}` with the project-relative `.yaml`, `.yml` or `.json` path instead of transcribing it into `definition`. Pass exactly one of `path` and `definition`. The same planning gate, lint `warnings` and key reuse apply. A bad path returns `invalid_request`; an unreadable or unparsable file returns `definition_unreadable`.
- To check the waves, models, write conflicts and lint warnings before starting, call `start` with `dryRun: true` (with `definition` or `path`); it validates and returns a preview but creates no run. Nodes without `writes` that can run beside another node are listed in `unchecked_writes`.

## Recovering a node - retry, amend, send

You can recover a settled run. Completed nodes keep their results:

- `retry {run_id}` starts a fresh attempt for each failed or cancelled node and re-runs their skipped dependents. `node_id` + `prompt` edits the retried node's instruction. A running run returns `run_still_active`. A completed node returns `node_not_retryable`; use `amend`.
- `amend {run_id, definition}` compares fingerprints: prompt, category, agent, dependsOn, verify and writes. Only changed or added nodes and their transitive dependents re-run. Changing a running node returns `amend_running_node`. Keep the same key.
- `send {run_id, node_id, message}` steers a running node. A finished node returns `node_not_continuable`; retry it with a prompt.
- `cancel {run_id, reason}` stops running nodes and cancels nodes not yet started. Cancel only to abandon the plan, never from impatience.
- A run the user rejected returns `rejected_by_user` to `retry`, `amend` and an identical `start`; a revised plan needs a new key and the user's go-ahead.

## Verification and automatic recovery

After a node reports completion, the runtime executes its `verify` checks.
Commands run from the project root without a shell, with a 30-second limit. Exit code 0 passes unless `expect.exit` names other codes.
The runtime saves evidence to `.claude/dag/runs/<run_id>/<node>.verification.<attempt>.json` before marking the node `completed`.
A failed check or missing evidence makes the node `failed` and prevents its dependents from starting.

A passing check proves only what it checks, not semantic correctness.
Choose checks that fail when the deliverable is wrong. Never use a no-op such as `true`.
Use `lastLine` for a verdict line, `absent` on a file or folder for text that must be gone, and `expect` for a command that must fail with a named symptom.
The reference's verify contract lists the fields and their rules; a Bash wrapper is needed only for pipelines.
For a code-changing run, declare `review: {request}` and `commit: [{message, paths}]` instead of writing the review pair and commit node by hand.
The plugin expands them into `review-spec`, `review-standards` and `commit`; the reference's two-axis review shows the fields.

Never name deliverables REPORT*.md, SUMMARY*.md, FINDINGS*.md or ANALYSIS*.md when you choose the name.
Claude Code refuses subagent Write calls to those names (2.1.288, re-checked on 2.1.295).
Use `<node-id>-notes.md` or return text in `## Output`.
When the user requires such a name, the producing node puts the full file text in `## Output` (or writes `<node-id>-notes.md`).
After the run settles, the main conversation writes the requested file verbatim with Write, then Reads it back.
Never ask a node to work around the block with Bash, `mv` or a rename: that circumvents a host guard.

A node from an old definition without `verify` fails as unverified.
Amend the definition with checks. Do not treat that node as done.

`auto_recovery` is on by default.
With a confident Jev classification, a failed node retries automatically:

- `transient`: use the same model grade.
- `implementation`: use Opus.

Recovery allows at most two extra attempts per node and keeps the original prompt, scope and goal.
The following cases wait for your `retry` or `amend`:

- `missing-input`, `clarification` or `permanent`.
- Uncertain or failed classifications.
- Cancelled runs or pending handoffs.
- Nodes without checks.

## Resume and other sessions

Checkpoints are stored under `.claude/dag/runs/`.
Each node's full report is at `.claude/dag/runs/<run_id>/<node>.md`.
When the same session resumes, nodes whose agents are gone start again.

Another session's run is read-only.
`attach` adopts it only when its owner is inactive and no handoff is pending.
Otherwise it returns `owner_active` or `manual_handoff_required`.

Only the user can move a run between live sessions:

1. The owner runs `/dag handoff <run> <session>`.
2. Running nodes finish while no new nodes start.
3. The target user runs `/dag accept <run>`.

You cannot issue these commands.

The plugin keeps the session's last 8 user requests and pinned notes.
It re-injects a bounded context snapshot with source paths at these points: first prompt, after compaction, after `/clear`, and resume.
Later prompts carry it only when run or note state changed since you last saw it; progress and settle messages carry their own news.

| Action | Reads |
| --- | --- |
| `context` | Context snapshot. |
| `decisions` | Decision history. |
| `sessions` | Same-project sessions with overlapping declared `writes`. |

Overlaps are information only. Serialize the work or narrow `writes` when you find one.

## Supervising a run

Use each progress note to supervise the work.
Compare the finished node's output with its own prompt: assigned work, scope and depth.
If a running node drifts, `send` it the exact boundary it crossed.
If a finished node's output is wrong, `retry` or `amend` it after the run settles.
Correcting drift during the run can take one message. Discovering it during synthesis can cost the run.

## What the main conversation may do

Under strict enforcement, the main conversation can use:

- Read, LSP, web search/fetch, AskUserQuestion and plan mode.
- Task listing and stopping, plus the dag tool.
- Read-only Bash, as listed below.
- Write, limited to a REPORT*, SUMMARY*, FINDINGS* or ANALYSIS* .md file the user asked for, copying a settled node's Output or notes verbatim.

Read-only Bash includes `ls`, `cat`, `rg`, and `find` without `-exec`/`-delete`.
It also includes `git status|log|diff|show|...`, `<tool> --version`, `uv pip list|freeze|show|check`, and printing `sed -n`.
A leading `command` is accepted (as in `command claude --version`), and the command after it is still checked.
`for`/`if`/`while` loops are allowed if every command is read-only.

Other tools are refused with an instruction to move the work into a node.
Keep plans in the DAG definition, never TodoWrite or TaskCreate.
Verify a settled run with Read and read-only Bash.
If verification needs commands beyond that scope, use a verification node.