# planning reference

Read this file in full before defining any graph.
Without it, runs can collapse into one or three large nodes without verification.
Each section addresses a failure observed in practice.

Reading does not replace planning.
Before `start`, state one concise plan and execute it.
Include the components, waves and their sizes, edges and their data, and a one-line reason for every non-`quick` category.
Name the verification node, or both review nodes for a code-changing run.
If conditions require a change, state a revised plan instead of changing nodes without explanation.

## Decomposition doctrine

**TOPOLOGY LOCK first.** List the 1-6 top-level components before writing nodes.
Each component must be able to succeed or fail independently.
Assign every node to exactly one component.
Do not merge a multi-component request into one node because it looks small.
Do not invent components.

**Split first, route second.** First ask how to split the work into more `quick` nodes, not which category it needs.
Parallel pieces must have disjoint write scopes, self-contained prompts and independent checks.
Under those conditions, many small `quick` nodes are better than one large node on a stronger model.
They finish sooner, fail independently and cost less per unit of work.
Use a stronger model only for work that still needs the full problem context after splitting.

**Do not split when:**

1. Pieces share a write scope that you cannot separate. Serialize or merge them.
2. One judgment needs the whole problem, such as a design decision or root-cause diagnosis. Splitting gives partial answers, not a verdict.
3. Starting and briefing a node costs more than its work.

**Wave sizing.** Use one node per independent piece, whether there are two or forty.
Never merge independent pieces merely to reduce wave size.
The plugin runs at most `max_concurrent` nodes per run at once (default 8).
It queues the rest as `scheduled`. Width adds queue time, not correctness risk.
For waves wider than about ten, use an aggregator or verification node to read the bounded outputs.
Split along the axis that makes pieces independent:

- **By component** - each independently shippable part is its own lane.
- **By file domain** - when one component spans independent file sets, one node per set (the layers of one feature are the exception: see Vertical slices and wide refactors).
- **By phase** - collect lanes (investigate in parallel) -> verify lanes (falsify the collections) -> synthesize (turn verified facts into the deliverable).

**Default shape is fan-out, then fan-in.** Start N parallel lanes without dependencies.
Then use one synthesis node that depends on all lanes and receives their outputs.
Start synthesis at `quick` or `unspecified-low`: merging verified results is mechanical unless the merge needs judgment.
A wide refactor is the exception. Its lanes depend on `expand` (see Vertical slices and wide refactors).

**One-step tasks are one-node DAGs.** The main conversation cannot do the work itself.
A single edit still needs a node with the full prompt contract and a VERIFY step.
Do not invent extra nodes.

**Large harvests: nodes are not units of work.** For hundreds of files or sources, assign batches to nodes.
Each `quick` node handles about 50-200 items and writes one bounded report.
Use `nodes = ceil(items / items_per_node)`.
The aggregator reads reports, not hundreds of raw outputs.

**One node, one deliverable.** Count deliverables before defining nodes.
Each independent file or separately named document section is a candidate lane: one per algorithm, page or module.
A producer needs splitting if its `writes` lists three independent files, or its prompt lists `## A`, `## B`, `## C`.
Use one `quick` or `writing` node per deliverable, without `dependsOn` between them.
Then use one synthesis node that depends on all lanes to assemble results or make recommendations.

Section writers use separate files, such as `notes/<topic>.md`.
Only the synthesis node writes the final document.
A vertical slice is one deliverable even when it changes several layers (see Vertical slices and wide refactors).

**Split implementation from its test? No.** One node owns the deliverable and its proof.
Separate code-only and test-only nodes serialize on the same files and double coordination cost.
The verification wave is a separate falsification pass, not the producer's own test.
Load the plugin's working instructions through `load_skills`:

| Node task | Skill |
| --- | --- |
| Write code and tests | `dag-workflow:testing` |
| Diagnose or fix a bug (see Debug chain) | `dag-workflow:debugging` |
| `review-standards` | `dag-workflow:review-standards` |

**Unknown cause: investigate, then fix.** If the request says "find out why" or "figure out the cause", use a diagnosis node.
This in-run approach applies when an existing command can verify the fix.
The diagnosis node's `## Output` names the file, line and root cause.
A dependent fix node receives that fact.
A fix node that diagnoses for itself has no checkable hand-off.

If you already know the cause, put it in the fix prompt and use one node.
If the fix node's `verify` requires a reproduction command that does not yet exist, use the two-run Debug chain below.

### Debug chain (diagnose run, then fix run)

**When.** The cause is unknown and a reproduction can be built.
Examples: a failing test, CLI or HTTP call, replayed payload, or small harness.

