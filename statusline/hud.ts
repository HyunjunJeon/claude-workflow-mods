// Claude Code statusLine command: reads the session JSON on stdin, prints the HUD rows, and hands the same bytes to
// the next status line script (Orca's by default) so that integration keeps its feed. Node APIs only, so `bun` (about
// 8ms a run) and Node 24 (about 32ms, type stripping) both run it.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseGitStatus, renderHud, seeMiss, type GitState, type HudInput, type MissSeen } from './render.ts'

// Orca installs this script as its own statusLine and posts the payload to its app (rate limits, session time). It
// classifies a statusLine whose command contains `agent-hooks/claude-statusline` as its own and may rewrite it, so
// the path lives here and never in the settings command.
const ORCA_SCRIPT = join(homedir(), '.orca', 'agent-hooks', 'claude-statusline.sh')
// The status line reruns after every assistant message; git must not hold it up or contend with the user's own
// git commands. Only the branch and ahead/behind are drawn, so untracked files are not scanned; `status` in this
// repository takes about 13ms.
const GIT_TIMEOUT_MS = 500

let raw = ''
try {
  raw = readFileSync(0, 'utf8')
  forward(raw)
  const debugPath = process.env.CLAUDE_HUD_DEBUG
  if (debugPath) writeFileSync(debugPath, raw)
  const input = JSON.parse(raw) as HudInput
  const dir = input.workspace?.current_dir ?? process.cwd()
  const columns = Number(process.env.COLUMNS) || undefined
  const missSeen = rememberMiss(input)
  const rows = renderHud(input, { now: Date.now(), columns, color: !process.env.NO_COLOR, git: gitState(dir), missSeen })
  process.stdout.write(rows.join('\n') + '\n')
} catch (error) {
  // A non-zero exit or empty output blanks the status line, so a failure is drawn instead.
  process.stdout.write(`hud: ${error instanceof Error ? error.message : String(error)}\n`)
}

// Starts the chained script detached with the payload in its environment: Claude Code cancels an in-flight status
// line command on the next trigger, and Orca's curl can take 1.5s, so the HUD neither waits for it nor shares its
// process group. The bytes go through unchanged; Orca's script matches the raw text.
function forward(payload: string): void {
  const target = process.env.CLAUDE_HUD_CHAIN ?? ORCA_SCRIPT
  if (!payload || target === 'off' || !existsSync(target)) return
  const child = spawn('/bin/sh', ['-c', 'printf "%s" "$CLAUDE_HUD_PAYLOAD" | /bin/sh "$0"', target], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CLAUDE_HUD_PAYLOAD: payload },
  })
  child.on('error', () => {})
  child.unref()
}

// Each run is a fresh process, so the miss memory lives in a small file per session under the system temp directory
// (which macOS clears on its own). A file that cannot be read or written only costs the memory: the miss then shows
// as first seen.
function rememberMiss(input: HudInput & { session_id?: string }): MissSeen | undefined {
  const id = input.session_id
  if (!id || !/^[\w-]+$/.test(id)) return undefined
  const path = join(tmpdir(), `claude-hud-${id}.json`)
  let seen: MissSeen | undefined
  try {
    seen = JSON.parse(readFileSync(path, 'utf8')) as MissSeen
  } catch {}
  const next = seeMiss(input.prompt_cache, seen)
  if (next && next !== seen) {
    try {
      writeFileSync(path, JSON.stringify(next))
    } catch {}
  }
  return next
}

function gitState(dir: string): GitState | undefined {
  const result = spawnSync('git', ['-C', dir, '--no-optional-locks', 'status', '--porcelain=2', '--branch', '--untracked-files=no'], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return result.status === 0 ? parseGitStatus(result.stdout) : undefined
}
