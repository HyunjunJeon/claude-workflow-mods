import type { EngineInterface } from 'claude-code'
import { hash, stableStringify } from '../engine/hash.ts'
import { capText } from '../engine/jev.ts'
import { appendLearningEvent, applyLearningProposals, archivedSkillPath, eligibleSkills, emptyLearningSession, emptyLibrary, learnedSkillPath, parseLearningLibrary, parseLearningProposals, parseLearningSession, parseLearningTransaction, prepareLearningBatch, recordSkillUse, renderLearnedSkill, reserveLearningUsage, type LearnedSkill, type LearningEvent, type LearningLibrary, type LearningSession, type LearningTransaction } from '../engine/learning.ts'
import { atomicWrite, ensureGitignore, message, recoverReport, type AgentEnd } from './io.ts'

// Session learning: the state createLearning returns and the functions that take it. validate refuses $ passed to a
// method or a callback, so each operation that calls the host is a top-level function taking ($, learning, ...), and the
// host gives only what needs no $.
export type LearningHost = {
  sessionId(): string
  projectRoot(): string
  // A main model turn is running; finishLearning starts a requested batch only after it.
  mainTurnBusy(): boolean
  // The next number of register.ts's writeSequence, which also names atomicWrite's temp files.
  nextWriteSequence(): number
}

// register.ts parses the options into the limits and reads and resets the rest from its hooks.
export type Learning = {
  readonly host: LearningHost
  enabled: boolean
  interval: number
  minOpportunities: number
  maxSkills: number
  maxInputChars: number
  dailyLimit: number
  retentionDays: number
  root: string
  // The home skills folder. Only legacy learned skills (no location) live there; learnedSkillPath sends new ones to their
  // project's .claude/dag/skills.
  skillsDir: string
  session: LearningSession
  library: LearningLibrary
  readonly agents: Set<string>
  turnRequested: boolean
  spawning: boolean
  spawnName: string | undefined
  queue: Promise<unknown>
}

export function createLearning(host: LearningHost): Learning {
  return {
    host,
    enabled: true,
    interval: 20,
    minOpportunities: 50,
    maxSkills: 30,
    maxInputChars: 60_000,
    dailyLimit: 20,
    retentionDays: 30,
    root: '',
    skillsDir: '',
    session: emptyLearningSession(),
    library: emptyLibrary(),
    agents: new Set<string>(),
    turnRequested: false,
    spawning: false,
    spawnName: undefined,
    queue: Promise.resolve(),
  }
}

function learningSessionPath(learning: Learning, id = learning.host.sessionId()): string {
  return `${learning.root}/sessions/${hash(id)}.json`
}

async function learningDirectory($: EngineInterface, path: string): Promise<void> {
  const made = await $.process.run(['mkdir', '-p', path])
  if (made.exitCode !== 0) throw new Error(`cannot create learning directory: ${made.stderr.trim()}`)
  const stat = await $.fs.stat(path)
  if (stat.kind !== 'dir' || stat.isLink) throw new Error(`learning directory is not a plain directory: ${path}`)
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'))
}

// Creates the folder of a learned skill's file and the skills or archive folder above it, each a plain directory, so a
// symlink cannot send the file elsewhere. A project skill's file can be the first one in its project's .claude/dag, so
// that store's .gitignore is ensured before it.
async function prepareSkillFolder($: EngineInterface, skill: LearnedSkill, path: string): Promise<void> {
  const folder = parentOf(path)
  await learningDirectory($, parentOf(folder))
  await learningDirectory($, folder)
  if (skill.location === 'project') await ensureGitignore($, skill.projectRoot)
}

function learningWrite($: EngineInterface, learning: Learning, path: string, text: string): Promise<void> {
  return atomicWrite($, path, text, 'learning data', learning.host.sessionId(), learning.host.nextWriteSequence())
}

