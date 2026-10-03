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
  fold: string
  unfold: string
  details: string
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
  waitingPermission: (tool: string) => string
  statusLine: (name: string, done: number, total: number, running: number, failed: number, otherRuns: number, waiting: number) => string
  toastWaiting: (run: string, node: string) => string
  toastNodeFailed: (run: string, node: string) => string
  toastVerificationFailed: (run: string, node: string) => string
  toastHandoff: string
  toastSettledFailed: (run: string, failed: number) => string
  toastPaneWaiting: (reason: string) => string
  bandOpen: string
  bandRunning: (count: number) => string
  bandWaiting: (count: number) => string
  bandOtherRuns: (count: number) => string
  bandPaneWaiting: (reason: string) => string
}

const EN: Strings = {
  nextNode: 'next',
  prevNode: 'prev',
  completedToggle: 'completed runs',
  keysHint: 'Click the graph for Tab/Shift-Tab select · Space/Enter fold · ←→ runs',
  tasksSwitch: count => `t Tasks (${count})`,
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
  fold: 'fold wide layers',
  unfold: 'unfold wide layers',
  details: 'details',
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
  waitingPermission: tool => `waiting: ${tool}`,
  statusLine: (name, done, total, running, failed, otherRuns, waiting) => `DAG ${name}: ${done}/${total} done · ${running} running${waiting ? ` · ${waiting} waiting for permission` : ''}${failed ? ` · ${failed} failed` : ''}${otherRuns ? ` · +${otherRuns} runs` : ''}`,
  toastWaiting: (run, node) => `DAG ${run} › ${node} is waiting for your permission`,
  toastNodeFailed: (run, node) => `DAG ${run}: node ${node} failed`,
  toastVerificationFailed: (run, node) => `DAG ${run}: node ${node} failed verification`,
  toastHandoff: 'A DAG run was offered to this session. Open /dag sessions to accept it.',
  toastSettledFailed: (run, failed) => `DAG ${run} settled with ${failed} failed node(s)`,
  toastPaneWaiting: reason => `DAG pane not shown · type 0 at an empty prompt or run /dag to open it (${reason})`,
  bandOpen: 'DAG pane',
  bandRunning: count => `${count} running`,
  bandWaiting: count => `${count} waiting for permission`,
  bandOtherRuns: count => `+${count} runs`,
  bandPaneWaiting: reason => `pane not shown: ${reason}`,
}

const KO: Strings = {
  nextNode: '다음',
  prevNode: '이전',
  completedToggle: '끝난 실행',
  keysHint: '그래프를 클릭하면 Tab/Shift-Tab 선택 · Space/Enter 접기 · ←→ 실행 전환',
  tasksSwitch: count => `t 작업 (${count})`,
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
  fold: '넓은 층 접기',
  unfold: '넓은 층 펼치기',
  details: '상세',
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
  waitingPermission: tool => `승인 대기: ${tool}`,
  statusLine: (name, done, total, running, failed, otherRuns, waiting) => `DAG ${name}: ${done}/${total} 완료 · 실행 중 ${running}${waiting ? ` · 권한 승인 대기 ${waiting}` : ''}${failed ? ` · 실패 ${failed}` : ''}${otherRuns ? ` · +${otherRuns}개 실행` : ''}`,
  toastWaiting: (run, node) => `DAG ${run} › ${node} 노드가 권한 승인을 기다립니다`,
  toastNodeFailed: (run, node) => `DAG ${run}: 노드 ${node} 실패`,
  toastVerificationFailed: (run, node) => `DAG ${run}: 노드 ${node} 검증 실패`,
  toastHandoff: '이 세션에 DAG 실행이 넘어왔습니다. /dag sessions에서 수락하세요.',
  toastSettledFailed: (run, failed) => `DAG ${run} 종료: 실패 노드 ${failed}개`,
  toastPaneWaiting: reason => `DAG 패널 미표시 · 빈 프롬프트에서 0을 입력하거나 /dag로 여세요 (${reason})`,
  bandOpen: 'DAG 패널',
  bandRunning: count => `실행 중 ${count}`,
  bandWaiting: count => `권한 승인 대기 ${count}`,
  bandOtherRuns: count => `+${count}개 실행`,
  bandPaneWaiting: reason => `패널 미표시: ${reason}`,
}

export function stringsFor(language: unknown): Strings {
  return language === 'ko' ? KO : EN
}

export const DEFAULT_STRINGS = EN
