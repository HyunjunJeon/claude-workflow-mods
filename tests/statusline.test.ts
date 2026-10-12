import { expect, test } from 'claude-code/testing'
import { width } from '../hooks/ui/text.ts'
import { parseGitStatus, renderHud, seeMiss, type HudInput } from '../statusline/render.ts'

const NOW = 1_791_788_400_000
const SECONDS = NOW / 1000

// A payload as Claude Code 2.1.296 sent it after the first response, trimmed to the fields the HUD reads plus the
// session title, cost and line counts, which the HUD leaves out.
const PAYLOAD: HudInput & { session_name: string; cost: object } = {
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  effort: { level: 'xhigh' },
  fast_mode: false,
  session_name: 'Statusline HUD',
  output_style: { name: 'default' },
  workspace: { current_dir: '/work/app', project_dir: '/work/app', repo: { name: 'app' } },
  cost: { total_cost_usd: 1.234, total_duration_ms: 754_000, total_lines_added: 156, total_lines_removed: 23 },
  context_window: { total_input_tokens: 52_858, context_window_size: 1_000_000, used_percentage: 5 },
  rate_limits: {
    seven_day: { used_percentage: 39, resets_at: SECONDS + 2 * 86_400 + 9 * 3600 },
    five_hour: { used_percentage: 16, resets_at: SECONDS + 2 * 3600 + 20 * 60 },
  },
  prompt_cache: { warm: true, caching_observed: true, ttl: '1h', expires_at: SECONDS + 58 * 60, last_miss_at: null, last_miss_cause: null },
}
const GIT = { branch: 'main', ahead: 1, behind: 0 }

function cache(minutes: number, ttl = '1h', warm = true): HudInput {
  return { prompt_cache: { warm, caching_observed: true, ttl, expires_at: SECONDS + minutes * 60 } }
}

test('the HUD draws identity and usage rows, without the session title, cost, time, change counts or low limits', () => {
  expect(renderHud(PAYLOAD, { now: NOW, git: GIT })).toEqual([
    'Opus 5.5 xhigh │ app │ ⎇ main ↑1',
    'ctx ▰▱▱▱▱▱▱▱▱▱ 5% 53k/1M │ cache 58m',
  ])
})

test('a payload from before the first response draws no undefined or NaN', () => {
  const rows = renderHud({ model: { display_name: 'Haiku 5.5' }, context_window: { context_window_size: 200_000, used_percentage: null } }, { now: NOW })
  expect(rows).toEqual(['Haiku 5.5', 'ctx ▱▱▱▱▱▱▱▱▱▱ 200k'])
  expect(renderHud({}, { now: NOW })).toEqual([])
})

test('context turns yellow at 50% and red above 65%', () => {
  const at = (percent: number) => renderHud({ context_window: { used_percentage: percent } }, { now: NOW, color: true })[0]
  expect(at(49)).toContain('\x1b[32m 49%')
  expect(at(50)).toContain('\x1b[33m 50%')
  expect(at(65)).toContain('\x1b[33m 65%')
  expect(at(66)).toContain('\x1b[31m 66%')
})

test('context at 80% or more adds a warning row on red', () => {
  expect(renderHud({ context_window: { used_percentage: 79 } }, { now: NOW })).toHaveLength(1)
  const rows = renderHud({ context_window: { used_percentage: 82 } }, { now: NOW, color: true })
  expect(rows[1]).toBe('\x1b[1;97;41m ⚠ 컨텍스트 82% · 품질 저하 구간 → /compact 또는 새 세션 \x1b[0m')
})

test('a rate-limit window shows only from 70%, with its reset time, yellow then red at 85%', () => {
  const limits = (five: number, seven: number) => renderHud({ rate_limits: {
    five_hour: { used_percentage: five, resets_at: SECONDS + 23 * 60 },
    seven_day: { used_percentage: seven, resets_at: SECONDS + 86_400 },
  } }, { now: NOW, color: true })
  expect(limits(69, 39)).toEqual([])
  expect(limits(70, 39)).toEqual(['\x1b[2m5h \x1b[0m\x1b[33m70%\x1b[0m\x1b[2m ↻23m\x1b[0m'])
  expect(limits(92, 88)[0]).toContain('\x1b[31m92%')
  expect(limits(92, 88)[0]).toContain('7d \x1b[0m\x1b[31m88%')
})

