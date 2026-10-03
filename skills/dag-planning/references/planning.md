# dag-planning reference

Read this file IN FULL before you define any graph. A graph defined without it is unplanned work: unplanned runs collapse into one or three big nodes with no verification. Every section below exists because its absence fails in practice.

Reading this file is not planning. Before `start`, write the run plan in one breath and then execute THAT plan: the components, the waves and their sizes, the edges and what each edge carries, a one-line reason for every non-`quick` category, and the verification node. When reality forces a change, replan out loud instead of drifting node by node.

## Decomposition doctrine

**TOPOLOGY LOCK first.** Before writing any node, enumerate the 1-6 top-level components that can each succeed or fail independently. Every node you define traces to exactly one component. Do not collapse a multi-component request into one blob node because it "looks small" - and do not invent components the request does not have.

**Split first, route second.** The default question is never "which category does this chunk need" but "how do I turn this chunk into more `quick` nodes". When work splits into independent pieces that can run in parallel SAFELY - disjoint write scopes, self-contained prompts, each piece verifiable on its own - many small `quick` nodes in parallel beat one big node on a smarter model. Parallel quick lanes finish sooner, fail in isolation, and cost less per unit of work. Reach for a bigger model only for what SURVIVES splitting: the piece that cannot be decomposed without losing the whole-problem context it needs.

**Do not split when:** (1) the pieces would share a write scope you cannot untangle - serialize or merge instead of pretending independence; (2) the work is one coherent judgment that needs the whole problem in view (a design decision, a root-cause diagnosis) - splitting it produces confident partial answers, not a verdict; (3) the pieces get so small that spawning and briefing a node costs more than the work itself.

**Wave sizing.** Size each wave to the work's natural grain: one node per genuinely independent chunk, whether that is two or forty. Never merge independent chunks to make a wave look smaller - the plugin runs at most `max_concurrent` nodes of one run at a time (default 8) and queues the rest as `scheduled`, so width costs queue time, never correctness. A wave wider than about ten fans in through an aggregator or verification node that reads the bounded per-node outputs. Split along the axis that makes pieces independent:

- **By component** - each independently shippable part is its own lane.
- **By file domain** - when one component spans disjoint file sets, one node per set.
- **By phase** - collect lanes (investigate in parallel) -> verify lanes (falsify the collections) -> synthesize (turn verified facts into the deliverable).

**Default shape is fan-out, then fan-in.** N parallel lanes with no dependencies, then one synthesis node that depends on all of them and receives all their outputs. The synthesis node starts cheap too (`quick` or `unspecified-low`): merging verified pieces is mechanical unless the merge itself needs judgment.

**One-step tasks are one-node DAGs.** The main conversation cannot do the work itself, so a single edit is still a node - give it the full prompt contract and a VERIFY step instead of inventing extra nodes.

**Large harvests: nodes are not units of work.** When a scan must cover hundreds of files or sources, shard items INTO nodes: each `quick` node owns a batch (about 50-200 items) and writes ONE bounded report file, so `nodes = ceil(items / items_per_node)`. The aggregator reads those report files, never hundreds of raw outputs.

**Split implementation from its test? No.** One node owns one deliverable end to end: the change AND its proof. A node that only writes code and a node that only tests it serialize on the same files and double the coordination cost. The verification wave below is a SEPARATE falsification pass, not the producer's own test.

## Category routing

`category` routes the node to a model. **Start every node at `quick` and climb only as far as the work's difficulty demands. Specialty categories are chosen by the KIND of work, never by difficulty.**

The main conversation proposes each category when writing the DAG definition; a user-authored definition supplies its own proposals. With Jev enabled and TYPESAFE_API_KEY configured, the plugin independently classifies node tasks using the criteria in hooks/engine/jev.ts before execution. A sufficiently confident Jev choice overrides the proposed category; uncertain or unavailable decisions retain it. The original definition remains unchanged: snapshots expose the actual category and decision source in routing, and the started model in model. Every worker uses Sonnet or Opus; Haiku is not a worker route.

The difficulty ladder, bottom rung first:

1. **`quick`** (sonnet) - THE DEFAULT. Mechanical, single-file, or pattern-following work. You need a reason to leave it.
2. **`unspecified-low`** (sonnet) - small but not mechanical: a few files, or a judgment call a template cannot make.
3. **`unspecified-high`** (opus) - a standard multi-file feature or fix with real integration surface.

Escalate a node only with a one-line reason you could say out loud ("touches six files across three packages") - and only AFTER the split-first doctrine: a chunk that decomposes into safe parallel `quick` pieces was never a ladder candidate.

**One standing exception: the final audit.** The last verification node - the one nothing depends on, which judges the whole result from two or more inputs - never runs on `quick`. Route it to `unspecified-low`, or higher when it must reason across many files. This distinguishes judgment from mechanical checks, not model strength: `quick` and `unspecified-low` both use Sonnet. Checks that only run a command and compare its output (a per-lane test or build) stay `quick`.

Specialty categories:

