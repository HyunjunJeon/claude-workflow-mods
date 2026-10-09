import { expect, test, type Plugin } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { checkpoint, harness, start } from './control-harness.ts'

// B6: a `claude -p` session exits with exit code 0 while its DAG run is still `running`
// (a node left `scheduled` or `running`). Diagnosis and evidence: notes/b6-diagnosis.md.
//
// The mocked host models the headless rule the evidence shows. Its numbers:
//   HOST_TURN_LIMIT_MS  60_000  debug log of a real `claude -p` run: "[WARN] headless session: turn events
//                               still running after 60000ms; the turn ends without them", 60.00 s after
//                               the main turn ended and the plugin's hold began. The hold was not aborted
//                               (its `sleep 1` loop kept running); the host simply stops waiting for it.
//   HOST_GRACE_MS       58      past that limit the session is kept up only by live agents and by work
//                               already handed to it, and it ends 58-108 ms after the last node agent's
//                               SubagentStop (five early exits). The live reproduction began shutting
//                               down 44 ms after the stop (MCP servers closed), had no session bound by
//                               239 ms (`$.session.messages` refused) and exited at 440 ms, while the
//                               plugin's own completion work (a 332 ms verify) was still running.
//                               The test takes the shortest observed value; any plugin tail longer than
//                               the grace loses, so what matters is the structure, not the number.
//   verify 40 ms, spawn 30 ms   successors started 54-87 ms after the previous node's stop in the same
//                               sessions, and verification evidence landed 39 ms after the stop.
// Whether the real host decides exactly this way is inferred from those sessions, not mocked from host
// code; the plugin-side half (the completion tail loses a race it cannot win) is what these tests encode.
const HOST_TURN_LIMIT_MS = 60_000
const HOST_GRACE_MS = 58

// The harness denies `sleep` and answers every other process at once. This plugin sits above the
// harness and makes time pass on the mock clock instead: `sleep` takes one second (so the hold loops),
// a verify argv `['check-control', '<ms>']` takes <ms>, and a spawn whose prompt carries
// `spawn-latency-ms=<ms>` takes <ms>. Everything else falls through to the harness. A plugin's
// `register` closes over nothing of this file, so the timings travel in argv and prompt.
const LATENCY: Plugin = {
  name: 'b6-latency',
  register(on) {
    on('process.run', async ($, e, next) => {
      if (e.argv[0] === 'sleep') {
        await $.clock.sleep(1_000)
        return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      }
      if (e.argv[0] === 'check-control') await $.clock.sleep(Number(e.argv[1] ?? 0))
      return next(e)
    })
    on('agent.spawn', async ($, e, next) => {
      const latency = /spawn-latency-ms=(\d+)/.exec(String(e.prompt))
      if (latency) await $.clock.sleep(Number(latency[1]))
      return next(e)
    })
  },
}

type Timing = { stopAtMs: number; verifyMs: number; spawnMs: number }

// Node `a` runs while the main turn's hold is up. `successor` adds node `b` after it.
function definition(timing: Timing, successor: boolean) {
  const verify = [{ kind: 'command', argv: ['check-control', String(timing.verifyMs)] }]
  return {
    key: 'b6',
    nodes: [
      { id: 'a', prompt: 'Step A', verify },
      ...(successor ? [{ id: 'b', prompt: `Step B spawn-latency-ms=${timing.spawnMs}`, dependsOn: ['a'], verify }] : []),
    ],
  }
}

