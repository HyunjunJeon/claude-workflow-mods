import { clean, fit, width } from '../hooks/ui/text.ts'

// The statusLine command's stdin as Claude Code 2.1.296 sends it, reduced to what the HUD draws. Every field is
// optional: the engine leaves out what it lacks (rate_limits and prompt_cache before the first response, pr off a
// branch with no open PR) and nulls the context percentages until a response of the live window reports them.
export type HudInput = {
  model?: { id?: string; display_name?: string }
  effort?: { level?: string }
  fast_mode?: boolean
  output_style?: { name?: string }
  agent?: { name?: string }
  workspace?: { current_dir?: string; project_dir?: string; git_worktree?: string; repo?: { name?: string } }
  worktree?: { name?: string; branch?: string }
  pr?: { number?: number; review_state?: string; kind?: string }
  context_window?: { total_input_tokens?: number; context_window_size?: number; used_percentage?: number | null }
  rate_limits?: Record<string, RateWindow | undefined>
  prompt_cache?: PromptCache
}

type RateWindow = { used_percentage?: number; resets_at?: number; used_usd?: number; limit_usd?: number }

type PromptCache = {
  warm?: boolean
  caching_observed?: boolean
  ttl?: string
  expires_at?: number | null
  requests?: number
  last_miss_at?: number | null
  last_miss_cause?: { causes?: string[]; tools_added?: number; tools_removed?: number; system_char_delta?: number } | null
}

export type GitState = { branch: string; ahead: number; behind: number }

// What the HUD keeps between runs about the newest miss: when it happened and the session's request count when the
// HUD first saw it. The request after a miss reads the cache that miss rebuilt, so the miss is news only until then.
export type MissSeen = { at: number; requests: number }

export type HudOptions = {
  // Milliseconds since the epoch; countdowns to resets_at and expires_at count from it.
  now: number
  // The terminal width (Claude Code passes COLUMNS); without it no item is dropped.
  columns?: number
  color?: boolean
  git?: GitState
  // From seeMiss on the previous run; without it the miss counts as first seen now.
  missSeen?: MissSeen
}

// `alert` draws white on red: the warning row, which exists only while something needs the user now.
type Part = { text: string; color?: string; bold?: true; dim?: true; alert?: true }
type Row = Part[]
// One item of a row. Rows drop their highest rank first when they do not fit. A `glued` item sits beside the one
// before it with a space instead of a separator, and must outrank it so it never outlives it.
type Item = { rank: number; row: Row; glued?: true }

// Claude Code draws the status line two cells in from the left edge.
const INDENT = 2
const SEPARATOR: Part = { text: ' │ ', dim: true }
const BAR_CELLS = 10
const SGR: Record<string, string> = { red: '31', green: '32', yellow: '33', blue: '34', magenta: '35', cyan: '36', gray: '90' }
const ALERT_SGR = '1;97;41'

// Context fill past which answers lose quality: yellow from CONTEXT_YELLOW, red above CONTEXT_RED, and the warning
// row from CONTEXT_WARN (the user's thresholds).
const CONTEXT_YELLOW = 50
const CONTEXT_RED = 65
const CONTEXT_WARN = 80
// Rate-limit windows stay hidden below this; most of the time they say nothing worth a glance.
const LIMIT_SHOWN = 70
// A miss shows until the session's next request, and never longer than this after it happened.
const MISS_SHOWN_SECONDS = 600
// Minutes left on the cache before it turns yellow, then red with a warning, per TTL.
const CACHE_LEFT: Record<string, { yellow: number; red: number }> = { '5m': { yellow: 2, red: 1 }, '1h': { yellow: 10, red: 3 } }

