import type { NodeState, RunStatus } from '../engine/types.ts'

export type Language = 'en' | 'ko'

export type Strings = {
  nextNode: string
  prevNode: string
  completedToggle: string
  keysHint: string
  tasksSwitch: (count: number) => string
  dagSwitch: (count: number) => string
  failedCount: (count: number) => string
  activeRuns: (count: number) => string
  completedRuns: (count: number) => string
  runSummary: (done: number, total: number, running: number, waiting: number) => string
  startNode: string
  sameFrontier: string
  dependencies: string
  nodeDetails: string
  none: string
  now: string
  more: string
  viewGraph: string
  viewLanes: string
  viewTimeline: string
  viewAuto: string
  timelineEmpty: string
  critical: string
  viewSwitch: string
  handback: string
  backgroundWait: string
  fold: string
  unfold: string
  details: string
  transcript: string
  toastNoTranscript: (nodeId: string) => string
  toastTranscriptDenied: (nodeId: string, reason: string, reportPath?: string) => string
  compact: string
  tasksView: string
  dagView: string
  done: (done: number, total: number) => string
  runOf: (index: number, count: number, runId: string) => string
  empty: string
  noTasks: string
  tasksHeader: (count: number) => string
  notStarted: string
  sessionModel: string
  category: (name: string) => string
  attempt: (n: number) => string
  working: string
  waitingDeps: string
  waitingSlot: string
  state: Record<NodeState | RunStatus, string>
  waitingModel: (elapsed: string) => string
  thinking: (elapsed: string) => string
  responding: (text: string) => string
  writingTool: (tool: string) => string
  runningTool: (tool: string, elapsed: string) => string
  stalled: string
  stallReason: (rule: 'coarse' | 'wait' | 'token', quiet: string, limit: string) => string
  waitingPermission: (tool: string) => string
  // `awaiting` is a run held for start approval: the label stands where the running count would, since nothing runs.
  statusLine: (name: string, done: number, total: number, running: number, failed: number, otherRuns: number, waiting: number, awaiting?: boolean) => string
  toastWaiting: (run: string, node: string) => string
  toastNodeFailed: (run: string, node: string) => string
  toastVerificationFailed: (run: string, node: string) => string
  toastHandoff: string
  toastSettledFailed: (run: string, failed: number) => string
  // The native notification a settled run raises (settle-notice.ts): its result and node counts, nothing to click.
  notifySettledCompleted: (run: string, done: number, total: number) => string
  notifySettledFailed: (run: string, failed: number, done: number, total: number) => string
  notifyRecoveryStopped: (run: string, node: string) => string
  toastPaneWaiting: (reason: string) => string
  toastApproval: (run: string) => string
  toastBoardUpdated: (title: string) => string
  // `reason` is the prompt box's refusal (no_composer, dialog) or unknown.
  toastChipFailed: (reason: string) => string
  approvalWaiting: string
  awaitingApproval: string
  // The one toast a usage hold raises when it first keeps a node from starting; `minutes` until its window resets, when known.
  toastUsageHold: (kind: string, percent: number, minutes?: number) => string
  // The run header's state while the usage hold keeps the run's scheduled nodes from starting.
  usagePaused: (kind: string, percent: number) => string
  previewSummary: (nodes: number, waves: number, widest: number, maxConcurrent: number) => string
  previewWave: (index: number, entries: string) => string
  previewConflicts: (entries: string) => string
  previewUnchecked: (ids: string) => string
  previewLint: (warning: string) => string
  previewLintMany: (count: number, first: string) => string
  previewLintClean: string
  previewRouting: string
  previewBoard: (title: string) => string
  approve: string
  reject: string
  runDeferred: string
  bandOpen: string
  bandRunning: (count: number) => string
  bandWaiting: (count: number) => string
  bandOtherRuns: (count: number) => string
  bandPaneWaiting: (reason: string) => string
  bandAsking: (count: number) => string
  questionAsks: (text: string) => string
  questionDefault: (value: string) => string
  questionNeedsPerson: string
  questionHint: (runId: string, nodeId: string) => string
}

const EN_AWAITING = 'awaiting approval'
const KO_AWAITING = '승인 대기 중'

