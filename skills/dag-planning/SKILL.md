---
name: dag-planning
description: Mandatory planning doctrine for dag-workflow. Load it BEFORE the first mcp__dag-workflow__dag start or amend in a session - the plugin refuses that start until this skill is loaded. Covers turning a task into a dependency-ordered DAG of subagent nodes, how results flow along dependsOn, the node prompt contract, the verification wave, and recovering runs.
when_to_use: Any task in a session where dag-workflow enforces DAG orchestration - planning a DAG, writing node prompts, reading a run-settled summary, retrying or amending a run, chaining a follow-up run.
argument-hint: "[task]"
---

# dag-planning

In this session every piece of work runs as a DAG of subagent nodes through `mcp__dag-workflow__dag`. The main conversation plans, reads, orchestrates and verifies; Edit, Write, mutating Bash, Agent and the other work tools run INSIDE DAG nodes. This skill is how you plan that DAG well. A one-step task is a one-node DAG - the rules below still apply.

If the `mcp__dag-workflow__dag` tool is unavailable, the mod is switched off (`--safe-mode`, `disableAllHooks` or `allowManagedModsOnly` leave skills loaded but remove the tool and hooks). Tell the user that DAG orchestration is off for this session and do the work directly; make no claims about runs, nodes, panes or checkpoints, and do not follow the rest of this skill.

## Planning - MANDATORY first step

Before defining ANY graph, read `${CLAUDE_SKILL_DIR}/references/planning.md` IN FULL with the Read tool. It carries the doctrine this file deliberately omits: how to decompose the request into nodes, how to route each node's `category`, how to keep parallel write scopes disjoint, what to pass along `dependsOn`, the node prompt contract, the verification wave, and the failure playbook. A graph defined without it is unplanned work.

Reading is not planning. Split by deliverable: each independent file or named section gets its own node, and a synthesis node that depends on those lanes assembles them - a producer owning three or more deliverables is under-split. When the cause of a problem is unknown, diagnose in one node and fix in a dependent node.

Before `start`, write the run plan in one breath - the components, the waves, a one-line reason for every non-`quick` category, the edges and what each edge carries, and the verification node - then execute THAT plan.

## The shape

A run is a declarative definition: a stable `key` (idempotency: starting the same key with the same definition returns the existing run), a human `name`, a `goal`, and `nodes`. Each node has an `id`, a self-contained English `prompt`, a `category` that routes it to a model, and optional `dependsOn` listing the node ids that must complete first. Every node also REQUIRES `verify`: 1-16 checks the runtime itself runs after the node reports completion, each either `{"kind": "file", "path": "<project-relative>", "contains": "<nonempty text>"}` (`contains` optional) or `{"kind": "command", "argv": ["<program>", "<arg>"]}`. `start` and `amend` refuse a definition with any node lacking it (`verification_required`). Optional `writes` lists the project-relative files or folders the node will change, so overlapping scopes across sessions become visible. Paths in both fields cannot be absolute, contain `..`, or point inside `.claude`. Optional per-node extras: `agent` (a subagent type such as `Explore`), `label`, `task_summary`, `description`, `load_skills`.

`dependsOn` is ordering AND data. When a node starts, the plugin pastes the outputs of its direct dependencies into its prompt (each one's `## Output` section, up to 4,000 characters, plus the path of the full report). List as dependencies exactly the nodes whose results a node consumes - no more, no fewer.

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
          { "kind": "file", "path": "notes/docs-verify.md", "contains": "Action audit: PASS" }
        ],
        "prompt": "TASK: Independently compare every documented action with hooks/engine/tool-spec.ts. DELIVERABLE: notes/docs-verify.md with evidence per action; write Action audit: PASS only if all match. SCOPE: read README.md and hooks/engine/tool-spec.ts, write only the report. VERIFY: run claude plugin validate . and record its result. STOP WHEN: every action has a supported verdict; report failed if any mismatch remains." }
    ]
  }
}
```

The plugin appends the reporting contract to every node prompt itself: each node ends its final report with an `## Output` section and a `DAG_NODE_STATUS: completed|failed: <reason>` line. Your prompt says WHAT the node must put in its Output - the facts, values, file paths and decisions its dependents need.

## Goal before start

Every run is goal-bound. `definition.goal` names the deliverable the graph produces in one sentence that a node can act on; every node sees it. Completion claims are false until proven against captured evidence: the runtime's `verify` checks gate each node, the verification node produces the whole-result evidence, and the run is done when the goal's observable condition holds - never merely when the last node reports.

## Running a DAG