Keep the in-run diagnosis → fix chain when an existing command can verify the fix, such as the project's test command.
Use two runs when `verify` must contain the reproduction command itself.
That command does not exist at run start, but `verify` is declared at `start`.
A dependent is scheduled in the same step as dependency completion.
There is no window to insert the new command into `verify`.
`amend` repairs a wrong definition; it is not a planned second phase.

One run = one phase.
Passing the reproduction between diagnosis and fix runs crosses a phase boundary.
It is not the implementer/tester split prohibited by "Split implementation from its test? No."

**Run 1 - diagnose.** Goal: "the reproduction command and the ranked hypotheses are written down".
This run fixes nothing.
The reproduction file supports run 2; it is not a code change.
Thus `verify-repro` is run 1's whole verification wave. The two-axis review belongs to run 2.

- Start read-only investigation lanes: one `quick` node per independent area, such as the failing path, recent changes, configuration and inputs. Skip these lanes if the suspect area fits in one file. Each lane writes only `notes/<bug>-<lane>-notes.md` and never edits the investigated code.
- Use one diagnosis node that depends on all lanes. Select `unspecified-low`, or `deep-low` for difficult or cross-module debugging. Set `load_skills: ["dag-workflow:debugging"]`. Declare `writes` for `notes/<bug>-diagnosis.md` and any reproduction file to create. Use `verify` file checks for the field names below in the diagnosis notes.
- Quote the user's symptom verbatim in the prompt. The `## Output` and notes file contain exactly these fields:
  - `Reproduction command:` One command in argv form, run from the project root without a shell.
  - `Observed failure:` Exit code and symptom line, with secrets redacted.
  - `Hypotheses:` 3 to 5, ranked and falsifiable: "If X is the cause, changing Y will make the bug disappear (or changing Z will make it worse)". Refine or discard hypotheses without predictions.
  - `Root cause:` File and line, or "not yet determined".
- Use one verification node (`quick`, id `verify-repro`) that depends on diagnosis. It runs the recorded command exactly. It checks for a non-zero exit and the user's symptom line. It writes `Reproduction confirmed: exit <n>` to `notes/<bug>-repro-check.md`; this is its `verify` file check. If the command exits 0 or fails differently, end with `DAG_NODE_STATUS: failed: <what differs>`. The runtime directly accepts only exit 0. A wrapper can check an expected failure and return 0 (see "Checks for absence or expected failure"). This node independently checks both symptom and exit code. An unrelated command error is not a reproduction.
- **Red-capable rule.** Diagnosis must already have run the command and observed failure. A command that exits 0 before the fix proves nothing. The failure must be the user's symptom, not another failure. Keep the verdict the same on every run: pin the clock, seed randomness and isolate files. For intermittent bugs, repeat the trigger inside the command and exit non-zero if any iteration fails. Remove inputs, steps and configuration one at a time until each remaining element is required to reproduce the failure.
- **Fast.** The runtime kills checks after 30 seconds. First narrow slower loops to one test, a fixture or smaller input. Aim for seconds.
- **No loop.** If no red-capable loop can be built, do not guess hypotheses. List the attempts and end with `DAG_NODE_STATUS: failed: clarification: <what is needed>`. The main conversation asks for a reproducing environment, redacted artifact (log, HAR, payload), or permission for temporary instrumentation. Then it `retry`s the node with the answer.

**Run 2 - fix.** After run 1 settles, read its Output and notes.
Show the user the ranked hypotheses; users often re-rank them, but do not wait for them.
Then `start` under a new key.
Paste the facts into the prompts because nothing crosses runs automatically.

- The fix node uses `load_skills: ["dag-workflow:debugging"]`. Its prompt contains the verbatim command, observed failure, hypotheses and root cause. Never summarize the command. Its `verify` uses that same command as `{"kind": "command", "argv": [...]}` and passes only on exit 0. Put pipelines, redirects or environment setup in a script named in argv, such as `["bash", "scripts/repro-a4f2.sh"]`. The script must propagate failure exit codes.
- Order the prompt's work: run the command and report its exit code, fix the root cause, then rerun the command. If the first run exits 0, end with `DAG_NODE_STATUS: failed: missing-input: reproduction no longer fails`. Keep the reproduction file, fixtures and helpers, including indirect dependencies of regression tests and `verify`. The runtime and final audit need them after the report.
- If the command still fails, the node fails. `retry` with the original prompt plus what the attempt ruled out, so the next hypothesis moves up. `retry` replaces the prompt; it does not append to it.
- `Root cause: not yet determined` is allowed. In that case, start run 2 with an investigation node. It tests hypotheses in rank order, one change at a time. The fix node depends on it and still uses the reproduction command as `verify`.
- End run 2 with a final audit on `unspecified-low`, dependent on the fix node. It reruns the reproduction and tag search (see Debug logs). Since the run changes code, this audit is `review-spec`, joined by `review-standards` (see Two-axis review). The observable goal is "the reproduction command exits 0 and no debug tag remains".