// Plays one non-interactive `-p` session: the main turn ends and holds, node `a` stops `stopAtMs`
// later, and the host ends the session `HOST_GRACE_MS` after the stop unless something keeps it up.
// Returns the checkpoint on disk at the moment the host ends the session (`ended: true`), or, when
// something kept the session up, the checkpoint after the run was allowed to finish (`ended: false`).
async function session($: Engine, on: On, timing: Timing, successor: boolean) {
  const h = harness(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.skill.prompt({ skill: 'dag-workflow:dag-planning', text: '# planning' })
  const runId = await start($, definition(timing, successor))
  expect(h.spawns.length).toBe(1)

  let holding = true
  const heldAt = h.clock.now()
  const hold = $.turn.complete({ turnId: 'main', answer: 'started', durationMs: 1, isAborted: false, reason: 'answer' }).then(() => { holding = false })
  await h.clock.settle()
  await h.clock.advance(timing.stopAtMs)
  expect(holding).toBe(true)
  expect(checkpoint(h, runId).status).toBe('running')

  // Node `a` stops. Completion work (verify, checkpoint, successor spawn, settle prompt) is not awaited:
  // it runs on the mock clock while the host decides.
  const spawned = h.spawns.length
  const queued = h.prompts.length
  const completions = [$.turn.complete({
    turnId: 'turn-agent-1', agentId: 'agent-1', reason: 'answer', isAborted: false, answer: 'DAG_NODE_STATUS: completed', durationMs: 1,
  })]
  await h.clock.advance(HOST_GRACE_MS)

  const holdCounts = holding && h.clock.now() - heldAt < HOST_TURN_LIMIT_MS
  const keptUp = holdCounts || h.spawns.length > spawned || h.prompts.length > queued
  if (!keptUp) return { ended: true as const, run: checkpoint(h, runId) }

  // The session stayed up: let every remaining agent stop in turn until the run settles.
  for (let step = 0; step < 20 && checkpoint(h, runId).status === 'running'; step++) {
    await h.clock.advance(1_000)
    for (let n = 2; n <= h.spawns.length; n++) {
      completions.push($.turn.complete({
        turnId: `turn-agent-${n}`, agentId: `agent-${n}`, reason: 'answer', isAborted: false, answer: 'DAG_NODE_STATUS: completed', durationMs: 1,
      }))
    }
  }
  await h.clock.advance(1_000)
  await Promise.all([...completions, hold])
  return { ended: false as const, run: checkpoint(h, runId) }
}

const unfinished = (run: { nodes: { id: string; state: string }[] }) =>
  run.nodes.filter(node => node.state === 'scheduled' || node.state === 'running' || node.state === 'pending').map(node => `${node.id}:${node.state}`)

test('B6 scheduled form: past the host turn limit the session ends before the successor of the last stopped node is spawned', { plugins: [LATENCY] }, async ($, on) => {
  const out = await session($, on, { stopAtMs: HOST_TURN_LIMIT_MS + 1_000, verifyMs: 40, spawnMs: 30 }, true)
  expect(unfinished(out.run)).toEqual([])
  expect(out.run.status).toBe('completed')
})

test('B6 running form: past the host turn limit the session ends while the last node is still being verified', { plugins: [LATENCY] }, async ($, on) => {
  const out = await session($, on, { stopAtMs: HOST_TURN_LIMIT_MS + 1_000, verifyMs: 80, spawnMs: 0 }, false)
  expect(unfinished(out.run)).toEqual([])
  expect(out.run.status).toBe('completed')
})

test('control: before the host turn limit the hold keeps the session up and the chain finishes', { plugins: [LATENCY] }, async ($, on) => {
  const out = await session($, on, { stopAtMs: 30_000, verifyMs: 40, spawnMs: 30 }, true)
  expect(out.ended).toBe(false)
  expect(out.run.status).toBe('completed')
})

test('control: past the host turn limit a completion that lands inside the grace window keeps the session up', { plugins: [LATENCY] }, async ($, on) => {
  const out = await session($, on, { stopAtMs: HOST_TURN_LIMIT_MS + 1_000, verifyMs: 10, spawnMs: 10 }, true)
  expect(out.ended).toBe(false)
  expect(out.run.status).toBe('completed')
})

// The fix: a node completion while a non-interactive main turn is held submits one short keep-alive prompt before
// any verify, so the host has queued work during the completion tail; the hold then hands off to that prompt's turn.
const KEEP_ALIVE = 'dag-workflow is verifying it and continuing the run'
const keepAlives = (h: { prompts: string[] }) => h.prompts.filter(text => text.includes(KEEP_ALIVE))
const CHECK = [{ kind: 'command', argv: ['check-control'] }]

function stop($: Engine, agent: number) {
  return $.turn.complete({
    turnId: `turn-agent-${agent}`, agentId: `agent-${agent}`, reason: 'answer', isAborted: false, answer: 'DAG_NODE_STATUS: completed', durationMs: 1,
  })
}

async function headless($: Engine) {
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.skill.prompt({ skill: 'dag-workflow:dag-planning', text: '# planning' })
}

test('keep-alive: an interactive session never submits the keep-alive prompt', { plugins: [LATENCY] }, async ($, on) => {
  const h = harness(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.skill.prompt({ skill: 'dag-workflow:dag-planning', text: '# planning' })
  const runId = await start($, { key: 'ka-interactive', nodes: [{ id: 'a', prompt: 'A', verify: CHECK }, { id: 'b', prompt: 'B', dependsOn: ['a'], verify: CHECK }] })
  await $.turn.complete({ turnId: 'main', answer: 'started', durationMs: 1, isAborted: false, reason: 'answer' })
  await h.clock.advance(HOST_TURN_LIMIT_MS + 1_000)
  const done = [stop($, 1)]
  await h.clock.advance(1_000)
  done.push(stop($, 2))
  await h.clock.advance(1_000)
  await Promise.all(done)
  expect(checkpoint(h, runId).status).toBe('completed')
  expect(h.spawns.length).toBe(2)
  expect(keepAlives(h)).toEqual([])
})

test('keep-alive: no keep-alive prompt while the main turn is running and not held', { plugins: [LATENCY] }, async ($, on) => {
  const h = harness(on)
  await headless($)
  const runId = await start($, { key: 'ka-unheld', nodes: [{ id: 'a', prompt: 'A', verify: CHECK }, { id: 'b', prompt: 'B', dependsOn: ['a'], verify: CHECK }] })
  // The main turn never ends here, so nothing holds it.
  const done = stop($, 1)
  await h.clock.advance(1_000)
  await done
  expect(h.spawns.length).toBe(2)
  expect(checkpoint(h, runId).nodes.map(node => node.state)).toEqual(['completed', 'running'])
  expect(keepAlives(h)).toEqual([])
})

test('keep-alive: two completions close together while the turn is held queue one prompt', { plugins: [LATENCY] }, async ($, on) => {
  const h = harness(on)
  await headless($)
  const runId = await start($, {
    key: 'ka-pair',
    nodes: [
      { id: 'a', prompt: 'A', verify: CHECK },
      { id: 'b', prompt: 'B', verify: CHECK },
      { id: 'c', prompt: 'C', dependsOn: ['a', 'b'], verify: CHECK },
    ],
  })
  expect(h.spawns.length).toBe(2)
  let holding = true
  const hold = $.turn.complete({ turnId: 'main', answer: 'started', durationMs: 1, isAborted: false, reason: 'answer' }).then(() => { holding = false })
  await h.clock.settle()
  await h.clock.advance(HOST_TURN_LIMIT_MS + 1_000)
  const done = [stop($, 1), stop($, 2)]
  await h.clock.advance(HOST_GRACE_MS)
  expect(keepAlives(h)).toHaveLength(1)
  expect(keepAlives(h)[0]).toContain(runId)
  await h.clock.advance(1_000)
  // Handed off: the hold has returned instead of spinning beside the keep-alive prompt's turn.
  expect(holding).toBe(false)
  expect(h.spawns.length).toBe(3)
  done.push(stop($, 3))
  await h.clock.advance(1_000)
  await Promise.all([...done, hold])
  expect(checkpoint(h, runId).status).toBe('completed')
  expect(keepAlives(h)).toHaveLength(1)
})

test('keep-alive: the prompt\'s turn ends and holds afresh after the earlier hold returned, and covers the completions before it', { plugins: [LATENCY] }, async ($, on) => {
  const h = harness(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  await headless($)
  const runId = await start($, {
    key: 'ka-chain',
    nodes: [
      { id: 'a', prompt: 'A', verify: CHECK },
      { id: 'b', prompt: 'B', dependsOn: ['a'], verify: CHECK },
      { id: 'c', prompt: 'C', dependsOn: ['b'], verify: CHECK },
    ],
  })
  let firstHolding = true
  const firstHold = $.turn.complete({ turnId: 'main', answer: 'started', durationMs: 1, isAborted: false, reason: 'answer' }).then(() => { firstHolding = false })
  await h.clock.settle()
  await h.clock.advance(HOST_TURN_LIMIT_MS + 1_000)
  const done = [stop($, 1)]
  await h.clock.advance(1_000)
  expect(keepAlives(h)).toHaveLength(1)
  expect(firstHolding).toBe(false)
  await firstHold
  expect(h.logs.some(line => line.includes('stopped holding: handed off'))).toBe(true)

  // Node b stops before the keep-alive prompt's turn has begun: that queued prompt covers it.
  done.push(stop($, 2))
  await h.clock.advance(1_000)
  expect(h.spawns.length).toBe(3)
  expect(keepAlives(h)).toHaveLength(1)

  // The modelled host runs the queued prompt as a new main turn. Observed live: a plugin prompt enqueued
  // 43 ms after the last SubagentStop was followed by a second main turn and its own Stop
  // (notes/b6-transcripts-notes.md, the settled debug-fix session, L64-66 and L93-94).
  await $.turn.start({ turnId: 'main-2', text: keepAlives(h)[0] ?? '' })
  let secondHolding = true
  const secondHold = $.turn.complete({ turnId: 'main-2', answer: 'Noted.', durationMs: 1, isAborted: false, reason: 'answer' }).then(() => { secondHolding = false })
  await h.clock.advance(1_000)
  expect(secondHolding).toBe(true)

  done.push(stop($, 3))
  await h.clock.advance(1_000)
  expect(keepAlives(h)).toHaveLength(2)
  await h.clock.advance(1_000)
  await Promise.all([...done, secondHold])
  expect(checkpoint(h, runId).status).toBe('completed')
})