// Rate-limit windows in the order the row shows them; a window the engine adds later follows these.
const WINDOWS = ['five_hour', 'seven_day', 'spend_limit']
const WINDOW_LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const REVIEW_COLORS: Record<string, string> = { approved: 'green', changes_requested: 'red', pending: 'yellow', draft: 'gray' }
// Claude Code 2.1.296's closed set of miss causes (PROMPT_CACHE_MISS_CAUSES); a name added later shows as sent.
const MISS_CAUSES: Record<string, string> = {
  system_prompt_changed: '시스템 프롬프트 바뀜',
  tools_changed: '도구 목록 바뀜',
  model_changed: '모델 바뀜',
  fast_mode_changed: 'fast 모드 전환',
  cache_scope_or_ttl_changed: '캐시 범위·TTL 바뀜',
  betas_changed: '베타 헤더 바뀜',
  effort_changed: 'effort 바뀜',
  thinking_mode_changed: 'thinking 전환',
  thinking_display_changed: 'thinking 표시 바뀜',
  auto_mode_changed: 'auto 모드 전환',
  overage_changed: '사용 한도 상태 바뀜',
  extra_body_changed: '요청 필드 바뀜',
  defer_loading_changed: '지연 도구 로딩 바뀜',
  messages_rewritten: '이전 메시지 바뀜',
  ttl_expired_5m: '5분 넘게 쉬어 만료',
  ttl_expired_1h: '1시간 넘게 쉬어 만료',
  likely_server_side: '서버 쪽 원인 추정',
  unknown: '원인 모름',
}

export function renderHud(input: HudInput, options: HudOptions): string[] {
  const rows = [identityRow(input, options), usageRow(input, options), warningRow(input, options)]
  const room = options.columns === undefined ? Infinity : options.columns - INDENT
  return rows
    .map(items => layout(items, room))
    .filter(row => row.length > 0)
    .map(row => paint(row, options.color ?? false))
}

// The memory to keep for the next run: unchanged while the newest miss is the one already seen, else this miss
// with the request count it came with.
export function seeMiss(cache: HudInput['prompt_cache'], seen: MissSeen | undefined): MissSeen | undefined {
  const at = cache?.last_miss_at
  if (typeof at !== 'number') return undefined
  return seen?.at === at ? seen : { at, requests: cache?.requests ?? 0 }
}

// Parses `git status --porcelain=2 --branch`. Undefined when the text has no branch header (not a repository).
export function parseGitStatus(text: string): GitState | undefined {
  let head: string | undefined
  let oid = ''
  let ahead = 0
  let behind = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.head ')) head = line.slice('# branch.head '.length).trim()
    else if (line.startsWith('# branch.oid ')) oid = line.slice('# branch.oid '.length).trim()
    else if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+) -(\d+)/.exec(line)
      ahead = Number(match?.[1] ?? 0)
      behind = Number(match?.[2] ?? 0)
    }
  }
  if (head === undefined) return undefined
  const branch = head === '(detached)' ? `@${oid.slice(0, 7)}` : head
  return { branch, ahead, behind }
}

function identityRow(input: HudInput, options: HudOptions): Item[] {
  const items: Item[] = []
  const model = text(input.model?.display_name) ?? text(input.model?.id)
  if (model) {
    const row: Row = [{ text: model, color: 'cyan', bold: true }]
    const effort = text(input.effort?.level)
    if (effort) row.push({ text: ` ${effort}`, dim: true })
    if (input.fast_mode) row.push({ text: ' fast', color: 'yellow' })
    items.push({ rank: 0, row })
  }
  const place = placeOf(input.workspace)
  if (place) items.push({ rank: 1, row: place })
  const branch = branchOf(input, options.git)
  if (branch) items.push({ rank: 2, row: branch })
  const pr = input.pr
  if (pr?.number !== undefined) {
    const row: Row = [{ text: pr.kind === 'mr' ? `MR !${pr.number}` : `PR #${pr.number}` }]
    const state = text(pr.review_state)
    if (state) row.push({ text: ` ${state.replace(/_/g, ' ')}`, color: REVIEW_COLORS[state] ?? 'gray' })
    items.push({ rank: 4, row })
  }
  const agent = text(input.agent?.name)
  if (agent) items.push({ rank: 5, row: [{ text: `@${agent}`, color: 'magenta' }] })
  const style = text(input.output_style?.name)
  if (style && style !== 'default') items.push({ rank: 6, row: [{ text: `style ${style}`, dim: true }] })
  return items
}