| Category | Model | Route a node here when |
| --- | --- | --- |
| `visual-engineering` | sonnet | Frontend, UI, styling, animation. |
| `writing` | sonnet | Docs, prose, technical writing. |
| `deep-low` | sonnet | Hairy debugging or cross-module reasoning a ladder rung could not hold, settled from what the worker reads. |
| `deep-high` | opus | The same, when the central decision cannot be settled from evidence: a trade-off, a cross-package contract, correctness argued from invariants. |
| `ultrabrain` | opus | At most ONE node per graph - the single genuinely hard reasoning problem everything else depends on. |
| `architect` | opus | System design: weigh options and propose the design other nodes implement. |
| `artistry` | opus | Unconventional problem-solving beyond standard patterns. |

Without a confident Jev override, a node without `category`, or with an unrecognized category, explicitly runs on Sonnet rather than inheriting the session or agent type's model. A graph whose every node is `deep-*` or opus-routed is a routing failure: it pays the most expensive worker for mechanical lanes. Use `agent` only when a specific subagent type fits better than `general-purpose` (for example `Explore` for read-only investigation).

## Edges, data and write scopes

- **`dependsOn` carries data.** A node receives the `## Output` of each DIRECT dependency (up to 4,000 characters each) and the path of each dependency's full report. Transitive ancestors are not pasted: when a node needs a grandparent's fact, make the parent's Output carry it or add the direct edge.
- **Add an edge exactly when the node consumes the other node's result.** If B only needs a fact YOU already know, paste the fact into B's prompt and leave the edge out - an unnecessary edge serializes work that could run in parallel.
- **Design every Output for its consumers.** The producer's prompt names what its Output must contain - file paths, values, decisions, counts - in a compact, parseable shape. A downstream node is only as good as the facts it was handed.
- **Disjoint write scopes or serialize.** No two nodes that can run at the same time may edit the same file. If two lanes must touch the same files, chain them with `dependsOn` or merge them into one node. Declare each node's read and write scope inside its prompt, and list the write scope in the node's `writes` field (project-relative paths or folders, never absolute, `..` or `.claude`). The plugin shows overlaps between `writes` of active sessions in the same project; it never blocks or reschedules on them, so disjointness inside one graph is still your job.
- **Dependency self-check before `start`:** every `dependsOn` id exists; no cycles; no node depends on something it does not consume; every wave has at least one runnable node. The plugin refuses unknown ids, self-edges and cycles with `unknown_dependency`, `invalid_dependency` and `cycle`.

## Composing runs

The main conversation is the orchestrator AROUND runs:

- **One run per phase.** When phase 2's graph depends on what phase 1 found, let phase 1 settle, read the outputs in the settle summary (and the report files when the excerpt is not enough), then `start` phase 2 under a NEW key with the relevant facts pasted into its prompts.
- **Data-driven width.** Build the node list from what actually exists - list the files or items with Read and read-only Bash first, then define one node per chunk - instead of guessing the fan-out up front.
- **Concurrent runs.** Distinct keys run concurrently. Start independent graphs together; each settles on its own.
- **Adaptive recovery stays in the same run.** `retry` and `amend` recover in place; a new key is never the retry mechanism - it starts a different run. Re-issuing the same definition under the old key returns the existing run (`reused: true`) and schedules nothing.
- **Completion messages drive the next step.** Call `start` and return. Progress notes and the run-settled message wake the conversation; the settled message is where the next phase is planned.
- Outputs pasted into later prompts must be quoted or summarized to the part the next node needs; an unbounded paste drowns the instruction.

## Node prompt contract

A node prompt is the ONLY thing the worker sees besides the goal and its upstream results. It has no conversation history, no access to your reasoning, and no way to ask you questions. Write every prompt so a competent stranger executes it exactly. Every node prompt carries, in this order:

1. **TASK:** one imperative sentence naming the deliverable.
2. **DELIVERABLE:** the concrete artifact: files changed, the exact report shape, the evidence produced - and what the `## Output` section must contain for the dependents.
3. **SCOPE:** what the node may read and write, with exact paths, stated as a HARD boundary. Name what is OUT of scope when a neighboring node owns it.
4. **VERIFY:** the check the node runs on its own work before reporting: the literal command and its expected result. Mirror it in the node's machine-run `verify` field (below).
5. **STOP WHEN:** the single observable condition that ends the node's work.

Rules that make node prompts obeyed:

- **Self-contained, always.** Paste exact paths, facts and constraints INTO the prompt. "As discussed above" is a dangling reference - the node sees nothing above.
- **Minimum sufficient context.** Every pasted fact must change what the node does.
- **Binary observables.** PASS/FAIL must be decidable from the prompt alone: "exit code 0 and `dist/index.js` exists", never "check it works".
- **Positive framing.** Tell the node what to do. Reserve NEVER/ONLY for true invariants (do not commit, do not edit outside scope).
- **Emphasis lives in the words.** UPPERCASE and strong verbs for load-bearing rules; no emojis or decoration.
- **One role per node.** A node that investigates does not also fix; a node that writes does not also review its own work.