test('the cache turns yellow, then red with a warning row, as its TTL runs out', () => {
  const paint = (input: HudInput) => renderHud(input, { now: NOW, color: true })
  expect(paint(cache(58))).toEqual(['\x1b[2mcache \x1b[0m\x1b[32m58m\x1b[0m'])
  expect(paint(cache(10))[0]).toContain('\x1b[33m10m')
  expect(paint(cache(3))).toEqual(['\x1b[2mcache \x1b[0m\x1b[31m3m\x1b[0m', '\x1b[1;97;41m ⚠ 캐시 3분 후 만료 · 이어갈 거면 지금 보내세요 \x1b[0m'])
  expect(paint(cache(3, '5m'))[0]).toContain('\x1b[32m3m')
  expect(paint(cache(2, '5m'))[0]).toContain('\x1b[33m2m')
  expect(paint(cache(1, '5m'))).toHaveLength(2)
})

test('a cold cache is red, and only a warm one counts down', () => {
  expect(renderHud(cache(58, '1h', false), { now: NOW })).toEqual(['cache cold'])
  expect(renderHud(cache(-1), { now: NOW })).toEqual(['cache cold'])
  expect(renderHud(cache(58, '1h', false), { now: NOW, color: true })[0]).toContain('\x1b[31mcold')
  expect(renderHud({ prompt_cache: { warm: false, caching_observed: false } }, { now: NOW })).toEqual([])
})

test('a cache miss names its causes beside the cache for ten minutes', () => {
  const missed = (minutesAgo: number, cause: object | null) => renderHud({ prompt_cache: {
    warm: true, caching_observed: true, ttl: '1h', expires_at: SECONDS + 50 * 60, last_miss_at: SECONDS - minutesAgo * 60, last_miss_cause: cause,
  } }, { now: NOW })
  expect(missed(1, { causes: ['tools_changed'], tools_added: 2, tools_removed: 0 })).toEqual(['cache 50m  ⚠ 캐시 깨짐: 도구 목록 바뀜 (+2 −0) '])
  expect(missed(1, { causes: ['effort_changed', 'auto_mode_changed'] })).toEqual(['cache 50m  ⚠ 캐시 깨짐: effort 바뀜, auto 모드 전환 '])
  expect(missed(1, { causes: ['brand_new_cause'] })).toEqual(['cache 50m  ⚠ 캐시 깨짐: brand_new_cause '])
  expect(missed(1, null)).toEqual(['cache 50m  ⚠ 캐시 깨짐: 원인 모름 '])
  expect(missed(11, { causes: ['ttl_expired_1h'] })).toEqual(['cache 50m'])
  const painted = renderHud({ context_window: { used_percentage: 5 }, prompt_cache: { warm: true, caching_observed: true, ttl: '1h', expires_at: SECONDS + 50 * 60,
    last_miss_at: SECONDS - 60, last_miss_cause: { causes: ['ttl_expired_1h'] } } }, { now: NOW, color: true })
  expect(painted).toHaveLength(1)
  expect(painted[0]).toContain('\x1b[32m50m\x1b[0m \x1b[1;97;41m ⚠ 캐시 깨짐: 1시간 넘게 쉬어 만료 \x1b[0m')
})

test('a miss shows only until the next request, which reads the rebuilt cache', () => {
  const at = SECONDS - 60
  const after = (requests: number): HudInput => ({ prompt_cache: { warm: true, caching_observed: true, ttl: '1h', expires_at: SECONDS + 50 * 60,
    requests, last_miss_at: at, last_miss_cause: { causes: ['ttl_expired_1h'] } } })
  const seen = seeMiss(after(7).prompt_cache, undefined)
  expect(seen).toEqual({ at, requests: 7 })
  expect(renderHud(after(7), { now: NOW, missSeen: seen })).toEqual(['cache 50m  ⚠ 캐시 깨짐: 1시간 넘게 쉬어 만료 '])
  expect(seeMiss(after(8).prompt_cache, seen)).toBe(seen)
  expect(renderHud(after(8), { now: NOW, missSeen: seen })).toEqual(['cache 50m'])
  const newer = { ...after(8).prompt_cache, last_miss_at: SECONDS - 5 }
  expect(seeMiss(newer, seen)).toEqual({ at: SECONDS - 5, requests: 8 })
  expect(seeMiss({ warm: true, caching_observed: true, requests: 9, last_miss_at: null }, seen)).toBeUndefined()
})

