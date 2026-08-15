/**
 * dsh-codex — replay orchestrator (part 3): run all 10 mock
 * trajectories on BOTH harnesses and compare the two contexts.
 *
 * For each trajectory:
 *   1. start a fresh mock server (scripted model output),
 *   2. replay on the official codex CLI (run-codex.mjs),
 *   3. restart the mock, replay on the DSH headless-codex profile
 *      (run-dsh.mjs),
 *   4. canonicalize + diff the two contexts (compare-contexts.mjs).
 *
 * Usage: node replay-all.mjs [--only T4]
 * Output: alignment/replay/out/<trajectory-id>/{codex,dsh}-context.jsonl,
 *         alignment/replay/out/report.json + report.md
 *
 * @module dsh-codex/alignment/replay/replay-all
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const { trajectories } = await import('./trajectories.mjs')
const { runCodex } = await import('./run-codex.mjs')
const { runDsh } = await import('./run-dsh.mjs')
const { compareContexts } = await import('./compare-contexts.mjs')

const OUT = join(__dirname, 'out')
const BASE_PORT = Number(process.env.REPLAY_BASE_PORT ?? 18923)

/** Start one fresh mock server; returns {proc, port, stop}. */
function startMock(steps, logPath, port) {
  rmSync(logPath, { force: true })
  const child = spawn(process.execPath, [join(__dirname, "mock-server.mjs")], {
    env: { ...process.env, PORT: String(port), STEPS: JSON.stringify(steps), LOG: logPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let ready = false
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => {
      if (!ready && String(d).includes("mock listening")) { ready = true; resolve({ proc: child, port, stop: () => { try { child.kill() } catch {} } }) }
    })
    child.on("exit", (code) => { if (!ready) reject(new Error("mock exited early: " + code)) })
    setTimeout(() => { if (!ready) reject(new Error("mock did not listen")) }, 5000)
  })
}

/** Free a port by killing whatever holds it (stale mocks). */
function freePort(port) {
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" })
    for (const l of out.split(/\r?\n/)) {
      const parts = l.trim().split(/\s+/)
      if (parts[1] === "127.0.0.1:" + port && parts[4]) {
        try { execFileSync("taskkill", ["/F", "/PID", parts[4]], { stdio: "ignore" }) } catch {}
      }
    }
  } catch {}
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null

const report = { generatedAt: new Date().toISOString(), trajectories: [] }
let failed = 0

for (const trajectory of trajectories) {
  if (only && trajectory.id !== only) continue
  const outDir = join(OUT, trajectory.id)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  console.log("\n=== " + trajectory.id + " ===")
  const entry = { id: trajectory.id, task: trajectory.task }
  const seedFiles = trajectory.seedFiles ?? []
  const port = BASE_PORT
  freePort(port)
  await sleep(300)
  try {
    // official codex CLI
    const codexLog = join(outDir, "codex-mock-requests.jsonl")
    const mock1 = await startMock(trajectory.steps, codexLog, port)
    try {
      const codexResult = await runCodex(trajectory, outDir, { mockBaseUrl: "http://127.0.0.1:" + port + "/v1", requestLogPath: codexLog, seedFiles })
      entry.codex = { exitCode: codexResult.exitCode, contextLines: codexResult.context.length }
      writeFileSync(join(outDir, "codex-context.jsonl"), codexResult.context.map((l) => JSON.stringify(l)).join("\n") + "\n")
    } finally {
      mock1.stop()
    }
    await sleep(300)
    // DSH harness
    const mock2 = await startMock(trajectory.steps, join(outDir, "dsh-mock-requests.jsonl"), port)
    try {
      const dshResult = await runDsh(trajectory, outDir, { mockBaseUrl: "http://127.0.0.1:" + port + "/v1", seedFiles })
      entry.dsh = { exitCode: dshResult.exitCode, contextLines: dshResult.context?.length ?? 0 }
      if (dshResult.context) writeFileSync(join(outDir, "dsh-context.jsonl"), dshResult.context.map((l) => JSON.stringify(l)).join("\n") + "\n")
    } finally {
      mock2.stop()
    }
    // compare
    const codexCtx = readFileSync(join(outDir, "codex-context.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    const dshCtx = readFileSync(join(outDir, "dsh-context.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    const comparison = compareContexts(codexCtx, dshCtx)
    entry.comparison = comparison.stats
    entry.diffs = comparison.diffs.map((d) => ({ side: d.side, role: d.line.role, line: d.line }))
    if (comparison.stats.diffs > 0) failed++
    console.log("  codex exit=" + entry.codex.exitCode + " lines=" + entry.codex.contextLines + " | dsh exit=" + entry.dsh.exitCode + " lines=" + entry.dsh.contextLines)
    console.log("  matched=" + comparison.stats.matched + " diffs=" + comparison.stats.diffs + " (roles: " + JSON.stringify(comparison.stats.diffRoles) + ") injected-dsh=" + comparison.stats.injectedDsh)
  } catch (error) {
    entry.error = error.message
    failed++
    console.log("  ERROR: " + error.message)
  }
  report.trajectories.push(entry)
}

writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2))

// markdown report
const md = []
md.push("# dsh-codex-mode trajectory replay report")
md.push("")
md.push("Generated: " + report.generatedAt)
md.push("")
md.push("Method: each trajectory mocks ONLY the model output (scripted Responses steps); every tool call executes on the real harness. The same trajectory replays on the official codex CLI (win32, pwsh default shell) and on the DSH headless-codex profile (git bash backend). Contexts are canonicalized (user/assistant text, tool calls, tool outputs) and diffed with an LCS alignment after normalization (CRLF, wall times, chunk ids, session ids, timestamps). DSH-injected harness messages (runtime-context snapshot, skills reminder) are excluded from the strict diff and counted separately.")
md.push("")
md.push("| trajectory | codex exit | dsh exit | codex lines | dsh lines | matched | diffs | injected-dsh |")
md.push("|---|---|---|---|---|---|---|---|")
for (const e of report.trajectories) {
  if (e.error) { md.push("| " + e.id + " | ERROR: " + e.error + " |"); continue }
  const c = e.comparison
  md.push("| " + e.id + " | " + e.codex.exitCode + " | " + e.dsh.exitCode + " | " + e.codex.contextLines + " | " + e.dsh.contextLines + " | " + c.matched + " | " + c.diffs + " | " + c.injectedDsh + " |")
}
md.push("")
for (const e of report.trajectories) {
  if (!e.diffs || e.diffs.length === 0) continue
  md.push("## " + e.id + " — " + e.comparison.diffs + " differences")
  md.push("")
  for (const d of e.diffs) {
    md.push("- [" + d.side + "] (" + d.role + ") " + JSON.stringify(d.line).slice(0, 300))
  }
  md.push("")
}
md.push("## Summary: " + (report.trajectories.length - failed) + "/" + report.trajectories.length + " trajectories with zero context differences")
md.push("")
writeFileSync(join(OUT, "report.md"), md.join("\n"))

console.log("\nreport: " + join(OUT, "report.md"))
console.log("trajectories with differences: " + failed)