**The `start` result audits this contract.** `start` returns `warnings` when a node prompt lacks the literal `TASK:` or `STOP WHEN` markers, or when a graph of two or more nodes has no verification node (a node whose id, label or summary says verify, validate, check, test, review or audit, and that depends on other nodes), or when the final audit (a verification node nothing depends on, with two or more inputs) runs on `quick`. Warnings never block the run - treat them as defects: cancel and start the fixed definition under a NEW key, or `amend` it before the affected nodes run.

## The `verify` contract

Every node in `start` and `amend` must carry `verify`: 1-16 checks, each `{"kind": "file", "path": "<project-relative>", "contains": "<nonempty text>"}` (`contains` optional) or `{"kind": "command", "argv": [...]}`. Missing checks are refused with `verification_required`, malformed ones with `invalid_verification`. After the worker reports completion, the runtime runs the checks itself (commands from the project root without a shell, 30-second limit, exit 0 passes), writes `.claude/dag/runs/<run_id>/<node>.verification.<attempt>.json`, and only then marks the node `completed`. A failed check or missing evidence fails the node and blocks its dependents.

- Choose checks that FAIL when the deliverable is wrong: the test command that covers the change, a file plus the heading or value its consumers parse. `true`, `echo ok` or an existence check on a file that already existed proves nothing.
- A passed check proves only the declared check. Semantic correctness beyond it still needs the verification wave below.
- `verify` and `writes` are in the fingerprint, so changing them through `amend` re-runs that node and its dependents.
- An old definition or checkpoint without `verify` is unverified, not verified. Amend it with real checks; do not report its nodes as done.

## Verification wave

**Every graph that changes something ends with at least one verification node** that depends on ALL producer nodes and therefore receives all their outputs. The synthesis node's own claim is not evidence.

- The verification node runs the REAL check - the test command, the build, the endpoint call - and reports the captured output in its `## Output`.
- The final audit falsifies the whole result against the repository, not the producers' reports, so it runs on `unspecified-low` or higher (see Category routing).
- Its prompt names the exact invocation and the binary observable that decides PASS vs FAIL, and tells it to report `DAG_NODE_STATUS: failed: <what failed>` when the check fails.
- **A paginated deliverable (PDF, DOCX, deck, print HTML) is verified by its rendered pages**, every page, not by file size or keyword probes.
- **Node outputs are claims until verified.** A downstream node that builds on an upstream result re-checks the specific facts it depends on (the file exists, the test passes, the symbol is exported) before trusting them.
- After the run settles, the main conversation verifies the goal itself with Read and read-only Bash before reporting success.

## Failure playbook

- **A failed node blocks only its dependents** (they become `skipped`); independent lanes keep running. Read the node's error and output first, then recover that node in place - never rebuild the graph.
- **Automatic recovery may act first.** With `auto_recovery` on and a confident Jev classification, a `transient` failure retries on the same model grade and an `implementation` failure retries on Opus, at most two extra attempts per node, keeping prompt, scope and goal. Missing input, clarification, permanent or uncertain failures, API errors, cancellations, pending handoffs and nodes without `verify` wait for you. Read the decision with the `decisions` action before overriding it.
- **`retry` is the first manual move.** It gives every failed or cancelled node a fresh attempt and hands their skipped dependents back to the scheduler; completed nodes keep their results. `node_ids` targets specific nodes; one `node_id` plus `prompt` edits that node's instruction as it retries. Refusals: `run_still_active` (let the wave settle), `node_not_retryable` (a completed node - use `amend`; or a skipped node whose failed ancestor is not in the retry set), `nothing_to_retry`, `invalid_request` (a prompt with several nodes).
- **`amend` when the definition itself was wrong.** Unchanged completed nodes keep their results; only changed or added nodes and their transitive dependents re-run. The fingerprint covers prompt, category, agent, dependsOn, verify and writes; `load_skills`, `label` and the summary fields are outside it, so editing only those re-runs nothing. Refusals: `amend_running_node`, `key_mismatch`.
- **`send` only steers a running node.** A finished node is `node_not_continuable`: retry it with a prompt.
- **Ownership.** A run started in another session answers `not_owner` to cancel, retry, amend and send until it is yours. `attach` works only when the owner session is inactive and no handoff is pending; a live owner hands the run over through the user commands `/dag handoff <run> <session>` and `/dag accept <run>`, and only unfinished nodes resume.
- **A quiet pane is not a stall.** Nodes past `max_concurrent` wait in `scheduled`. A running node marked `possibly stalled` has produced no tokens for a while: check its activity before acting; elapsed time alone never justifies cancelling.
- **Provider storms.** If many nodes of one wave fail within seconds of starting, the model route is erroring, not your prompts: fix the route, then `retry`.
- **Verify a node's claim before you trust its state.** A node counts as completed when its agent returns, even with a report that says it was blocked. Read the output; `retry` the node when the report shows it never did the work.
- **Cancel is for abandoning the goal**, never for impatience. Pass a reason so the run record says why.