**Debug logs.** The main conversation selects one tag per bug: `[DEBUG-` plus four hex characters, for example `[DEBUG-a4f2]`.
Put it in every prompt that may add logs and in the final audit.
Prefer a debugger or one targeted log that distinguishes hypotheses. Do not log everything.
Every added log line uses the tag, so one search can check cleanup.

Add the absence check from "Checks for absence or expected failure" to the fix node's `verify`, alongside the reproduction command.
Name every source or test path where instrumentation could have been added.
Exclude workflow metadata, notes and the checker itself; these legitimately contain the tag.
Report the checked paths and result in `## Output`.
The final audit independently reruns both checks. No native `expectExit` field is required.

**Secrets.** Redact every command, output excerpt and hypothesis before putting it in a prompt, Output or notes file.
Replace tokens, keys and credentials with `<REDACTED>`.
Keep credentials in environment variables read by the script.
Never put them in `argv`, because definitions and run records retain it.
If redaction leaves too little evidence to diagnose, say so and ask through the no-loop path above.

### Vertical slices and wide refactors

Keep the existing deliverable split for independent files, sections and reports.
The following rules define feature units and wide refactor structure.

**A feature is cut into vertical slices, never into layers.**
A vertical slice is a small, complete path through all affected layers: schema, API, UI and tests.
It must be demonstrable or verifiable on its own.
One node owns the slice and its tests, with `load_skills: ["dag-workflow:testing"]`.
This applies "Split implementation from its test? No." to features.

Separate `schema`, `api` and `ui` nodes for one feature are wrong horizontal slices.
No layer can be verified alone. Each waits for the previous contract, and tests become a separate node.

- **Size a slice to one node's context.** If it does not fit, reduce behaviors and start with the simplest case. Never split at a layer boundary. The first slice is the smallest complete path; later slices extend it.
- **Verify the path, not the files.** The slice's `verify` runs the command or test for the whole path. File checks per layer prove existence, not operation.
- **Prefactor first, as its own node.** If implementation would be awkward, first reshape the code without changing behavior. Verify that earlier node with existing tests. The slice node `dependsOn` it.
- **A slice is ONE deliverable although it writes files in several layers.** "One node, one deliverable" counts independent files and sections, not layers. A slice may trigger the three-files under-split warning. Name it as a slice in the plan and treat the warning as expected. Slices depend on each other only when one consumes the other's result or edits its files. Disjoint write scopes run in parallel.

**A wide refactor is a chain, not a set of slices.**
It makes one mechanical change across the codebase, such as renaming a column or retyping a shared symbol.
One edit breaks many call sites.
A slice cannot pass alone: it leaves callers broken or must rewrite all callers within one node's context.
The chain is one component in the topology lock, with three node types:

- `expand` adds the new form beside the old form without breaking callers. Its `verify` includes a build or test command and a file check for the new form.
- `migrate` nodes update callers in batches by affected package or directory. Limit each batch to what one node can edit and recheck. First count callers with read-only Bash (`rg -c` per package); do not guess. Each node depends on `expand` and runs the build or tests. The old form keeps those checks passing. Only batches with disjoint write scopes run in parallel. Use `dependsOn` to serialize batches that share files.
- `contract` deletes the old form after all callers migrate. It depends on every `migrate` node. Its `verify` runs the build or tests; remaining callers fail once the old form is gone. For callers outside build coverage, add a scoped absence check with the wrapper below. Select patterns and caller paths that exclude unrelated text.

Example chain for retyping a shared `userId` as `accountId`:

- `expand` - dependsOn: none
- `migrate-api`, `migrate-web`, `migrate-jobs` - each dependsOn: [`expand`]; one package each, disjoint write scopes, so parallel
- `contract` - dependsOn: [`migrate-api`, `migrate-web`, `migrate-jobs`]
- `review-spec` and `review-standards` - each dependsOn: [`expand`, `migrate-api`, `migrate-web`, `migrate-jobs`, `contract`]; the refactor changes code, so the two-axis review applies (see Two-axis review), and `review-spec` reads every batch's Output and reruns the build and tests

**The limit of this plugin.** There is no integration branch: every node writes into the one working tree as it finishes, and per-node worktree isolation is not available. When `migrate` batches cannot stay green alone even with the old form kept, do not launch them as parallel lanes that each promise green. Merge them into fewer nodes (in the limit one `migrate` node) or serialize them with `dependsOn`, and put the green check on the last node of the stage. The order `expand`, `migrate`, `contract` never changes.