- `start` returns at once with `run_id`, a snapshot and `warnings`. Treat every warning as a defect in your definition (see the contract audit in the reference): cancel the run and start the fixed definition under a NEW key, or `amend` it before the affected nodes run.
- Do not poll. Each finished node sends a short progress note with its output excerpt, and the run-settled message arrives as a prompt from the plugin with every node's output and report path. Do independent planning or reading between messages, or end your turn.
- `snapshot {run_id}` is a one-off read for a midpoint decision. `wait {run_id}` returns the same snapshot; it cannot block.
- One run covers one PHASE. When the next phase depends on what this one found, read the settled outputs and `start` the next run under a new key with the relevant facts pasted into its prompts.
- The user can run definition files with `/dag run <file.yaml|json>` and watch any run in the `/dag` pane.

## Recovering a node - retry, amend, send

A settled run is not a dead end, and completed nodes keep their results:

- `retry {run_id}` gives every failed or cancelled node a fresh attempt and re-runs their skipped dependents. `node_id` + `prompt` edits that node's instruction as it retries. A running run refuses with `run_still_active`; a completed node refuses with `node_not_retryable` - use `amend`.
- `amend {run_id, definition}` diffs each node's fingerprint (prompt, category, agent, dependsOn, verify, writes): only changed or added nodes and their transitive dependents re-run. Amending a running node is refused with `amend_running_node`; the key must stay the same.
- `send {run_id, node_id, message}` steers a RUNNING node in place. A finished node cannot be revived (`node_not_continuable`); retry it with a prompt instead.
- `cancel {run_id, reason}` stops the run's running nodes and cancels everything not started. Cancel is for abandoning the plan, never for impatience.

## Verification and automatic recovery

When a node reports completion, the runtime runs its `verify` checks (commands from the project root, no shell, 30-second limit, exit code 0 passes) and saves the evidence to `.claude/dag/runs/<run_id>/<node>.verification.<attempt>.json` before marking it `completed`. A failing check or missing evidence turns the node `failed`, so its dependents never start. Passing checks prove only what they check, not that the work is semantically right, so pick checks that would fail if the deliverable were wrong; never a no-op such as `true`. Never name a node deliverable REPORT*.md, SUMMARY*.md, FINDINGS*.md or ANALYSIS*.md: Claude Code 2.1.288 refuses subagent Write calls to those names, so use a name like `<node-id>-notes.md` or return the text in `## Output`. A node from an old definition with no `verify` fails as unverified: amend the definition with checks instead of treating it as done.

With `auto_recovery` on (the default) and a confident Jev classification, a failed node retries automatically: `transient` on the same model grade, `implementation` on Opus, at most two extra attempts per node, with the original prompt, scope and goal kept. `missing-input`, `clarification`, `permanent`, uncertain or failed classifications, cancelled runs, pending handoffs and nodes without checks are left for you to `retry` or `amend`.

## Resume and other sessions

Runs are checkpointed under `.claude/dag/runs/`, with each node's full report in `.claude/dag/runs/<run_id>/<node>.md`. When the same session resumes, nodes whose agents are gone start again. A run owned by another session is read-only. `attach` adopts it only when its owner session is no longer active and no handoff is pending (`owner_active`, `manual_handoff_required` otherwise). Moving a run between live sessions is a user action: the owner runs `/dag handoff <run> <session>`, running nodes drain while nothing new starts, and the target user runs `/dag accept <run>`. You cannot issue those commands.

The plugin keeps this session's last 8 user requests and pinned notes and re-injects a bounded context snapshot with source paths at the first prompt, after compaction, after `/clear` and on resume. The `context`, `decisions` and `sessions` actions read that snapshot, the decision history, and same-project sessions with overlapping declared `writes`. Overlaps are information only; serialize or narrow your `writes` when you see one.

## Supervising a run

Observation is supervision. On every progress note, check the finished node's output against ITS OWN prompt's scope: the assigned work, only the assigned work, at the assigned depth. When a still-running node is drifting, `send` it the exact boundary it crossed; when a finished node's output is wrong, `retry` or `amend` it once the run settles. Drift corrected mid-run costs one message; drift found at synthesis costs the run.

## What the main conversation may do

Under strict enforcement the main conversation keeps Read, LSP, web search/fetch, AskUserQuestion, plan mode, task listing/stopping, read-only Bash (`ls`, `cat`, `rg`, `find` without `-exec`/`-delete`, `git status|log|diff|show|...`, `<tool> --version`, `uv pip list|freeze|show|check`, printing `sed -n`, and `for`/`if`/`while` loops whose commands are all read-only) and the dag tool. Everything else is refused with an instruction to move the work into a node. Plans live in the DAG definition, never in TodoWrite or TaskCreate. Verify a settled run with Read and read-only Bash, or with a verification node when the check needs to run commands.