export async function saveLearningSession($: EngineInterface, learning: Learning, id = learning.host.sessionId()): Promise<void> {
  if (!learning.root) return
  await learningWrite($, learning, learningSessionPath(learning, id), JSON.stringify(learning.session) + '\n')
}

export async function readLearningLibrary($: EngineInterface, learning: Learning): Promise<LearningLibrary> {
  const path = `${learning.root}/library.json`
  if (!await $.fs.exists(path)) return emptyLibrary()
  const parsed = parseLearningLibrary(await $.fs.read(path))
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.value
}

// Callers in this session queue here, so the directory lock only ever meets another session's holder. This is not
// serialized(): that queue also holds agent spawns and Jev calls, which a prompt or a worker's Read must not wait
// behind. Nothing on this queue awaits serialized() or another library update, so the two queues cannot deadlock.
export function updateLearningLibrary($: EngineInterface, learning: Learning, update: (library: LearningLibrary) => LearningLibrary | Promise<LearningLibrary>): Promise<void> {
  const result = learning.queue.then(() => updateLockedLibrary($, learning, update))
  learning.queue = result.catch(() => undefined)
  return result
}

// A directory lock protects read/modify/write across independent sessions, not just this module's queue.
// Contention leaves the session's unlearned evidence intact for its next turn; no hook waits for another session.
async function updateLockedLibrary($: EngineInterface, learning: Learning, update: (library: LearningLibrary) => LearningLibrary | Promise<LearningLibrary>): Promise<void> {
  const lock = `${learning.root}/.lock`
  let acquired = await $.process.run(['mkdir', lock])
  if (acquired.exitCode !== 0 && await $.fs.exists(lock)) {
    const stat = await $.fs.stat(lock)
    if (!stat.isLink && stat.kind === 'dir' && (await $.clock.now()) - stat.mtimeMs > 60_000) {
      const released = await $.process.run(['rmdir', lock])
      if (released.exitCode === 0) acquired = await $.process.run(['mkdir', lock])
    }
  }
  if (acquired.exitCode !== 0) throw new Error('Learning library is busy; retained evidence for the next turn.')
  try {
    const pending = `${learning.root}/pending.json`
    if (await $.fs.exists(pending)) {
      const parsed = parseLearningTransaction(await $.fs.read(pending))
      if (!parsed.ok) throw new Error(parsed.error.message)
      await publishLearningTransaction($, learning, parsed.value, true)
    }
    const before = await readLearningLibrary($, learning)
    const after = await update(before)
    const changed = after.skills.some(skill => {
      const previous = before.skills.find(item => item.id === skill.id)
      return previous?.revision !== skill.revision || previous.archived !== skill.archived
    })
    if (changed) await publishLearningTransaction($, learning, { schemaVersion: 1, before, after })
    else {
      await learningWrite($, learning, `${learning.root}/library.json`, JSON.stringify(after) + '\n')
      learning.library = after
    }
  } finally {
    const released = await $.process.run(['rmdir', lock])
    if (released.exitCode !== 0) $.ui.log('Could not release the session learning library lock.')
  }
}