test('a narrow terminal drops the least important items and every row fits beside the indent', () => {
  const busy: HudInput = { ...PAYLOAD, context_window: { total_input_tokens: 820_000, context_window_size: 1_000_000, used_percentage: 82 },
    rate_limits: { five_hour: { used_percentage: 91, resets_at: SECONDS + 600 } } }
  const rows = renderHud(busy, { now: NOW, git: GIT, columns: 45 })
  for (const row of rows) expect(width(row)).toBeLessThanOrEqual(43)
  expect(rows[0]).toBe('Opus 5.5 xhigh │ app │ ⎇ main ↑1')
  expect(rows[1]).toBe('ctx ▰▰▰▰▰▰▰▰▱▱ 82% 820k/1M │ cache 58m')
  expect(rows[2]?.startsWith(' ⚠ 컨텍스트 82%')).toBe(true)
  expect(rows[2]?.endsWith('…')).toBe(true)
  expect(renderHud(PAYLOAD, { now: NOW, git: GIT, columns: 32 })[0]).toBe('Opus 5.5 xhigh │ app')
  const missed: HudInput = { ...busy, context_window: PAYLOAD.context_window, prompt_cache: { ...PAYLOAD.prompt_cache, last_miss_at: SECONDS - 60, last_miss_cause: { causes: ['model_changed'] } } }
  expect(renderHud(missed, { now: NOW, columns: 80 })[1]).toBe('ctx ▰▱▱▱▱▱▱▱▱▱ 5% 53k/1M │ 5h 91% ↻10m │ cache 58m  ⚠ 캐시 깨짐: 모델 바뀜 ')
  expect(renderHud(missed, { now: NOW, columns: 70 })[1]).toBe('ctx ▰▱▱▱▱▱▱▱▱▱ 5% 53k/1M │ cache 58m  ⚠ 캐시 깨짐: 모델 바뀜 ')
  expect(renderHud(missed, { now: NOW, columns: 45 })[1]).toBe('ctx ▰▱▱▱▱▱▱▱▱▱ 5% 53k/1M │ cache 58m')
  for (const row of renderHud(busy, { now: NOW, git: GIT, columns: 20 })) expect(width(row)).toBeLessThanOrEqual(18)
})

test('a spend limit, a PR, a subdirectory and a worktree are drawn when present', () => {
  const [identity, usage] = renderHud({
    workspace: { current_dir: '/work/app/hooks', project_dir: '/work/app', git_worktree: 'feature' },
    pr: { number: 12, review_state: 'changes_requested' },
    rate_limits: { spend_limit: { used_percentage: 104, used_usd: 52, limit_usd: 50, resets_at: SECONDS + 90 } },
  }, { now: NOW, git: GIT })
  expect(identity).toBe('app/hooks │ ⎇ main ↑1 wt:feature │ PR #12 changes requested')
  expect(usage).toBe('spend $52.00/$50.00 ↻2m')
})

test('payload text cannot inject terminal escape sequences', () => {
  const [identity] = renderHud({ agent: { name: 'evil\x1b]0;title\x07name' } }, { now: NOW })
  expect(identity).toBe('@evil ]0;title name')
})

test('git status porcelain v2 gives the branch and its ahead and behind counts', () => {
  const status = ['# branch.oid f7e9f4d222f284b0b78962d7af1a7a371fc0a3f7', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa bbb hooks/register.ts', '? statusline/hud.ts', '! ignored.log'].join('\n')
  expect(parseGitStatus(status)).toEqual({ branch: 'main', ahead: 2, behind: 1 })
  expect(parseGitStatus('# branch.oid f7e9f4d222f2\n# branch.head (detached)\n')).toEqual({ branch: '@f7e9f4d', ahead: 0, behind: 0 })
  expect(parseGitStatus('')).toBeUndefined()
})
