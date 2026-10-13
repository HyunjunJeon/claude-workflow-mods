# agent: Agent trust-boundary security

Edition: project guide, 2026-10-13. Adapted from iron-laws' agent-surface and evidence principles to DAG workers, learned skills and host tool permissions. These are this plugin's review criteria, not a claim of compliance with an external standard.

Source: https://github.com/JinHo-von-Choi/iron-laws

Cite a row as `agent AIA-01` through `agent AIA-07`. Each row uses an existing security lens; the ordinary candidate-verifier process still decides whether a breach is real.

## Criteria

| id | Boundary | Lens | Breach when |
| --- | --- | --- | --- |
| AIA-01 | Data entering an agent prompt | `injection` | Repository content, fetched documents, tool results, upstream reports or existing learned-skill text are promoted to task instructions or authority without a boundary identifying their origin and treating them as data. Trace the assembled prompt and its instruction hierarchy; a delimiter or a warning alone does not prove resistance to injection. |
| AIA-02 | Model output entering tools | `injection` | Model-produced text reaches a shell, interpreter, dynamic code or executable configuration without a typed contract and the normal tool permission decision. JSON parsing alone does not authorize execution. Fixed argv is preferable to shell strings, but its program and arguments still need the intended scope. |
| AIA-03 | Model-controlled resources | `resources` | Model-produced paths, URLs, report destinations or skill identifiers reach I/O without normalization and confinement to the allowed scope. Trace traversal, absolute paths, symlinks and redirect destinations when the host contract permits them; do not assume an undocumented host guarantee. |
| AIA-04 | Authority and external actions | `access` | A model verdict, dependency report or learned skill can grant a permission, bypass a denied tool, broaden write scope or trigger an external action not authorized by the user task. Learning and successful verification never grant authority. Preserve the host's existing permission decision on uncertain model judgments. |
| AIA-05 | Experience becoming reusable skills | `integrity` | Persisted learning can change ownership or project/global scope, cite absent evidence, learn an unverified fix as a proven solution, or turn instructions from an untrusted event into permission or workflow overrides. Event IDs establish provenance, not correctness or authority; inspect the proposal parser, extraction prompt and later skill loading together. |
| AIA-06 | Secrets and completion evidence | `errors` | Prompt transmission, learned skills, reports or verification output expose secrets to a recipient outside their allowed scope, or incomplete, truncated or unavailable evidence is accepted as a successful check. Review the actual data path and decisive checks, not a worker's success claim. |
| AIA-07 | Agent-controlled work volume | `memory` | Model-controlled graph expansion, candidate lists, prompt/output sizes or learning batches have no bounds before spawning, allocating or persisting. Identify the concrete costly operation and its missing bound rather than demanding limits for every internal value. |

## Applying the guide

For this plugin, prioritize `buildNodePrompt`, dependency output assembly, `buildLearningPrompt` / `parseLearningProposals`, tool permission evaluation and verification evidence. In another project, use its corresponding boundaries instead of requiring these function names.

Invisible Unicode, encoded text or a suspicious phrase alone is a judgment call. A confirmed finding needs an applicable boundary, a changed line and a missing control on the reachable path. Do not strip legitimate multilingual text or reject an entire document merely because it contains a sample attack.

This guide is opt-in through `review.security: [agent]` or an implementation prompt naming `agent` and loading `dag-workflow:secure-coding`. It adds no scanner dependency and no automatic approval or arbitrary-text blocking mechanism.