function usageRow(input: HudInput, options: HudOptions): Item[] {
  const items: Item[] = []
  const window = input.context_window
  if (window) items.push({ rank: 0, row: contextOf(window) })
  const limits = input.rate_limits ?? {}
  const kinds = [...WINDOWS.filter(kind => kind in limits), ...Object.keys(limits).filter(kind => !WINDOWS.includes(kind))]
  for (const kind of kinds) {
    const limit = limits[kind]
    if (typeof limit?.used_percentage !== 'number' || limit.used_percentage < LIMIT_SHOWN) continue
    items.push({ rank: kind === 'seven_day' ? 4 : 3, row: rateOf(kind, limit, options.now) })
  }
  const cache = cacheState(input.prompt_cache, options.now)
  if (cache) {
    items.push({ rank: 1, row: [{ text: 'cache ', dim: true }, cache.minutes === undefined
      ? { text: 'cold', color: 'red' }
      : { text: countdown(cache.minutes * 60), color: cache.level }] })
  }
  // A miss is read beside the cache it broke, not on the warning row.
  const miss = missOf(input.prompt_cache, options)
  if (miss) items.push({ rank: 2, glued: true, row: [{ text: ` ⚠ 캐시 깨짐: ${miss} `, alert: true }] })
  return items
}

function warningRow(input: HudInput, options: HudOptions): Item[] {
  const items: Item[] = []
  const percent = input.context_window?.used_percentage
  if (typeof percent === 'number' && percent >= CONTEXT_WARN) {
    items.push({ rank: 0, row: [{ text: ` ⚠ 컨텍스트 ${percent}% · 품질 저하 구간 → /compact 또는 새 세션 `, alert: true }] })
  }
  const cache = cacheState(input.prompt_cache, options.now)
  if (cache?.level === 'red' && cache.minutes !== undefined) {
    items.push({ rank: 1, row: [{ text: ` ⚠ 캐시 ${cache.minutes}분 후 만료 · 이어갈 거면 지금 보내세요 `, alert: true }] })
  }
  return items
}

// The cache's minutes left with their color, or no minutes once it went cold. Undefined when caching never showed.
function cacheState(cache: PromptCache | undefined, now: number): { minutes?: number; level: string } | undefined {
  if (!cache?.caching_observed) return undefined
  const left = cache.warm && typeof cache.expires_at === 'number' ? cache.expires_at - now / 1000 : 0
  if (left <= 0) return { level: 'red' }
  const minutes = Math.ceil(left / 60)
  const limits = CACHE_LEFT[cache.ttl ?? ''] ?? { yellow: 10, red: 3 }
  return { minutes, level: minutes <= limits.red ? 'red' : minutes <= limits.yellow ? 'yellow' : 'green' }
}

function missOf(cache: PromptCache | undefined, options: HudOptions): string | undefined {
  const at = cache?.last_miss_at
  if (typeof at !== 'number' || options.now / 1000 - at > MISS_SHOWN_SECONDS) return undefined
  const seen = seeMiss(cache, options.missSeen)
  if (seen && (cache?.requests ?? 0) > seen.requests) return undefined
  const cause = cache?.last_miss_cause
  const names = (cause?.causes ?? []).map(name => {
    const label = MISS_CAUSES[name] ?? text(name) ?? name
    if (name === 'tools_changed' && (cause?.tools_added !== undefined || cause?.tools_removed !== undefined)) {
      return `${label} (+${cause?.tools_added ?? 0} −${cause?.tools_removed ?? 0})`
    }
    return label
  })
  return names.length ? names.join(', ') : MISS_CAUSES.unknown
}

function contextOf(window: NonNullable<HudInput['context_window']>): Row {
  const percent = window.used_percentage
  const size = window.context_window_size
  const row: Row = [{ text: 'ctx ', dim: true }]
  if (typeof percent !== 'number') {
    row.push({ text: '▱'.repeat(BAR_CELLS), dim: true })
    if (size) row.push({ text: ` ${tokens(size)}`, dim: true })
    return row
  }
  const filled = Math.min(BAR_CELLS, Math.max(0, Math.round(percent / (100 / BAR_CELLS))))
  const color = percent > CONTEXT_RED ? 'red' : percent >= CONTEXT_YELLOW ? 'yellow' : 'green'
  row.push({ text: '▰'.repeat(filled), color }, { text: '▱'.repeat(BAR_CELLS - filled), dim: true }, { text: ` ${percent}%`, color })
  if (typeof window.total_input_tokens === 'number' && size) row.push({ text: ` ${tokens(window.total_input_tokens)}/${tokens(size)}`, dim: true })
  return row
}

