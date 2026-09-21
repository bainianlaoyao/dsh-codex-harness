/**
 * Goal-round audit over the local DSH session store.
 *
 * Why this exists: the goal-round driver admits a round when `agent.status` is
 * "idle" (`dsh-goal-round-driver` `readyToDrive`), and it does not ask whether
 * that agent still owns running work. A Codex-shaped tool surface makes that gap
 * load-bearing: `exec_command` yields after 10-30 s, so any longer command
 * becomes a background job, the model ends its turn to wait for it (the
 * `dsh-tool-jobs` prompt section tells it not to busy-poll), and the driver
 * admits a round whose only action is another `job_output` wait. The round
 * budget pays for waiting, and each wait leaves a retained `<goal_round>` block
 * in history.
 *
 * This script measures that from the durable session logs, so the claim can be
 * re-run instead of taken on faith. It reports, per EFFECTIVE preset (a session
 * records its creation preset in the header and every mid-life switch in
 * `agent-preset/selected`, and the two disagree often enough to matter):
 *
 *   rounds        `<goal_round>` injections in the session
 *   waitRounds    rounds whose first tool call only waits on work already
 *                 running (`job_output` with `wait: true`, or `write_stdin`)
 *   liveAtEnd     turns whose last tool result left an exec session running
 *                 ("Process running with session ID …"), Codex surface only
 *
 * Usage:
 *   node scripts/goal-round-audit.mjs                       # every session
 *   node scripts/goal-round-audit.mjs --dsh-home D:\other\.dsh
 *   node scripts/goal-round-audit.mjs --session 743812d8    # one session, detailed
 *
 * The session store is append-only JSONL compressed into MANY concatenated zstd
 * frames (one per flush), and `zlib.zstdDecompressSync` decodes only the first
 * frame — hence the frame walk below. Node 24 is required for zstd in `node:zlib`.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const RUNNING_RE = /Process running with session ID (\w+)/
const EXITED_RE = /Process exited with code -?\d+/
const SESSION_FILES = ['session.v3.jsonl.zstd', 'session.jsonl.zstd']

function parseArgs(argv) {
  const options = { dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'), session: undefined }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dsh-home') options.dshHome = argv[++i]
    else if (argv[i] === '--session') options.session = argv[++i]
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  return options
}

/** Decode every concatenated zstd frame, skipping anything that is not one. */
function decodeFrames(buffer) {
  const starts = []
  let at = 0
  while ((at = buffer.indexOf(ZSTD_MAGIC, at)) !== -1) {
    starts.push(at)
    at += ZSTD_MAGIC.length
  }
  const parts = []
  for (let index = 0; index < starts.length; index++) {
    let decoded = false
    for (let span = 1; span <= 4 && index + span <= starts.length && !decoded; span++) {
      const end = index + span < starts.length ? starts[index + span] : buffer.length
      try {
        parts.push(zstdDecompressSync(buffer.subarray(starts[index], end)))
        decoded = true
        index += span - 1
      } catch {}
    }
    if (!decoded) parts.push(Buffer.alloc(0))
  }
  return Buffer.concat(parts).toString('utf8')
}

function readRecords(dir) {
  const records = []
  for (const name of SESSION_FILES) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    for (const line of decodeFrames(readFileSync(file)).split('\n')) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line))
      } catch {}
    }
  }
  records.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  return records
}

function sessionDirs(root) {
  const dirs = []
  for (const workspace of readdirSync(root)) {
    const workspaceDir = join(root, workspace)
    if (!statSync(workspaceDir).isDirectory()) continue
    for (const entry of readdirSync(workspaceDir)) {
      const dir = join(workspaceDir, entry)
      if (statSync(dir).isDirectory()) dirs.push(dir)
    }
  }
  return dirs
}

/** Effective preset: the newest mid-life switch, else the creation header. */
function effectivePreset(records, header) {
  const switches = records.filter((record) => record.type === 'agent-preset/selected')
  const last = switches[switches.length - 1]
  return last === undefined ? header.agentPreset : last.data.agentPreset
}

/** Whether one round's first tool call only waits on work that is already running. */
function isWaitCall(call) {
  const name = call?.data?.name
  const args = String(call?.data?.arguments ?? '')
  if (name === 'write_stdin') return true
  return name === 'job_output' && /"wait"\s*:\s*true/.test(args)
}