**How this meets the existing rules.** "By file domain" still splits independent file sets.
A `migrate` stage adds two conditions: keep the old form, and chain batches that share files.
This does not apply to one feature's layers, which cannot be verified alone.

"Do not split when" still applies:

1. Serialize or merge batches with shared writes.
2. Keep one design judgment in one node.
3. Merge a slice of only a few lines into its neighbor.

Use slices for features. Use deliverable-unit splitting for work with independent pieces.

## Category routing

`category` routes a node to a model.
Start each node at `quick`. Increase the category only as difficulty requires.
Choose specialty categories by the kind of work, never by difficulty.

The main conversation proposes categories in the DAG definition.
A user-authored definition supplies its own proposals.
With Jev enabled, the plugin independently classifies tasks before execution using hooks/engine/jev.ts.
Jev uses TYPESAFE_API_KEY, or the session model if the key is missing or the API fails.
A sufficiently confident choice overrides the proposal. Uncertain or unavailable decisions keep it.

The original definition does not change.
Snapshots show the actual category and decision source in routing, and the started model in model.
Workers use Sonnet or Opus. Haiku is not a worker route.

The difficulty ladder, bottom rung first:

1. **`quick`** (sonnet) - THE DEFAULT. Mechanical, single-file, or pattern-following work. You need a reason to leave it.
2. **`unspecified-low`** (sonnet) - small but not mechanical: a few files, or a judgment call a template cannot make.
3. **`unspecified-high`** (opus) - a standard multi-file feature or fix with real integration surface.

Escalate only after trying to split work into safe parallel `quick` pieces.
Give a one-line reason, such as "touches six files across three packages".
Work that can be split safely does not need escalation.

**One standing exception: the final audit.** A final audit judges the whole result from two or more inputs, and nothing depends on it.
Code-changing runs have two final audits (see Two-axis review).
Never use `quick` for a final audit. Use `unspecified-low`, or higher for reasoning across many files.
This separates judgment from mechanical checks; both categories use Sonnet.
Command-and-output comparisons, such as a per-lane test or build, stay `quick`.

The plugin enforces this rule on both proposed and Jev-routed categories.
A final audit assigned `quick` runs on `unspecified-low`, with decision source `rule`.

Specialty categories:

| Category | Model | Route a node here when |
| --- | --- | --- |
| `visual-engineering` | sonnet | Frontend, UI, styling or animation. |
| `writing` | sonnet | Documents, prose or technical writing. |
| `deep-low` | sonnet | Difficult debugging or cross-module reasoning beyond the ladder, resolved from what the worker reads. |
| `deep-high` | opus | The same work, but evidence cannot resolve the central decision: trade-offs, cross-package contracts or correctness argued from invariants. |
| `ultrabrain` | opus | At most one node per graph: the hard reasoning problem on which everything else depends. |
| `architect` | opus | System design: compare options and propose the design for other nodes to implement. |
| `artistry` | opus | Unconventional problem-solving beyond standard patterns. |

Without a confident Jev override, missing or unrecognized `category` values select Sonnet explicitly.
They do not inherit the session or agent type's model.
Using `deep-*` or Opus for every node is a routing failure: mechanical lanes pay for the most expensive worker.
Use `agent` only when a specific type fits better than `general-purpose`.
For example, use `Explore` for read-only investigation.

## Edges, data and write scopes

- **`dependsOn` carries data.** A node receives the `## Output` of each DIRECT dependency (up to 4,000 characters each) and the path of each dependency's full report. Transitive ancestors are not pasted: when a node needs a grandparent's fact, make the parent's Output carry it or add the direct edge.
- **Add an edge exactly when the node consumes the other node's result.** If B only needs a fact YOU already know, paste the fact into B's prompt and leave the edge out - an unnecessary edge serializes work that could run in parallel.
- **Design every Output for its consumers.** The producer's prompt names what its Output must contain - file paths, values, decisions, counts - in a compact, parseable shape. A downstream node is only as good as the facts it was handed.
- **Disjoint write scopes or serialize.** No two nodes that can run at the same time may edit the same file. If two lanes must touch the same files, chain them with `dependsOn` or merge them into one node. Declare each node's read and write scope inside its prompt, and list the write scope in the node's `writes` field (project-relative paths or folders, never absolute, `..` or `.claude`). The plugin shows overlaps between `writes` of active sessions in the same project; it never blocks or reschedules on them, so disjointness inside one graph is still your job.
- **A commit node declares no `writes`.** It changes no file content, and listing the committed paths makes the under-split lint count them as deliverables: a commit node with `writes` of `hooks/`, `tests/` and `README.md` drew "one producer owns 3 files", whose advice (split into parallel nodes) would race on the git index. Verify it with git commands such as `git diff --quiet HEAD` and `git ls-files --error-unmatch <path>`. Commits share the git index, so never split them into parallel nodes: use one commit node, or a chain with `dependsOn`.
- **Dependency self-check before `start`:** every `dependsOn` id exists; no cycles; no node depends on something it does not consume; every wave has at least one runnable node. The plugin refuses unknown ids, self-edges and cycles with `unknown_dependency`, `invalid_dependency` and `cycle`.