async function publishLearningTransaction($: EngineInterface, learning: Learning, transaction: LearningTransaction, recovering = false): Promise<void> {
  const current = stableStringify(await readLearningLibrary($, learning))
  if (current !== stableStringify(transaction.before) && current !== stableStringify(transaction.after)) {
    throw new Error('Learning library changed outside the pending publication; preserving both records.')
  }
  const changed = transaction.after.skills.filter(skill => {
    const previous = transaction.before.skills.find(item => item.id === skill.id)
    return previous?.revision !== skill.revision || previous.archived !== skill.archived
  })
  // Validate every destination before publishing the first file. Recovery accepts only the exact before/after text,
  // so a failed index write is distinguishable from an unmanaged file or a person's later edit. Recovery skips such a
  // skill rather than stopping: a pending.json that never clears would fail every later update in every session.
  const preserved = new Set<string>()
  for (const skill of changed) {
    const previous = transaction.before.skills.find(item => item.id === skill.id)
    const active = learnedSkillPath(skill, learning.skillsDir)
    const archived = archivedSkillPath(skill, learning.root)
    for (const path of skill.archived ? [active, archived] : [active]) {
      if (!await $.fs.exists(path)) continue
      const stat = await $.fs.stat(path)
      const text = await $.fs.read(path)
      const beforeText = path === active && previous ? renderLearnedSkill(previous) : undefined
      const afterText = recovering ? renderLearnedSkill(skill) : undefined
      if (stat.isLink || stat.kind !== 'file' || (text !== beforeText && text !== afterText)) {
        if (!recovering) throw new Error(`Preserving an unmanaged or manually changed skill: ${path}`)
        preserved.add(skill.id)
        $.ui.log(`Preserving a manually changed skill while finishing a learning publication: ${path}`)
      }
    }
  }
  const pending = `${learning.root}/pending.json`
  if (!recovering) await learningWrite($, learning, pending, JSON.stringify(transaction) + '\n')
  for (const skill of changed) {
    if (preserved.has(skill.id)) continue
    const path = learnedSkillPath(skill, learning.skillsDir)
    if (skill.archived) {
      if (await $.fs.exists(path)) {
        const archived = archivedSkillPath(skill, learning.root)
        await prepareSkillFolder($, skill, archived)
        const moved = await $.process.run(['mv', '-f', path, archived])
        if (moved.exitCode !== 0) throw new Error(`could not archive ${skill.id}`)
        // rmdir removes only an empty folder, so files a person added beside SKILL.md keep it in place.
        await $.process.run(['rmdir', parentOf(path)])
      }
    } else {
      await prepareSkillFolder($, skill, path)
      const wanted = renderLearnedSkill(skill)
      if (!await $.fs.exists(path) || await $.fs.read(path) !== wanted) await learningWrite($, learning, path, wanted)
    }
  }
  await learningWrite($, learning, `${learning.root}/library.json`, JSON.stringify(transaction.after) + '\n')
  learning.library = transaction.after
  const removed = await $.process.run(['rm', '-f', pending])
  if (removed.exitCode !== 0) throw new Error('Could not clear completed learning publication; it will be recovered next time.')
}

export async function pruneLearningData($: EngineInterface, learning: Learning): Promise<void> {
  if (!learning.root || learning.retentionDays === 0) return
  const cutoff = (await $.clock.now()) - learning.retentionDays * 86_400_000
  await updateLearningLibrary($, learning, async library => {
    const skills: LearningLibrary['skills'] = []
    for (const skill of library.skills) {
      if (!skill.archived || skill.updatedAt >= cutoff) {
        skills.push(skill)
        continue
      }
      const path = archivedSkillPath(skill, learning.root)
      if (await $.fs.exists(path)) {
        const stat = await $.fs.stat(path)
        if (stat.isLink || stat.kind !== 'file' || await $.fs.read(path) !== renderLearnedSkill(skill)) {
          skills.push(skill)
          $.ui.log(`Preserving a manually changed archived skill: ${path}`)
          continue
        }
        const removed = await $.process.run(['rm', '-f', path])
        if (removed.exitCode !== 0) {
          skills.push(skill)
          $.ui.log(`Could not remove expired archived skill: ${path}`)
          continue
        }
        await $.process.run(['rmdir', parentOf(path)])
      }
      // An active file created at this name since archival is not ours to remove.
      if (await $.fs.exists(learnedSkillPath(skill, learning.skillsDir))) skills.push(skill)
    }
    return { ...library, skills }
  })
  for (const entry of await $.fs.list(`${learning.root}/sessions`)) {
    if (entry.kind !== 'file' || entry.isLink || !/^[a-f0-9]+\.json$/.test(entry.name) || entry.mtimeMs >= cutoff) continue
    const path = `${learning.root}/sessions/${entry.name}`
    if (path === learningSessionPath(learning)) continue
    try {
      const parsed = parseLearningSession(await $.fs.read(path))
      if (!parsed.ok || parsed.value.batch || parsed.value.events.some(event => event.at >= cutoff)) continue
      const removed = await $.process.run(['rm', '-f', path])
      if (removed.exitCode !== 0) $.ui.log(`Could not remove expired learning session: ${path}`)
    } catch (error) {
      $.ui.log(`Could not inspect expired learning session ${path}: ${message(error)}`)
    }
  }
}