const EN: Strings = {
  nextNode: 'next',
  prevNode: 'prev',
  completedToggle: 'completed runs',
  keysHint: 'Click the graph for Tab/Shift-Tab select · Space/Enter fold · ←→ runs',
  tasksSwitch: count => `& Tasks(${count})`,
  dagSwitch: count => `t DAG (${count})`,
  failedCount: count => `${count} failed`,
  activeRuns: count => `Active runs (${count})`,
  completedRuns: count => `Completed runs (${count})`,
  runSummary: (done, total, running, waiting) => `${done}/${total} done · ${running} running · ${waiting} waiting`,
  startNode: 'Start node',
  sameFrontier: 'Same frontier',
  dependencies: 'Dependencies',
  nodeDetails: 'Node details',
  none: 'none',
  now: 'now',
  more: '+{n} more',
  viewGraph: 'Graph',
  viewLanes: 'Lanes',
  viewTimeline: 'Timeline',
  viewAuto: 'auto',
  timelineEmpty: 'No node has started yet.',
  critical: 'critical path',
  viewSwitch: 'view',
  handback: 'hand-back',
  backgroundWait: 'waiting on background work',
  fold: 'fold wide layers',
  unfold: 'unfold wide layers',
  details: 'details',
  transcript: 'transcript',
  toastNoTranscript: nodeId => `Node ${nodeId} never started, so it has no transcript`,
  toastTranscriptDenied: (nodeId, reason, reportPath) => `Node ${nodeId} transcript not shown: ${reason}${reportPath ? ` · report: ${reportPath}` : ''}`,
  compact: 'compact',
  tasksView: 'tasks',
  dagView: 'dag',
  done: (done, total) => `${done}/${total} done`,
  runOf: (index, count, runId) => `run ${index}/${count} · ${runId}`,
  empty: 'No DAG runs yet. Start one with /dag run <file.json>, or ask Claude to use the dag tool.',
  noTasks: 'No other subagents in this session.',
  tasksHeader: count => `Tasks (${count})`,
  notStarted: 'not started',
  sessionModel: 'session model',
  category: name => `category ${name}`,
  attempt: n => `attempt ${n}`,
  working: 'working…',
  waitingDeps: 'waiting for dependencies',
  waitingSlot: 'waiting for a free slot',
  state: {
    pending: 'pending',
    blocked: 'blocked',
    scheduled: 'scheduled',
    running: 'running',
    paused: 'paused',
    completed: 'completed',
    failed: 'failed',
    cancelled: 'cancelled',
    skipped: 'skipped',
  },
  waitingModel: elapsed => `… waiting for model ${elapsed}`,
  thinking: elapsed => `✻ thinking ${elapsed}`,
  responding: text => `✎ now · …${text}`,
  writingTool: tool => `⚙ ${tool} now`,
  runningTool: (tool, elapsed) => `▶ ${tool} running ${elapsed}`,
  stalled: '⚠ possibly stalled',
  stallReason: (rule, quiet, limit) =>
    rule === 'token' ? `no new output for ${quiet} (limit ${limit})`
      : rule === 'wait' ? `no first token for ${quiet} (limit ${limit})`
        : `transcript unchanged for ${quiet} (limit ${limit})`,
  waitingPermission: tool => `waiting: ${tool}`,
  statusLine: (name, done, total, running, failed, otherRuns, waiting, awaiting = false) => `DAG ${name}: ${done}/${total} done · ${awaiting ? EN_AWAITING : `${running} running`}${waiting ? ` · ${waiting} waiting for permission` : ''}${failed ? ` · ${failed} failed` : ''}${otherRuns ? ` · +${otherRuns} runs` : ''}`,
  toastWaiting: (run, node) => `DAG ${run} › ${node} is waiting for your permission`,
  toastNodeFailed: (run, node) => `DAG ${run}: node ${node} failed`,
  toastVerificationFailed: (run, node) => `DAG ${run}: node ${node} failed verification`,
  toastHandoff: 'A DAG run was offered to this session. Open /dag sessions to accept it.',
  toastSettledFailed: (run, failed) => `DAG ${run} settled with ${failed} failed node(s)`,
  notifySettledCompleted: (run, done, total) => `DAG ${run} completed ${done}/${total}`,
  notifySettledFailed: (run, failed, done, total) => `DAG ${run} failed: ${failed} failed node(s), ${done}/${total} completed`,
  notifyRecoveryStopped: (run, node) => `${run} › ${node}: automatic recovery stopped, the node still fails`,
  runDeferred: 'The run starts when the current turn ends.',
  toastApproval: run => `DAG ${run} waits for your approval · approve it in the /dag pane or with /dag approve`,
  toastBoardUpdated: title => `Board updated: ${title} · press b in the /dag pane`,
  toastChipFailed: reason => `Could not put the block into the prompt (${reason})`,
  approvalWaiting: 'Waiting for your approval: no node starts until you approve this run.',
  awaitingApproval: EN_AWAITING,
  toastUsageHold: (kind, percent, minutes) => `DAG paused new nodes: ${kind} at ${percent}%${minutes === undefined ? '' : `, resets in ${minutes} min`}`,
  usagePaused: (kind, percent) => `paused at usage limit: ${kind} ${percent}%`,
  previewSummary: (nodes, waves, widest, maxConcurrent) => `${nodes} node${nodes === 1 ? '' : 's'}, ${waves} wave${waves === 1 ? '' : 's'}, widest wave ${widest} (max concurrent ${maxConcurrent})`,
  previewWave: (index, entries) => `wave ${index}: ${entries}`,
  previewConflicts: entries => `write conflicts: ${entries}`,
  previewUnchecked: ids => `write scope unchecked (no writes declared): ${ids}`,
  previewLint: warning => `lint: ${warning}`,
  previewLintMany: (count, first) => `${count} lint warnings, first: ${first}`,
  previewLintClean: 'lint: no warnings',
  previewRouting: 'category and model are proposals; Jev may reroute a node at start.',
  previewBoard: title => `Plan board: ${title} · press b to view`,
  approve: 'approve',
  reject: 'reject',
  toastPaneWaiting: reason => `DAG pane not shown · type 0 at an empty prompt or run /dag to open it (${reason})`,
  bandOpen: 'DAG pane',
  bandRunning: count => `${count} running`,
  bandWaiting: count => `${count} waiting for permission`,
  bandOtherRuns: count => `+${count} runs`,
  bandPaneWaiting: reason => `pane not shown: ${reason}`,
  bandAsking: count => `${count} waiting for an answer`,
  questionAsks: text => `asks: ${text}`,
  questionDefault: value => `default: ${value}`,
  questionNeedsPerson: 'only you can answer this',
  questionHint: (runId, nodeId) => `answer with /dag answer ${runId} ${nodeId} <text>`,
}