## Composing runs

The main conversation coordinates runs:

- **One run per phase.** If phase 2 depends on phase 1's findings, first let phase 1 settle. Read its summary outputs and full reports when excerpts are insufficient. Then `start` phase 2 under a new key with the needed facts in its prompts.
- **Unknown cause with a reproduction to build.** Diagnose in one run. Fix in another whose `verify` is the reproduction command. See "Debug chain (diagnose run, then fix run)" under "Decomposition doctrine".
- **Data-driven width.** First list actual files or items with Read and read-only Bash. Then define one node per piece instead of guessing the fan-out.
- **Concurrent runs.** Distinct keys run concurrently. Start independent graphs together; each settles independently.
- **Adaptive recovery stays in the same run.** Use `retry` and `amend` for recovery. A new key starts another run; it is never a retry. Reissuing the same definition under the old key returns that run (`reused: true`) and schedules nothing.
- **Completion messages drive the next step.** Call `start` and return. Progress notes and the run-settled message wake the conversation. Plan the next phase on the settled message.
- Quote or summarize only what the next node needs in later prompts. An unbounded paste obscures the instruction.

## Node prompt contract

The worker sees only its prompt, goal and upstream results.
It has no conversation history, access to your reasoning, or way to ask questions.
Write so a competent stranger can follow the prompt exactly.
Include these items in order:

1. **TASK:** One imperative sentence naming the deliverable.
2. **DELIVERABLE:** Concrete artifacts: changed files, exact report format and evidence. Specify what dependents need in `## Output`.
3. **SCOPE:** Exact read and write paths as a hard boundary. Identify out-of-scope work owned by another node.
4. **VERIFY:** The literal command and expected result the node checks before reporting. Mirror it in machine-run `verify` below.
5. **STOP WHEN:** One observable condition that ends the work.

Rules that make node prompts obeyed:

- **Self-contained, always.** Paste exact paths, facts and constraints INTO the prompt. "As discussed above" is a dangling reference - the node sees nothing above.
- **Minimum sufficient context.** Every pasted fact must change what the node does.
- **Binary observables.** PASS/FAIL must be decidable from the prompt alone: "exit code 0 and `dist/index.js` exists", never "check it works".
- **Positive framing.** Tell the node what to do. Reserve NEVER/ONLY for true invariants (do not commit, do not edit outside scope).
- **Emphasis lives in the words.** UPPERCASE and strong verbs for load-bearing rules; no emojis or decoration.
- **One role per node.** A node that investigates does not also fix; a node that writes does not also review its own work.

**The `start` result audits this contract.** `start` returns `warnings` for these cases:

| Case | Warning condition |
| --- | --- |
| Prompt | Missing literal `TASK:` or `STOP WHEN`. |
| Verification | A graph with two or more nodes has no verification node. |
| Final audit | A final audit runs on `quick`. |
| Files | One producer owns three or more files, counting `writes` and file `verify` paths. |
| Sections | The only producer names three or more `## Section` headings in its prompt. |

A verification node depends on other nodes and has verify, validate, check, test, review or audit in its id, label or summary.
A final audit is a verification node with two or more inputs and no dependents.

Warnings do not block execution. Treat them as defects.
Cancel and start the corrected definition under a new key, or `amend` before affected nodes run.
One warning is expected: three files on a node named as a vertical slice in the plan.
The lint cannot distinguish a slice from independent files (see Vertical slices and wide refactors).

## The `verify` contract

Every node in `start` and `amend` requires `verify` with 1-16 checks.
Each check has one of these forms:

- `{"kind": "file", "path": "<project-relative>", "contains": "<nonempty text>"}`; `contains` is optional.
- `{"kind": "command", "argv": [...]}`.

Missing checks return `verification_required`. Malformed checks return `invalid_verification`.
After the worker reports completion, the runtime executes the checks itself.
Commands run from the project root without a shell, with a 30-second limit. Exit 0 passes.
The runtime writes `.claude/dag/runs/<run_id>/<node>.verification.<attempt>.json` before marking the node `completed`.
A failed check or missing evidence fails the node and blocks its dependents.