export async function initializeLearning($: EngineInterface, learning: Learning): Promise<void> {
  if (!learning.enabled) return
  const home = await $.env.get('HOME')
  if (!home || !home.startsWith('/')) {
    $.ui.log('Session learning unavailable: HOME is not an absolute directory.')
    return
  }
  learning.root = `${home.replace(/\/$/, '')}/.claude/dag-workflow/learning`
  learning.skillsDir = `${home.replace(/\/$/, '')}/.claude/skills`
  await learningDirectory($, `${learning.root}/sessions`)
  await learningDirectory($, learning.skillsDir)
  await updateLearningLibrary($, learning, library => library)
  const path = learningSessionPath(learning)
  learning.session = emptyLearningSession()
  if (await $.fs.exists(path)) {
    const parsed = parseLearningSession(await $.fs.read(path))
    if (!parsed.ok) throw new Error(parsed.error.message)
    learning.session = parsed.value
    if (learning.session.batch) {
      const active = (await $.agent.list()).some(agent => agent.id === learning.session.batch?.agentId && agent.status === 'running')
      if (active) learning.agents.add(learning.session.batch.agentId)
      else {
        learning.session = { ...learning.session, batch: undefined }
        await saveLearningSession($, learning)
      }
    }
  }
  await pruneLearningData($, learning)
}

export async function collectLearning($: EngineInterface, learning: Learning, kind: LearningEvent['kind'], text: string, agentId?: string): Promise<void> {
  if (!learning.enabled || !learning.root || (agentId && learning.agents.has(agentId)) || !text.trim()) return
  const at = await $.clock.now()
  const sessionId = learning.host.sessionId()
  const id = `${hash(sessionId)}:${learning.session.nextId}`
  const event: LearningEvent = { id, sessionId, projectRoot: learning.host.projectRoot(), kind, text: capText(text, 3_900).replace(/\0/g, '').slice(0, 4_000), at, ...(agentId ? { agentId } : {}) }
  learning.session = appendLearningEvent(learning.session, event)
}

export async function startLearning($: EngineInterface, learning: Learning, force = false, manual = false): Promise<string> {
  if (!learning.enabled || !learning.root) return 'Session learning is off or unavailable.'
  if (learning.session.batch || learning.spawning) return 'Session learning is already running.'
  if (!force && learning.session.toolsSinceLearn < learning.interval) return 'Session learning will run after more tool calls.'
  if (!learning.session.events.some(event => event.kind === 'user')) return 'No new user-session experience to learn.'
  if (!learning.session.events.some(event => Number(event.id.split(':').at(-1)) > learning.session.learnedThrough)) return 'No new user-session experience to learn.'
  const now = await $.clock.now()
  let limit: string | undefined
  await updateLearningLibrary($, learning, library => {
    if (manual) return library
    const reserved = reserveLearningUsage(library, now, learning.dailyLimit)
    if (!reserved.ok) {
      limit = reserved.error.message
      return library
    }
    return reserved.value
  })
  if (limit) return limit
  const prepared = prepareLearningBatch(learning.session, learning.library, learning.host.projectRoot(), learning.maxInputChars)
  if (!prepared.ok) return prepared.error.message
  const snapshot = prepared.value
  learning.spawning = true
  learning.spawnName = `dag-learning-${hash(learning.host.sessionId())}-${learning.host.nextWriteSequence()}`
  try {
    const spawned = await $.agent.spawn({
      prompt: snapshot.prompt, name: learning.spawnName,
      description: 'Learn reusable skills from this user session',
      subagentType: 'general-purpose', model: 'sonnet',
    })
    if (!spawned.agentId) return `Could not start session learning: ${spawned.deny ?? 'no agent id'}`
    learning.agents.add(spawned.agentId)
    learning.session = {
      ...learning.session,
      batch: { agentId: spawned.agentId, events: snapshot.events, baseline: snapshot.baseline, through: snapshot.through, editableIds: snapshot.editableIds },
    }
    await saveLearningSession($, learning)
    return 'Session learning started in the background.'
  } finally {
    learning.spawning = false
    learning.spawnName = undefined
  }
}

