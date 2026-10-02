---
name: dag-planning
description: Mandatory planning doctrine for dag-workflow. Load it BEFORE the first mcp__dag-workflow__dag start or amend in a session - the plugin refuses that start until this skill is loaded. Covers turning a task into a dependency-ordered DAG of subagent nodes, how results flow along dependsOn, the node prompt contract, the verification wave, and recovering runs.
when_to_use: Any task in a session where dag-workflow enforces DAG orchestration - planning a DAG, writing node prompts, reading a run-settled summary, retrying or amending a run, chaining a follow-up run.
argument-hint: "[task]"
---

# dag-planning

In this session every piece of work runs as a DAG of subagent nodes through `mcp__dag-workflow__dag`. The main conversation plans, reads, orchestrates and verifies; Edit, Write, mutating Bash, Agent and the other work tools run INSIDE DAG nodes. This skill is how you plan that DAG well. A one-step task is a one-node DAG - the rules below still apply.

## Planning - MANDATORY first step

Before defining ANY graph, read `${CLAUDE_SKILL_DIR}/references/planning.md` IN FULL with the Read tool. It carries the doctrine this file deliberately omits: how to decompose the request into nodes, how to route each node's `category`, how to keep parallel write scopes disjoint, what to pass along `dependsOn`, the node prompt contract, the verification wave, and the failure playbook. A graph defined without it is unplanned work.

Reading is not planning. Before `start`, write the run plan in one breath - the components, the waves, a one-line reason for every non-`quick` category, the edges and what each edge carries, and the verification node - then execute THAT plan.

## The shape

A run is a declarative definition: a stable `key` (idempotency: starting the same key with the same definition returns the existing run), a human `name`, a `goal`, and `nodes`. Each node has an `id`, a self-contained English `prompt`, a `category` that routes it to a model, and optional `dependsOn` listing the node ids that must complete first. Optional per-node extras: `agent` (a subagent type such as `Explore`), `label`, `task_summary`, `description`, `load_skills`.

`dependsOn` is ordering AND data. When a node starts, the plugin pastes the outputs of its direct dependencies into its prompt (each one's `## Output` section, up to 4,000 characters, plus the path of the full report). List as dependencies exactly the nodes whose results a node consumes - no more, no fewer.

```json
{
  "action": "start",
  "definition": {
    "key": "docs-refresh-1",
    "name": "Docs refresh",
    "goal": "Every page under docs/ matches the current API in src/, and every code sample compiles.",
    "nodes": [
      { "id": "audit", "category": "quick", "prompt": "TASK: List every page under docs/ that references an API missing from src/. DELIVERABLE: ... SCOPE: read docs/ and src/, write nothing. VERIFY: ... STOP WHEN: ..." },
      { "id": "rewrite", "category": "writing", "dependsOn": ["audit"], "prompt": "TASK: Rewrite each page the audit node listed against src/. ..." },
      { "id": "verify", "category": "quick", "dependsOn": ["rewrite"], "prompt": "TASK: Compile every code sample under docs/ and check every internal link. ..." }
    ]
  }
}
```

The plugin appends the reporting contract to every node prompt itself: each node ends its final report with an `## Output` section and a `DAG_NODE_STATUS: completed|failed: <reason>` line. Your prompt says WHAT the node must put in its Output - the facts, values, file paths and decisions its dependents need.

## Goal before start

Every run is goal-bound. `definition.goal` names the deliverable the graph produces in one sentence that a node can act on; every node sees it. Completion claims are false until proven against captured evidence: the verification node produces that evidence, and the run is done when the goal's observable condition holds - never merely when the last node reports.

## Running a DAG

- `start` returns at once with `run_id`, a snapshot and `warnings`. Treat every warning as a defect in your definition (see the contract audit in the reference): cancel the run and start the fixed definition under a NEW key, or `amend` it before the affected nodes run.
- Do not poll. Each finished node sends a short progress note with its output excerpt, and the run-settled message arrives as a prompt from the plugin with every node's output and report path. Do independent planning or reading between messages, or end your turn.
- `snapshot {run_id}` is a one-off read for a midpoint decision. `wait {run_id}` returns the same snapshot; it cannot block.
- One run covers one PHASE. When the next phase depends on what this one found, read the settled outputs and `start` the next run under a new key with the relevant facts pasted into its prompts.
- The user can run definition files with `/dag run <file.yaml|json>` and watch any run in the `/dag` pane.

## Recovering a node - retry, amend, send

A settled run is not a dead end, and completed nodes keep their results:

- `retry {run_id}` gives every failed or cancelled node a fresh attempt and re-runs their skipped dependents. `node_id` + `prompt` edits that node's instruction as it retries. A running run refuses with `run_still_active`; a completed node refuses with `node_not_retryable` - use `amend`.
- `amend {run_id, definition}` diffs each node's fingerprint (prompt, category, agent, dependsOn): only changed or added nodes and their transitive dependents re-run. Amending a running node is refused with `amend_running_node`; the key must stay the same.
- `send {run_id, node_id, message}` steers a RUNNING node in place. A finished node cannot be revived (`node_not_continuable`); retry it with a prompt instead.
- `cancel {run_id, reason}` stops the run's running nodes and cancels everything not started. Cancel is for abandoning the plan, never for impatience.

## Resume and other sessions

Runs are checkpointed under `.claude/dag/runs/`, with each node's full report in `.claude/dag/runs/<run_id>/<node>.md`. When the same session resumes, nodes whose agents are gone start again. A run owned by another session is read-only until you `attach` it, which adopts the run and continues its remaining nodes here.

## Supervising a run

Observation is supervision. On every progress note, check the finished node's output against ITS OWN prompt's scope: the assigned work, only the assigned work, at the assigned depth. When a still-running node is drifting, `send` it the exact boundary it crossed; when a finished node's output is wrong, `retry` or `amend` it once the run settles. Drift corrected mid-run costs one message; drift found at synthesis costs the run.

## What the main conversation may do

Under strict enforcement the main conversation keeps Read, LSP, web search/fetch, AskUserQuestion, plan mode, task listing/stopping, read-only Bash (`ls`, `cat`, `rg`, `find` without `-exec`/`-delete`, `git status|log|diff|show|...`) and the dag tool. Everything else is refused with an instruction to move the work into a node. Plans live in the DAG definition, never in TodoWrite or TaskCreate. Verify a settled run with Read and read-only Bash, or with a verification node when the check needs to run commands.