- Choose checks that fail when the deliverable is wrong. Use the relevant test command, or a file check for a heading or value consumers parse. `true`, `echo ok` and existence checks on existing files prove nothing.
- `start` and `amend` return one `vacuous verify` warning per node. It lists offending checks by their 1-based positions in `verify`. The warning does not prevent execution. Treat it as a defect: `amend` the definition or start a corrected one under a new key.
- Vacuous means: a file check without `contains` (it only proves the file exists; `touch` passes it); a command whose program basename is `true`, `:`, `echo`, `printf`, `exit`, `yes` or `sleep` (always passes; a directory prefix such as `/bin/true` is stripped, arguments are ignored); `test` or `[` that uses only `-e`, `-f`, `-d` or `-s`, or `ls`, `stat` or `cat` (only proves a path exists). `test` with any other operator (`-n`, `-r`, `-z`) or without a dash flag, such as `test a = b`, is not flagged.
- Instead, use a file check with nonempty `contains` text consumed downstream, or a command that fails on a wrong deliverable.
- Lint reads only `argv[0]` and, for `test` and `[`, their dash flags. It does not inspect shell wrappers such as `sh -c '...'`. Do not use a wrapper to hide a vacuous check.
- A passing check proves only its declared condition. The verification wave below checks further semantic correctness.
- Never name node deliverables REPORT*.md, SUMMARY*.md, FINDINGS*.md or ANALYSIS*.md when you choose the name. Claude Code refuses subagent Write calls to those names (2.1.288, re-checked on 2.1.295). Use `<node-id>-notes.md` or return text in `## Output`.
- When the user requires such a name, the producing node puts the full file text in `## Output` (or writes `<node-id>-notes.md`). After the run settles, the main conversation writes the requested file verbatim with Write, then Reads it back. Never ask a node to work around the block with Bash, `mv` or a rename: that circumvents a host guard.
- Because the requested file is written after the run settles, point the node's `verify` at the `<node-id>-notes.md` file and the final audit at that file or the Output, not at the requested file.
- `verify` and `writes` affect the fingerprint. Changing them with `amend` re-runs the node and its dependents.
- Old definitions or checkpoints without `verify` are unverified. Amend them with real checks; do not report their nodes as done.

### Checks for absence or expected failure

The schema has no native expected-exit field.
A `command` check can explicitly invoke a shell or script.
The wrapper must exit 0 only when the expected condition holds.
Command and input errors must fail.

For example, to assert that a debug tag is absent, adapt the tag and paths to the actual instrumentation scope before `start`:

```json
{"kind":"command","argv":["bash","-c","if rg --hidden --no-ignore -n -F -- \"$1\" \"${@:2}\" >/dev/null; then exit 1; else code=$?; test \"$code\" -eq 1; fi","absence-check","DEBUG-a4f2","src","tests"]}
```

`absence-check` is Bash's `$0`, the tag is `$1`, and later arguments name explicit existing source/test paths.
The search includes hidden and ignored files in those paths.

| `rg` result | Check result |
| --- | --- |
| Exit 1: no match | Pass. |
| Exit 0: match | Fail. |
| Any other exit, such as a missing path or missing `rg` | Fail. |

Do not substitute `! rg` or `|| true`; they can accept search errors.
Keep paths narrow enough to exclude generated files, dependencies, notes and the wrapper.
For more involved checks, use a script file.
Keep the script and its inputs through final verification.

For an expected failure, the wrapper must check the recorded exit code and specific symptom before returning 0.
A non-zero exit alone could be a setup failure.
Validate the wrapper with matching, non-matching and missing-input cases.
The independent reviewer still checks that the symptom is the requested bug.

## Verification wave

**Every graph that changes something ends with at least one verification node** that depends on ALL producer nodes and therefore receives all their outputs. The synthesis node's own claim is not evidence.

- The verification node (in a code-changing run: `review-spec`) runs the REAL check - the test command, the build, the endpoint call - and reports the captured output in its `## Output`.
- Each final audit falsifies the whole result against the repository, not the producers' reports, so it runs on `unspecified-low` or higher (see Category routing).
- Each verification node's prompt names the exact invocation and the binary observable that decides PASS vs FAIL, and tells it to report `DAG_NODE_STATUS: failed: <what failed>` when the check fails. The final audit also reports `DAG_NODE_STATUS: failed: partial/supporting-output - <what is missing>` when the safe-but-wrong audit checklist below finds a shortfall.
- **A paginated deliverable (PDF, DOCX, deck, print HTML) is verified by its rendered pages**, every page, not by file size or keyword probes.
- **Node outputs are claims until verified.** A downstream node that builds on an upstream result re-checks the specific facts it depends on (the file exists, the test passes, the symbol is exported) before trusting them.
- After the run settles, the main conversation verifies the goal itself with Read and read-only Bash before reporting success. A run whose audit ended `partial/supporting-output` is reported as partial, naming the missing artifact kind or behavior, never as success.

