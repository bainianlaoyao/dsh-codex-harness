/**
 * dsh-codex — replay one trajectory on the DSH harness (part 3).
 *
 * Spawns the official dsh launcher with the headless-codex profile, whose
 * llm-responses row points at the trajectory mock server and whose
 * replay-runner mounts the codex preset and dumps the canonical conversation
 * context to REPLAY_OUT.
 *
 * Prepares, in order:
 *   1. the headless-codex profile under $DSH_HOME/profiles (copied from
 *      alignment/replay/profile);
 *   2. a REAL-DIRECTORY copy of the codex preset at
 *      $DSH_HOME/.agent-presets/replay-codex — dsh-agent-presets discovery
 *      skips junctions (Dirent.isDirectory() is false for them), so the
 *      live install also copies a real directory rather than a junction.
 *      This replay copy is a frozen alignment snapshot, not the daily preset;
 *   3. a fresh workspace directory (REPLAY_WS or <out>/ws).
 *
 * Usage: node run-dsh.mjs <trajectory.json> <out-dir>
 * Env:   REPLAY_MOCK_BASE_URL (default http://127.0.0.1:18923/v1)
 *        DSH_BIN (default the npx-installed dsh launcher)
 * Writes: <out-dir>/dsh-context.jsonl (canonical conversation)
 *         <out-dir>/dsh-run.jsonl  (mock request log)
 *         <out-dir>/dsh-stdout.txt / dsh-stderr.txt
 *
 * @module dsh-codex/alignment/replay/run-dsh
 */

import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publishCodexPreset } from '../../plugins/preset-publisher.js'

const __dirname = dirname(fileURLToPath(import.meta.url))


const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE_SRC = join(__dirname, 'profile')
const PRESET_SRC = join(__dirname, '..', '..', 'agent-presets', 'codex')
const PRESET_ID = process.env.REPLAY_PRESET ?? 'replay-codex'

function syncPreset() {
  const target = join(DSH_HOME, '.agent-presets', PRESET_ID)
  rmSync(target, { recursive: true, force: true })
  publishCodexPreset({ sourceDir: PRESET_SRC, targetDir: target })
  // Keep the frozen snapshot labelled as a replay copy so the daily picker
  // does not present it as "codex 工具模式". Relabel after publish so the
  // publisher's "codex 工具模式" adoption heuristic does not reclaim it.
  writeFileSync(join(target, 'preset.yml'), [
    'name: codex 模式（replay 历史快照）',
    'description: 与 codex 工具模式同内容的独立副本，供 alignment/replay 冻结对照使用；不是日常编码预设。',
    'order: 5',
    '',
  ].join('\n'), { encoding: 'utf8' })
  return target
}

function ensureProfile() {
  const profileDir = join(DSH_HOME, 'profiles', 'headless-codex')
  mkdirSync(profileDir, { recursive: true })
  cpSync(join(PROFILE_SRC, 'package.json'), join(profileDir, 'package.json'), { force: true })
  cpSync(join(PROFILE_SRC, 'cordis.patch.yml'), join(profileDir, 'cordis.patch.yml'), { force: true })
  return profileDir
}

export async function runDsh(trajectory, outDir, opts = {}) {
  const mockBase = opts.mockBaseUrl ?? process.env.REPLAY_MOCK_BASE_URL ?? 'http://127.0.0.1:18923/v1'
  const dshBin = opts.dshBin ?? process.env.DSH_BIN ?? findDshBin()
  const ws = join(outDir, 'ws')
  rmSync(ws, { recursive: true, force: true })
  mkdirSync(ws, { recursive: true })
  for (const f of opts.seedFiles ?? []) {
    writeFileSync(join(ws, f.name), f.base64 ? Buffer.from(f.base64, 'base64') : f.content)
  }
  const contextFile = join(outDir, 'dsh-context.jsonl')
  rmSync(contextFile, { force: true })
  ensureProfile()
  syncPreset()
  const task = trajectory.task
  const child = spawn(process.execPath, [dshBin, '--profile', 'headless-codex', task], {
    cwd: ws,
    env: {
      ...process.env,
      REPLAY_MOCK_BASE_URL: mockBase,
      REPLAY_OUT: contextFile,
      REPLAY_WS: ws,
      REPLAY_PROVIDER: 'openai-responses',
      REPLAY_MODEL: 'gpt-5-codex',
      OPENAI_API_KEY: 'mock-token',
      DSH_TELEMETRY_DISABLED: '1',
      ...opts.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  const exitCode = await new Promise((resolveExit) => child.on('close', resolveExit))
  writeFileSync(join(outDir, 'dsh-stdout.txt'), stdout)
  writeFileSync(join(outDir, 'dsh-stderr.txt'), stderr)
  const context = existsSync(contextFile)
    ? readFileSync(contextFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : null
  return { exitCode, context, stdout, stderr }
}

function findDshBin() {
  // The npx-installed launcher used by this deployment.
  const candidates = [
    'C:/Users/30280/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ]
  for (const c of candidates) if (existsSync(c)) return c
  // PATH fallback
  try {
    const out = execFileSync('where', ['dsh'], { encoding: 'utf8' })
    const first = out.split(/\r?\n/).find(Boolean)
    if (first) return first
  } catch {}
  throw new Error('dsh launcher not found; set DSH_BIN')
}

// CLI entry: node run-dsh.mjs <trajectory.json> <out-dir>
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const [trajPath, outDir] = process.argv.slice(2)
  if (!trajPath || !outDir) {
    console.error('usage: node run-dsh.mjs <trajectory.json> <out-dir>')
    process.exit(2)
  }
  const trajectory = JSON.parse(readFileSync(trajPath, 'utf8'))
  mkdirSync(outDir, { recursive: true })
  const result = await runDsh(trajectory, outDir)
  console.log('exit:', result.exitCode)
  if (result.context) console.log('context lines:', result.context.length)
  process.exit(result.exitCode === 0 ? 0 : 1)
}