function rateOf(kind: string, limit: RateWindow, now: number): Row {
  const percent = limit.used_percentage ?? 0
  const color = percent >= 85 ? 'red' : 'yellow'
  const row: Row = [{ text: `${WINDOW_LABELS[kind] ?? kind.replace(/_/g, ' ')} `, dim: true }]
  row.push(typeof limit.used_usd === 'number' && typeof limit.limit_usd === 'number'
    ? { text: `${dollars(limit.used_usd)}/${dollars(limit.limit_usd)}`, color }
    : { text: `${percent}%`, color })
  if (typeof limit.resets_at === 'number') row.push({ text: ` ↻${countdown(limit.resets_at - now / 1000)}`, dim: true })
  return row
}

function placeOf(workspace: HudInput['workspace']): Row | undefined {
  const current = text(workspace?.current_dir)
  const project = text(workspace?.project_dir) ?? current
  if (!project) return undefined
  const name = text(workspace?.repo?.name) ?? basename(project)
  if (!current || current === project) return [{ text: name, color: 'blue', bold: true }]
  if (current.startsWith(`${project}/`)) return [{ text: name, color: 'blue', bold: true }, { text: current.slice(project.length), color: 'blue' }]
  return [{ text: basename(current), color: 'blue', bold: true }]
}

function branchOf(input: HudInput, git: GitState | undefined): Row | undefined {
  const branch = git?.branch ?? text(input.worktree?.branch)
  if (!branch) return undefined
  const row: Row = [{ text: `⎇ ${branch}`, color: 'magenta' }]
  if (git?.ahead) row.push({ text: ` ↑${git.ahead}`, color: 'cyan' })
  if (git?.behind) row.push({ text: ` ↓${git.behind}`, color: 'cyan' })
  const worktree = text(input.workspace?.git_worktree) ?? text(input.worktree?.name)
  if (worktree) row.push({ text: ` wt:${worktree}`, dim: true })
  return row
}

// Drops the highest-ranked items until the row fits, then clips what is left at the edge.
function layout(items: Item[], room: number): Row {
  const kept = [...items]
  while (kept.length > 1 && width(plain(join(kept))) > room) {
    const worst = kept.reduce((at, item, index) => (item.rank > (kept[at]?.rank ?? -1) ? index : at), 0)
    kept.splice(worst, 1)
  }
  return clip(join(kept), room)
}

function join(items: Item[]): Row {
  return items.flatMap((item, index) => (index === 0 ? item.row : [item.glued ? { text: ' ' } : SEPARATOR, ...item.row]))
}

function clip(row: Row, room: number): Row {
  if (width(plain(row)) <= room) return row
  const out: Row = []
  let used = 0
  for (const part of row) {
    const size = width(part.text)
    if (used + size > room) {
      out.push({ ...part, text: fit(part.text, room - used) })
      break
    }
    out.push(part)
    used += size
  }
  return out
}

function paint(row: Row, color: boolean): string {
  if (!color) return plain(row)
  return row.map(part => {
    const codes = part.alert ? [ALERT_SGR] : [part.bold ? '1' : '', part.dim ? '2' : '', part.color ? SGR[part.color] ?? '' : ''].filter(Boolean)
    return codes.length ? `\x1b[${codes.join(';')}m${part.text}\x1b[0m` : part.text
  }).join('')
}

function plain(row: Row): string {
  return row.map(part => part.text).join('')
}

// Payload strings come from the session (an agent name, a repository name); control characters would reach the
// terminal as escape sequences, so they are blanked like every other line the plugin draws.
function text(value: string | undefined): string | undefined {
  const cleaned = typeof value === 'string' ? clean(value).trim() : ''
  return cleaned || undefined
}

function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
}

function tokens(count: number): string {
  if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(1))}M`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`
  return String(count)
}

function dollars(usd: number): string {
  return `$${usd.toFixed(usd >= 100 ? 0 : 2)}`
}

function countdown(seconds: number): string {
  if (seconds <= 0) return 'now'
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d${hours % 24}h`
}
