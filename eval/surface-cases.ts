import type { SurfaceCase } from './surface.ts'

const OPTIONS_BOARD_FIRST =
  'I can do one of these next:\n1. Explain with a diagram how a board edit flows from the tool call to the pane\n2. Change the board page size to 80 lines\nWhich one?'
const OPTIONS_CHAT_FIRST =
  'Two ways to go:\n1. Rename retention_days to keep_days in plugin.json and register.ts\n2. Compare the three retention strategies with their trade-offs\nTell me the number.'

export const SURFACE_CASES: SurfaceCase[] = [
  // structure: the request asks how a flow works across several components or steps, which the board criterion names ("how a system, flow or feature works across components or steps").
  {
    id: 'en-structure-hook-flow',
    group: 'structure',
    request:
      'How does a user prompt flow from the prompt.submit hook through Jev to the injected protocol in hooks/register.ts?',
    expect: 'board',
  },
  {
    id: 'ko-structure-run-engine',
    group: 'structure',
    request: 'hooks/engine/run.ts에서 노드가 pending에서 done으로 넘어가기까지 어떻게 흘러가는지 설명해줘',
    expect: 'board',
  },
  {
    id: 'en-structure-board-pane',
    group: 'structure',
    request: 'Walk me through how the board tool call ends up as a page in the /dag pane, across the tool, the store and the Client surface.',
    expect: 'board',
  },
  {
    id: 'ko-structure-semgrep-scan',
    group: 'structure',
    request: 'Semgrep secure-coding 스캔이 편집을 거절하고 lens 후보를 만드는 과정을 전체 구조로 보여줘',
    expect: 'board',
  },
  {
    id: 'en-structure-review-nodes',
    group: 'structure',
    request: 'Show how review-spec, review-standards and review-security nodes are generated from a definition and how their verdicts feed the final result.',
    expect: 'board',
  },

  // comparison: the request compares options or weighs trade-offs, which matches "a comparison of options ... or a decision with trade-offs".
  {
    id: 'en-comparison-enforcement-modes',
    group: 'comparison',
    request: 'Compare the enforcement modes strict, auto, guide and off: what each one injects, who decides, and the trade-offs.',
    expect: 'board',
  },
  {
    id: 'ko-comparison-retention',
    group: 'comparison',
    request: 'retention_days를 짧게 두는 것과 길게 두는 것, 그리고 run마다 정리하는 방식을 장단점 비교해줘',
    expect: 'board',
  },
  {
    id: 'en-comparison-chat-vs-board',
    group: 'comparison',
    request: 'Should surface judgment run in the prompt.submit hook or in a separate classifier step? Lay out the options and trade-offs before I decide.',
    expect: 'board',
  },
  {
    id: 'ko-comparison-eval-backends',
    group: 'comparison',
    request: 'eval 러너를 http 백엔드로 돌릴지 model 백엔드로 돌릴지 비교해서 정리해줘. 비용, 재현성, 속도 기준으로.',
    expect: 'board',
  },

  // change-summary: the request asks what a change did across files, named by the board criterion ("what a change did across files").
  {
    id: 'en-change-summary-last-commit',
    group: 'change-summary',
    request: 'What did the last commit (the Semgrep scan, trajectory log and review ledger) change across the repo? Summarize per file.',
    expect: 'board',
  },
  {
    id: 'ko-change-summary-diff',
    group: 'change-summary',
    request: '이번 diff가 hooks/engine과 tests 쪽에서 각각 뭘 바꿨는지 파일별로 정리해줘',
    expect: 'board',
  },
  {
    id: 'en-change-summary-routing',
    group: 'change-summary',
    request: 'Review what commit 40f4d62 did to routing across hooks, eval and tests, and how the pieces connect.',
    expect: 'board',
  },

  // research: findings are the deliverable ("research whose findings are the deliverable"); sweeps across the repo fit dag mode.
  {
    id: 'en-research-sync-calls',
    group: 'research',
    request: 'Survey every place in hooks/ that writes to disk synchronously and report the findings with file and line for each.',
    expect: 'board',
    expectMode: 'dag',
  },
  {
    id: 'ko-research-prompt-language',
    group: 'research',
    request: 'skills와 hooks 전체에서 한국어로 된 에이전트 프롬프트가 남아 있는지 조사해서 결과를 정리해줘',
    expect: 'board',
    expectMode: 'dag',
  },
  {
    id: 'en-research-baselines',
    group: 'research',
    request: 'Investigate how the eval baselines have drifted over the last releases and present what you find per scenario.',
    expect: 'board',
    expectMode: 'dag',
  },

  // fact: one value, flag, yes/no or command, which is the "short or linear" chat case.
  {
    id: 'en-fact-min-version',
    group: 'fact',
    request: 'Which Claude Code version does this plugin require?',
    expect: 'chat',
    expectMode: 'direct',
  },
  {
    id: 'ko-fact-retention-default',
    group: 'fact',
    request: 'retention_days 기본값이 며칠이야?',
    expect: 'chat',
    expectMode: 'direct',
  },
  {
    id: 'en-fact-typecheck-command',
    group: 'fact',
    request: 'What is the command to typecheck this repo?',
    expect: 'chat',
    expectMode: 'direct',
  },
  {
    id: 'ko-fact-trajectory-optin',
    group: 'fact',
    request: 'trajectory_log는 기본으로 꺼져 있어?',
    expect: 'chat',
    expectMode: 'direct',
  },
  {
    id: 'en-fact-review-ledger-default',
    group: 'fact',
    request: 'Is review_ledger on by default?',
    expect: 'chat',
    expectMode: 'direct',
  },

  // short-explain: a concept that fits in a few sentences, still "short or linear" so chat.
  {
    id: 'en-short-explain-checkpoint',
    group: 'short-explain',
    request: 'What is a checkpoint in a DAG run, in a sentence or two?',
    expect: 'chat',
    expectMode: 'direct',
  },
  {
    id: 'ko-short-explain-enforcement',
    group: 'short-explain',
    request: 'enforcement auto가 뭔지 간단히 설명해줘',
    expect: 'chat',
    expectMode: 'direct',
  },
  {
    id: 'en-short-explain-lens',
    group: 'short-explain',
    request: 'What does a security lens node do versus its verifier node? Just the gist.',
    expect: 'chat',
    expectMode: 'direct',
  },
  {
    id: 'ko-short-explain-node-status',
    group: 'short-explain',
    request: 'DAG_NODE_STATUS 줄은 왜 필요한 거야?',
    expect: 'chat',
    expectMode: 'direct',
  },

  // change: the request asks to edit, rename, fix, commit or run something, so the result is the change itself ("asks to change files, run something or commit").
  {
    id: 'ko-change-confidence',
    group: 'change',
    request: 'SURFACE_CONFIDENCE를 0.75로 바꿔줘',
    expect: 'chat',
    expectMode: 'direct',
  },
  {
    id: 'en-change-rename-helper',
    group: 'change',
    request: 'Rename the helper viewLines to renderViewLines in hooks/ui/views.ts and update its imports.',
    expect: 'chat',
    expectMode: 'direct',
  },
  {
    id: 'en-change-run-tests',
    group: 'change',
    request: 'Run claude plugin test and tell me if anything fails.',
    expect: 'chat',
    expectMode: 'direct',
  },
  {
    id: 'ko-change-commit',
    group: 'change',
    request: '지금까지 바뀐 것 커밋해줘',
    expect: 'chat',
    expectMode: 'direct',
  },
  {
    id: 'en-change-fix-typo',
    group: 'change',
    request: 'Fix the typo "retreival" in the README and commit it.',
    expect: 'chat',
    expectMode: 'direct',
  },
  {
    id: 'ko-change-default-value',
    group: 'change',
    request: 'plugin.json에서 retention_days 기본값을 14로 수정해줘',
    expect: 'chat',
    expectMode: 'direct',
  },

  // reply: a short reply is read through previousReply; picking an explanation option or approving an explanation means board, picking an edit means chat.
  {
    id: 'en-reply-pick-explain',
    group: 'reply',
    request: '1',
    previousReply: OPTIONS_BOARD_FIRST,
    expect: 'board',
  },
  {
    id: 'en-reply-pick-edit',
    group: 'reply',
    request: '2',
    previousReply: OPTIONS_BOARD_FIRST,
    expect: 'chat',
    expectMode: 'direct',
  },
  {
    id: 'ko-reply-approve-explain',
    group: 'reply',
    request: '네 그렇게 해줘',
    previousReply:
      '원하시면 board 편집이 도구 호출에서 pane까지 어떻게 흘러가는지 다이어그램으로 설명해 드릴까요?',
    expect: 'board',
  },
  {
    id: 'ko-reply-approve-edit',
    group: 'reply',
    request: '네 그렇게 해줘',
    previousReply: 'board 페이지 크기를 80줄로 바꿀까요?',
    expect: 'chat',
    expectMode: 'direct',
  },
  {
    id: 'en-reply-yes-edit',
    group: 'reply',
    request: 'yes',
    previousReply: 'Want me to apply this change to hooks/register.ts and run the tests?',
    expect: 'chat',
    expectMode: 'direct',
  },
  {
    id: 'en-reply-pick-compare',
    group: 'reply',
    request: '2',
    previousReply: OPTIONS_CHAT_FIRST,
    expect: 'board',
  },

  // contested: taste or borderline requests where the criteria do not decide between chat and board.
  {
    id: 'en-contested-why-written',
    group: 'contested',
    request: 'Why is advance() in hooks/engine/run.ts written like this?',
    expect: 'contested',
  },
  {
    id: 'ko-contested-design-opinion',
    group: 'contested',
    request: 'review 노드를 항상 병렬로 두는 설계, 어떻게 생각해?',
    expect: 'contested',
  },
  {
    id: 'en-contested-explain-module',
    group: 'contested',
    request: 'Explain what hooks/engine/jev.ts does.',
    expect: 'contested',
  },
  {
    id: 'ko-contested-read-diff',
    group: 'contested',
    request: '이 함수 좀 봐줘, 이상한 거 있어?',
    expect: 'contested',
  },
]
