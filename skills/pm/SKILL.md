---
name: pm
description: User-invoked only; interviews the user as product owner, sorts every question into product decision, technical decision or unknown, and has a one-node DAG write the PRD.
disable-model-invocation: true
argument-hint: "[product idea]"
---

# pm

The user starts this skill with `/dag-workflow:pm [idea]`.
The model never invokes it on its own.
The user is the product owner, so the questions ask what and why, never how.

This skill runs under strict enforcement.
The main conversation may use AskUserQuestion, Read, LSP, read-only Bash and the dag tool.
It may NEVER use Agent, Write, Edit or mutating Bash.
If a fact about the existing product or code matters, find it by reading.
Do not ask the user for facts you can read.
If no idea was given, ask for it in the first round.

Run the rounds the way `/dag-workflow:interview` does:

- Number every question.
- Give each question a recommended answer as its first option.
- Ask at most 4 questions per AskUserQuestion call.

## Question classes

Classify every question BEFORE asking it.
Give each question exactly one of three classes:

| Class | Covers | Action |
| --- | --- | --- |
| Product decision | Who the users are, the problem, scope, priorities, success measures, user-visible behaviour. | Ask the user. |
| Technical decision | Stack, architecture, libraries, data model, implementation approach. | Do not ask the product owner. Defer it to the development phase. |
| Unknown | The user does not know, it depends on someone else, or it cannot be decided now. | Record it as an open item. |

Keep three running lists while you interview.
They hold the decided product decisions, the deferred technical decisions and the open items.
Record each deferred technical decision under "Deferred to development".

Offer a "Decide later" option on every product question.
Treat that choice as an unknown and add it to the open items.
Never present an unknown as a confirmed requirement.

## Confirm before writing

When no product question is left, show these three lists:

- Decided product decisions.
- Deferred technical decisions.
- Open items.

Add a one-sentence product goal.
Confirm the lists and the goal with one AskUserQuestion.
If the user corrects an item, update the lists and confirm again.
Write nothing before the user confirms.

## Writing the PRD

The main conversation cannot write files, so a one-node DAG writes the PRD.
Load the `dag-workflow:planning` skill first, because `start` is refused until you do.
Follow its planning step.
Then start a definition with a one-sentence goal and ONE node:

- `id`: `write-prd`.
- `category`: `writing`.
- `writes`: `docs/prd/<slug>.md`. Prefer a short kebab-case slug from the product name.
- `prompt`: self-contained, in the node prompt contract of the planning skill. Paste every confirmed answer into it.
- `verify`: two file checks on that path, one containing `## Open items` and one containing `## Goals`.

If the user wants another path, ask for it before `start` and use it in `writes` and `verify`.

Tell the node to write these second-level sections, in this order:

1. Problem.
2. Users.
3. Goals.
4. Scope, with what is in and what is out.
5. Requirements.
6. Success criteria.
7. Deferred to development.
8. Open items.

Tell the node to list each open item only under `## Open items`, never under Requirements.
Tell the node to write `## Open items` even when it holds only "None", so the check is meaningful.

Do not write the PRD yourself.
Do not try to spawn an agent.
When the run settles, Read the PRD file.
Show the user its path and its open items.
If the run failed, recover it with the rules of the planning skill.
Suggest `/dag-workflow:interview` or normal planning as the next step.

Doctrine adapted from the pm skill of Q00/ouroboros (MIT): the three question classes and the open-items list. No MCP tooling is used.
