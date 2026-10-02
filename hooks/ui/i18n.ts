import type { NodeState, RunStatus } from '../engine/types.ts'

export type Language = 'en' | 'ko'

export type Strings = {
  prevRun: string
  nextRun: string
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
}

const EN: Strings = {
  prevRun: 'prev run',
  nextRun: 'next run',
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
  waitingModel: elapsed => `⏳ waiting for model ${elapsed}`,
  thinking: elapsed => `💭 thinking ${elapsed}`,
  responding: text => `✎ now · …${text}`,
  writingTool: tool => `⚙ ${tool} now`,
  runningTool: (tool, elapsed) => `▶ ${tool} running ${elapsed}`,
  stalled: '⚠ possibly stalled',
}

const KO: Strings = {
  prevRun: '이전 실행',
  nextRun: '다음 실행',
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
  waitingModel: elapsed => `⏳ 모델 응답 대기 ${elapsed}`,
  thinking: elapsed => `💭 생각 중 ${elapsed}`,
  responding: text => `✎ 응답 중 · …${text}`,
  writingTool: tool => `⚙ ${tool} 인자 작성 중`,
  runningTool: (tool, elapsed) => `▶ ${tool} 실행 중 ${elapsed}`,
  stalled: '⚠ 멈췄을 수 있음',
}

export function stringsFor(language: unknown): Strings {
  return language === 'ko' ? KO : EN
}

export const DEFAULT_STRINGS = EN