function analyse(records, header) {
  const events = records.filter((record) => ['turn/end', 'tool/result', 'tool/call', 'agent/inbox/spliced'].includes(record.type))
  const live = new Map()
  const rounds = []
  let turnEnds = 0
  let turnsEndedWithLiveSession = 0

  for (let index = 0; index < events.length; index++) {
    const record = events[index]
    const raw = JSON.stringify(record)
    if (record.type === 'tool/result') {
      const running = raw.match(RUNNING_RE)
      if (running !== null) live.set(running[1], record.time)
      for (const id of [...live.keys()]) {
        if (new RegExp(`session ID ${id}`).test(raw) && EXITED_RE.test(raw)) live.delete(id)
      }
      continue
    }
    if (record.type === 'turn/end') {
      turnEnds += 1
      if (live.size > 0) turnsEndedWithLiveSession += 1
      continue
    }
    if (record.type !== 'agent/inbox/spliced' || !raw.includes('<goal_round>')) continue
    const first = events.slice(index + 1).find((candidate) => candidate.type === 'tool/call')
    const number = raw.match(/Round:\s*(\d+)\/(\d+)/)
    rounds.push({
      round: number === null ? '?' : Number(number[1]),
      budget: number === null ? '?' : Number(number[2]),
      at: record.time,
      wait: isWaitCall(first),
      firstTool: first?.data?.name ?? '(none)',
      liveSessions: live.size,
    })
  }

  return {
    id: header.id,
    cwd: header.cwd,
    createdAt: header.createdAt,
    preset: effectivePreset(records, header),
    model: records.find((record) => record.type === 'model/selection')?.data?.model ?? '(unrecorded)',
    codexSurface: records.some((record) => record.type === 'tool/call' && record.data?.name === 'exec_command'),
    rounds,
    turnEnds,
    turnsEndedWithLiveSession,
  }
}

const options = parseArgs(process.argv.slice(2))
const root = join(options.dshHome, 'sessions')
if (!existsSync(root)) throw new Error(`no session store at ${root}`)

const sessions = []
for (const dir of sessionDirs(root)) {
  const records = readRecords(dir)
  const header = records.find((record) => record.type === 'session')
  if (header === undefined) continue
  if (options.session !== undefined && !String(header.id).includes(options.session)) continue
  const result = analyse(records, header)
  if (options.session === undefined && result.rounds.length === 0) continue
  sessions.push(result)
}

if (options.session !== undefined) {
  for (const session of sessions) {
    console.log(`\n${session.id}  preset=${session.preset}  model=${session.model}`)
    console.log(`cwd=${session.cwd}  created=${new Date(session.createdAt).toISOString()}`)
    console.log(`turn ends: ${session.turnEnds} (${session.turnsEndedWithLiveSession} with an exec session still running)`)
    console.log(`goal-round injections: ${session.rounds.length}`)
    for (const round of session.rounds) {
      const seconds = ((round.at - session.createdAt) / 1000).toFixed(0)
      console.log(
        `  round ${String(round.round).padStart(3)}/${round.budget}  t+${seconds}s  first tool: ${round.firstTool}`
        + `${round.wait ? '  <- WAIT ROUND (no progress)' : ''}`
        + `${round.liveSessions > 0 ? `  (${round.liveSessions} exec session(s) still live)` : ''}`,
      )
    }
  }
  if (sessions.length === 0) console.log('no session matched')
  process.exit(0)
}

sessions.sort((a, b) => b.rounds.length - a.rounds.length)
console.log('sessions with goal rounds — waiting rounds are rounds whose first tool call only waits:')
console.log('preset               model                    rounds  wait  liveEnd/turns   started           cwd')
for (const session of sessions) {
  const waits = session.rounds.filter((round) => round.wait).length
  // The live-session column only means something on the Codex exec surface: the
  // marker it counts ("Process running with session ID …") is that tool's.
  const live = session.codexSurface
    ? `${session.turnsEndedWithLiveSession}/${session.turnEnds}`
    : '-'
  console.log(
    ' ', String(session.preset).padEnd(20),
    String(session.model).slice(0, 24).padEnd(24),
    String(session.rounds.length).padStart(6),
    String(waits).padStart(5),
    live.padStart(14),
    new Date(session.createdAt).toISOString().slice(0, 16),
    String(session.cwd ?? '').slice(0, 22),
  )
}

const perPreset = new Map()
for (const session of sessions) {
  const entry = perPreset.get(session.preset) ?? { sessions: 0, rounds: 0, waits: 0, liveEnd: 0, turns: 0 }
  entry.sessions += 1
  entry.rounds += session.rounds.length
  entry.waits += session.rounds.filter((round) => round.wait).length
  entry.liveEnd += session.turnsEndedWithLiveSession
  entry.turns += session.turnEnds
  perPreset.set(session.preset, entry)
}
console.log('\nper effective preset:')
for (const [preset, entry] of perPreset) {
  const share = entry.rounds === 0 ? 0 : Math.round((100 * entry.waits) / entry.rounds)
  console.log(
    ` ${preset.padEnd(20)} sessions=${entry.sessions} rounds=${entry.rounds}`
    + ` waitRounds=${entry.waits} (${share}%)`
    + ` turnsEndedWithLiveExecSession=${entry.liveEnd}/${entry.turns}`,
  )
}