### Two-axis review (code-changing runs)

Judge code changes on two independent axes: requested behavior and repository rules.
A change can pass one axis and fail the other.
One reviewer judging both can let one result hide the other.
Replace the single verification node with two end nodes: `review-spec` and `review-standards`.

- **When it applies.** At least one producer adds or edits code: source, tests, configuration or build files. Documentation, research and data runs keep one verification node to avoid extra review time. A one-node run (see "One-step tasks are one-node DAGs") stays one node with its VERIFY step.
- **Shape.** Both reviewers depend on all producers, have no dependents and use no aggregator. Do not merge or re-rank the axes. The settled summary already shows outputs side by side. Keep `review` in both ids so the plugin recognizes them. Use `unspecified-low` or higher because they judge the result. The plugin enforces this only with two or more inputs. With one producer, leaving `quick` produces no warning.
- **`review-spec` judges the result against the goal and the request.** Report (a) missing or partial implementation, (b) unrequested behavior (scope creep), and (c) implemented but wrong-looking behavior. Each finding quotes its request sentence and cites evidence as file:line. For (b), quote the nearest sentence it exceeds, or state that no sentence covers it. The spec is the run's `goal` plus request text pasted into the prompt. "See the goal" is not a quote. Rerun the producers' real check from `verify`; record its exit code as evidence for (c). Use `## Request sentences`, `## Findings`, and `## Real check` in the notes file. Under Findings, include groups (a), (b), (c), each `none` when empty. Include the Safe-but-wrong audit checklist below in the prompt.
- **`review-standards` judges the result against the repository's rule files** and the Fowler code-smell baseline. Name known files, such as CONTRIBUTING and CLAUDE.md, in the prompt; the node searches for more. Load the baseline with `load_skills: ["dag-workflow:review-standards"]`, using skill `dag-workflow:review-standards`. `load_skills` is outside the fingerprint; adding it through `amend` re-runs nothing. Quote the rule for every documented breach. Label smells as judgment calls, never hard violations. Repository rules override the baseline. Skip what a linter or compiler already enforces. Use `## Rule sources`, `## Rule breaches`, and `## Judgment calls` in the notes file, each `none` when empty. If no rule files exist, say so and use only the baseline. If the baseline is missing from context, write "baseline unavailable" and judge only documented rules.
- **Verdict lines.** Write each notes file once, in full, with exactly one final verdict line. Use `Spec verdict: PASS` or `Spec verdict: FAIL`, and `Standards verdict: PASS` or `Standards verdict: FAIL`. Spec passes only when (a), (b), (c) are empty, the real check exits 0, and the checklist holds. Standards fails only for documented-rule breaches; judgment calls alone pass. On FAIL, end the node with `DAG_NODE_STATUS: failed: <what failed>`.
- **The verdict is machine-checked.** Each reviewer declares a `verify` file check with `contains` set to its PASS line: `Spec verdict: PASS` or `Standards verdict: PASS`. Add a check for its findings heading: `## Findings` or `## Rule breaches`. Thus a FAIL report fails verification even if the node claims completion. Tell the node to put PASS text only on the final line. Quoting PASS elsewhere in a FAIL report would satisfy the check.
- **Self-contained prompts.** Reviewers cannot spawn sub-agents or ask questions. Before `start`, pin the fixed point: `git rev-parse HEAD` for uncommitted work, or the base commit. Paste it, the goal and the request text verbatim into both prompts. Missing input ends with `DAG_NODE_STATUS: failed: missing-input: <what>`, never a question. Reviewers read their targets and write only their own notes files. Use names such as `<node-id>-notes.md`, never names starting with REPORT, SUMMARY, FINDINGS or ANALYSIS. Each prompt marks the other axis out of scope.
- **Reading and recovery.** Read the reports side by side. Never merge findings or rank across axes; name the worst finding separately for each axis. To clear FAIL, `amend` the faulty producer so both dependent reviewers re-run. Retry only the reviewer after a transient failure; otherwise it would review the same code again.

### Safe-but-wrong audit checklist

A safe, non-destructive and useful run can still deliver the wrong kind of artifact.
It can pass ordinary checks and appear complete without meeting the request.
This creates false confidence and is worse than a visible blocker.

The final audit answers all five questions below.
Support each answer with captured command output or a file excerpt and path, not an assertion.
Use `n/a` with a reason only when the item cannot apply.