const KO: Strings = {
  nextNode: '다음',
  prevNode: '이전',
  completedToggle: '끝난 실행',
  keysHint: '그래프를 클릭하면 Tab/Shift-Tab 선택 · Space/Enter 접기 · ←→ 실행 전환',
  tasksSwitch: count => `& 작업(${count})`,
  dagSwitch: count => `t DAG (${count})`,
  failedCount: count => `실패 ${count}`,
  activeRuns: count => `진행 중인 실행 (${count})`,
  completedRuns: count => `끝난 실행 (${count})`,
  runSummary: (done, total, running, waiting) => `${done}/${total} 완료 · 실행 중 ${running} · 대기 ${waiting}`,
  startNode: '시작 노드',
  sameFrontier: '같은 층',
  dependencies: '의존 관계',
  nodeDetails: '노드 상세',
  none: '없음',
  now: '방금',
  more: '+{n}개 더',
  viewGraph: '그래프',
  viewLanes: '레인',
  viewTimeline: '타임라인',
  viewAuto: '자동',
  timelineEmpty: '아직 시작한 노드가 없습니다.',
  critical: '임계 경로',
  viewSwitch: '보기',
  handback: '결과 보고',
  backgroundWait: '백그라운드 작업 대기',
  fold: '넓은 층 접기',
  unfold: '넓은 층 펼치기',
  details: '상세',
  transcript: '대화 기록',
  toastNoTranscript: nodeId => `노드 ${nodeId}은(는) 아직 시작하지 않아 대화 기록이 없습니다`,
  toastTranscriptDenied: (nodeId, reason, reportPath) => `노드 ${nodeId}의 대화 기록을 표시하지 못했습니다: ${reason}${reportPath ? ` · 보고서: ${reportPath}` : ''}`,
  compact: '간단히',
  tasksView: '작업',
  dagView: 'DAG',
  done: (done, total) => `${done}/${total} 완료`,
  runOf: (index, count, runId) => `실행 ${index}/${count} · ${runId}`,
  empty: '아직 DAG 실행이 없습니다. /dag run <file.json>으로 시작하거나 Claude에게 dag 도구를 쓰라고 요청하세요.',
  noTasks: '이 세션에는 다른 서브에이전트가 없습니다.',
  tasksHeader: count => `작업 (${count})`,
  notStarted: '시작 전',
  sessionModel: '세션 모델',
  category: name => `카테고리 ${name}`,
  attempt: n => `시도 ${n}`,
  working: '작업 중…',
  waitingDeps: '의존 노드 대기 중',
  waitingSlot: '빈 실행 슬롯 대기 중',
  state: {
    pending: '대기',
    blocked: '차단',
    scheduled: '예약',
    running: '실행 중',
    paused: '일시정지',
    completed: '완료',
    failed: '실패',
    cancelled: '취소',
    skipped: '건너뜀',
  },
  waitingModel: elapsed => `… 모델 응답 대기 ${elapsed}`,
  thinking: elapsed => `✻ 생각 중 ${elapsed}`,
  responding: text => `✎ 응답 중 · …${text}`,
  writingTool: tool => `⚙ ${tool} 인자 작성 중`,
  runningTool: (tool, elapsed) => `▶ ${tool} 실행 중 ${elapsed}`,
  stalled: '⚠ 멈췄을 수 있음',
  stallReason: (rule, quiet, limit) =>
    rule === 'token' ? `${quiet} 동안 새 출력 없음 (한도 ${limit})`
      : rule === 'wait' ? `${quiet} 동안 첫 토큰 없음 (한도 ${limit})`
        : `${quiet} 동안 대화 기록 변화 없음 (한도 ${limit})`,
  waitingPermission: tool => `승인 대기: ${tool}`,
  statusLine: (name, done, total, running, failed, otherRuns, waiting, awaiting = false) => `DAG ${name}: ${done}/${total} 완료 · ${awaiting ? KO_AWAITING : `실행 중 ${running}`}${waiting ? ` · 권한 승인 대기 ${waiting}` : ''}${failed ? ` · 실패 ${failed}` : ''}${otherRuns ? ` · +${otherRuns}개 실행` : ''}`,
  toastWaiting: (run, node) => `DAG ${run} › ${node} 노드가 권한 승인을 기다립니다`,
  toastNodeFailed: (run, node) => `DAG ${run}: 노드 ${node} 실패`,
  toastVerificationFailed: (run, node) => `DAG ${run}: 노드 ${node} 검증 실패`,
  toastHandoff: '이 세션에 DAG 실행이 넘어왔습니다. /dag sessions에서 수락하세요.',
  toastSettledFailed: (run, failed) => `DAG ${run} 종료: 실패 노드 ${failed}개`,
  notifySettledCompleted: (run, done, total) => `DAG ${run} 완료 ${done}/${total}`,
  notifySettledFailed: (run, failed, done, total) => `DAG ${run} 실패: 실패 노드 ${failed}개, ${done}/${total} 완료`,
  notifyRecoveryStopped: (run, node) => `${run} › ${node}: 자동 복구를 멈췄습니다, 노드가 여전히 실패 상태입니다`,
  runDeferred: '현재 턴이 끝나면 실행이 시작됩니다.',
  toastApproval: run => `DAG ${run} 실행이 승인을 기다립니다 · /dag 패널이나 /dag approve로 승인하세요`,
  toastBoardUpdated: title => `보드 갱신: ${title} · /dag 패널에서 b`,
  toastChipFailed: reason => `블록을 프롬프트에 넣지 못했습니다 (${reason})`,
  approvalWaiting: '승인 대기 중: 이 실행을 승인하기 전에는 어떤 노드도 시작하지 않습니다.',
  awaitingApproval: KO_AWAITING,
  toastUsageHold: (kind, percent, minutes) => `DAG 새 노드 시작 대기: ${kind} ${percent}% 사용${minutes === undefined ? '' : `, ${minutes}분 뒤 초기화`}`,
  usagePaused: (kind, percent) => `한도 대기: ${kind} ${percent}%`,
  previewSummary: (nodes, waves, widest, maxConcurrent) => `노드 ${nodes}개, 웨이브 ${waves}개, 가장 넓은 웨이브 ${widest} (동시 실행 한도 ${maxConcurrent})`,
  previewWave: (index, entries) => `웨이브 ${index}: ${entries}`,
  previewConflicts: entries => `쓰기 충돌: ${entries}`,
  previewUnchecked: ids => `쓰기 범위 미확인(writes 미선언): ${ids}`,
  previewLint: warning => `lint 경고: ${warning}`,
  previewLintMany: (count, first) => `lint 경고 ${count}건, 첫째: ${first}`,
  previewLintClean: 'lint 경고 없음',
  previewRouting: '카테고리와 모델은 제안값이며 시작할 때 Jev가 노드를 재배정할 수 있습니다.',
  previewBoard: title => `계획 보드: ${title} · b로 보기`,
  approve: '승인',
  reject: '거절',
  toastPaneWaiting: reason => `DAG 패널 미표시 · 빈 프롬프트에서 0을 입력하거나 /dag로 여세요 (${reason})`,
  bandOpen: 'DAG 패널',
  bandRunning: count => `실행 중 ${count}`,
  bandWaiting: count => `권한 승인 대기 ${count}`,
  bandOtherRuns: count => `+${count}개 실행`,
  bandPaneWaiting: reason => `패널 미표시: ${reason}`,
  bandAsking: count => `답변 대기 ${count}`,
  questionAsks: text => `질문: ${text}`,
  questionDefault: value => `기본값: ${value}`,
  questionNeedsPerson: '직접 답해야 하는 질문입니다',
  questionHint: (runId, nodeId) => `/dag answer ${runId} ${nodeId} <답변> 으로 답하세요`,
}

export function stringsFor(language: unknown): Strings {
  return language === 'ko' ? KO : EN
}

export const DEFAULT_STRINGS = EN