export async function finishLearning($: EngineInterface, learning: Learning, end: AgentEnd): Promise<void> {
  const batch = learning.session.batch
  if (!batch || batch.agentId !== end.agentId) return
  try {
    if (!learning.enabled || end.isAborted || end.reason !== 'answer') return
    const answer = end.answer || await recoverReport($, end.agentId)
    const parsed = parseLearningProposals(answer, batch.events, batch.baseline)
    if (!parsed.ok) throw new Error(parsed.error.message)
    if (batch.editableIds && parsed.value.some(proposal => [proposal.id, ...proposal.replaces]
      .some(id => batch.baseline.some(skill => skill.id === id) && !batch.editableIds?.includes(id)))) {
      throw new Error('A proposed update needs the complete existing skill body; retained evidence for relearning.')
    }
    const now = await $.clock.now()
    await updateLearningLibrary($, learning, library => {
      for (const proposal of parsed.value) {
        for (const id of [proposal.id, ...proposal.replaces]) {
          const expected = batch.baseline.find(skill => skill.id === id)
          const current = library.skills.find(skill => skill.id === id)
          if (current?.revision !== expected?.revision || current?.archived !== expected?.archived) {
            throw new Error(`Skill ${id} changed in another session; retained evidence for relearning.`)
          }
        }
      }
      const applied = applyLearningProposals(library, parsed.value, { events: batch.events, sessionId: learning.host.sessionId(), projectRoot: learning.host.projectRoot(), now })
      if (!applied.ok) throw new Error(`${applied.error.message} Retained evidence for relearning.`)
      return applied.value
    })
    learning.session = { ...learning.session, learnedThrough: batch.through }
    $.ui.log(`Session learning saved ${parsed.value.length} skill proposal(s).`)
  } finally {
    // A failed batch keeps its evidence, but only tool calls made after it count toward the next automatic batch;
    // otherwise a persistent failure spawns a learner at every turn boundary until the daily limit.
    learning.session = {
      ...learning.session, batch: undefined,
      toolsSinceLearn: learning.session.events.filter(event => event.kind === 'tool' && Number(event.id.split(':').at(-1)) > batch.through).length,
    }
    await saveLearningSession($, learning)
  }
  if (learning.turnRequested && !learning.host.mainTurnBusy()) {
    learning.turnRequested = false
    await startLearning($, learning, true)
  }
}

export async function observeLearnedSkill($: EngineInterface, learning: Learning, tool: string, input: Readonly<Record<string, unknown>>): Promise<void> {
  if (!learning.enabled || !learning.root) return
  const id = tool === 'Skill' && typeof input.skill === 'string' ? input.skill.split(':').at(-1)
    : tool === 'Read' && typeof input.file_path === 'string'
      ? eligibleSkills(learning.library, learning.host.projectRoot()).find(skill => input.file_path === learnedSkillPath(skill, learning.skillsDir))?.id
      : undefined
  if (!id || !eligibleSkills(learning.library, learning.host.projectRoot()).some(skill => skill.id === id)) return
  const now = await $.clock.now()
  await updateLearningLibrary($, learning, library => recordSkillUse(library, id, learning.host.projectRoot(), now))
}