1. **Same kind?** Is the produced artifact the same kind as the requested one? State both kinds. A CLI was requested, so documents, checklists or handoff notes alone do not count.
2. **Runnable again?** Can the deliverable be run again with new input? Run it a second time with an input no producer used and quote the result.
3. **Missing data honest?** Is missing data shown as `unchecked`, `insufficient data` or `blocked`, never as `OK`, `0` or an empty value? Feed it a missing input and quote what it prints.
4. **Behavior proven?** Did the verification prove the requested behavior, not just that a file exists? Quote the check that would have failed had the behavior been wrong. An existence check proves nothing, and a `contains` on a heading proves only that the heading exists, not the behavior it describes (see "The `verify` contract").
5. **Status honest?** If any of 1-4 fell short, does the audit report `partial/supporting-output` instead of "complete"?

Include all five items in the final audit prompt.
Here, the final audit is a verification node with no dependents that judges two or more inputs.
Also include them in a smaller artifact-producing run's single verification node.
For code-changing runs, use them in `review-spec`; `review-standards` keeps the rules axis (see Two-axis review).
The `start` audit does not lint for these items, so the planner must check them.
A final audit prompt without them is defective. Append this block:

```text
AUDIT FOR SAFE-BUT-WRONG OUTPUT. Answer every item with evidence (command output or a file excerpt with its path), not assertion; write `n/a` plus the reason only when an item cannot apply.
1. Name the requested kind of artifact and the produced kind; they must match (a CLI request is not met by documents alone).
2. Run the deliverable again with an input no producer used and quote the result.
3. Feed it missing data; missing data must show as `unchecked`, `insufficient data` or `blocked`, never as OK, 0 or an empty value.
4. Quote the check that would have failed had the behavior been wrong; a file that exists or a heading that is present does not prove behavior.
5. On any shortfall in 1-4, write `Status: partial/supporting-output` in ## Output naming the missing artifact kind or behavior, then end with `DAG_NODE_STATUS: failed: partial/supporting-output - <what is missing>`.
Write complete only when 1-4 all pass with evidence.
```

The status line supports only `completed` and `failed`. Any other final line counts as completed.
Use `failed` for `partial`; otherwise the run would appear complete.
List useful but unrequested output as supporting material, never as the final product.
Recover with `amend`, not `retry` (see Failure playbook).

A conservative default for a local, reversible gap is fine; a default that changes what kind of artifact is delivered is not.

## Failure playbook

- **A failed node blocks only its dependents** as `skipped`; independent lanes continue. Read its error and output first. Recover the node in place; never rebuild the graph.
- **Automatic recovery may act first.** With `auto_recovery` on and confident Jev classification, `transient` failures retry on the same model grade. `implementation` failures retry on Opus. There are at most two extra attempts per node; prompt, scope and goal stay the same. Missing input, clarification, permanent or uncertain failures, API errors, cancellations, pending handoffs and nodes without `verify` wait for you. Read `decisions` before overriding recovery.
- **`retry` is the first manual move.** Failed or cancelled nodes get fresh attempts, and their skipped dependents return to the scheduler. Completed nodes keep results. Use `node_ids` to select nodes, or one `node_id` plus `prompt` to edit the retried instruction. Refusals: `run_still_active` (let the wave settle); `node_not_retryable` (completed node: use `amend`; skipped node: include its failed ancestor in the retry set); `nothing_to_retry`; `invalid_request` (one prompt with several nodes). An audit verdict of `partial/supporting-output` means work is missing (see Safe-but-wrong audit checklist). The audit has no dependents, so retry and auto-recovery merely repeat the verdict. Use `amend` to change or add the producer for the requested artifact. The audit and its dependents re-run. Otherwise, ask the user.
- **`amend` when the definition itself was wrong.** Unchanged completed nodes keep results. Changed or added nodes and their transitive dependents re-run. The fingerprint includes prompt, category, agent, dependsOn, verify and writes. It excludes `load_skills`, `label` and summary fields; changing only those re-runs nothing. Refusals: `amend_running_node`, `key_mismatch`.
- **`send` only steers a running node.** A finished node returns `node_not_continuable`; retry it with a prompt.
- **Ownership.** Another session's run returns `not_owner` for cancel, retry, amend and send until you own it. `attach` requires an inactive owner and no pending handoff. A live owner transfers it through user commands `/dag handoff <run> <session>` and `/dag accept <run>`. Only unfinished nodes resume.
- **A quiet pane is not a stall.** Nodes beyond `max_concurrent` wait in `scheduled`. A running node marked `possibly stalled` has emitted no tokens for a while. Check its activity before acting. Elapsed time alone never justifies cancellation.
- **Provider storms.** If many nodes fail within seconds of starting in one wave, the model route is failing, not the prompts. Fix the route, then `retry`.
- **Verify a node's claim before you trust its state.** A node counts as completed when its agent returns, even with a report that says it was blocked. Read the output; `retry` the node when the report shows it never did the work.
- **Cancel is for abandoning the goal**, never for impatience. Supply a reason for the run record.