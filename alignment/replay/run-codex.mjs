/**
 * dsh-codex — replay one trajectory on the OFFICIAL codex CLI (part 3).
 *
 * Spawns `codex exec --json` with a dedicated CODEX_HOME whose config
 * routes the model to the trajectory mock server (Responses API,
 * approval never, sandbox danger-full-access, apply_patch_freeform +
 * unified_exec + plan_tool + view_image_tool features). The tool calls
 * execute against the REAL codex harness; only the model output is mocked.
 *
 * Captures:
 *   <out>/codex-events.jsonl   the --json event stream
 *   <out>/codex-context.jsonl  canonical conversation (from the mock
 *                              request log + final assistant message)
 *   <out>/codex-stdout.txt / codex-stderr.txt
 *
 * Usage: node run-codex.mjs <trajectory.json> <out-dir>
 * Env: REPLAY_MOCK_BASE_URL, CODEX_BIN (default: where codex),
 *      REPLAY_CODEX_HOME (default <repo>/alignment/replay/.codex-home)
 *
 * @module dsh-codex/alignment/replay/run-codex
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CODEX_HOME = join(__dirname, ".codex-home")

/** Write the static replay config into the dedicated codex home. */
export function ensureCodexHome(codexHome = DEFAULT_CODEX_HOME, mockBaseUrl = "http://127.0.0.1:18923/v1") {
  mkdirSync(codexHome, { recursive: true })
  const cfg = [
    "model_provider = \"mock\"",
    "model = \"gpt-5.2-codex\"",
    "approval_policy = \"never\"",
    "sandbox_mode = \"danger-full-access\"",
    "skip_git_repo_check = true",
    "suppress_unstable_features_warning = true",
    "disable_response_storage = true",
    "",
    "[model_providers.mock]",
    "name = \"Mock\"",
    `base_url = "${mockBaseUrl}"`,
    "wire_api = \"responses\"",
    "requires_openai_auth = false",
    "experimental_bearer_token = \"mock-token\"",
    "",
    "[features]",
    "apply_patch_freeform = true",
    "unified_exec = true",
    "plan_tool = true",
    "view_image_tool = true",
    "multi_agent = false",
    "",
    "[history]",
    "persistence = \"none\"",
    "",
    "[telemetry]",
    "enabled = false",
  ].join("\n")
  writeFileSync(join(codexHome, "config.toml"), cfg)
  return codexHome
}

function findCodexBin() {
  if (process.env.CODEX_BIN && existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN
  const candidates = [
    'C:/Users/30280/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js',
  ]
  for (const c of candidates) if (existsSync(c)) return c
  try {
    const out = execFileSync('where', ['codex'], { encoding: 'utf8' })
    const first = out.split(/\r?\n/).find(Boolean)
    if (first) return first
  } catch {}
  throw new Error('codex binary not found; set CODEX_BIN')
}

/**
 * Build the canonical conversation for codex from the mock request log
 * (what the model saw) plus the final assistant message from the events.
 *
 * Request items are NOT in conversation order (codex sends the assistant
 * message item AFTER the function_call item), so each request contributes
 * only its NEW items (seen-set dedupe across requests) and they are
 * reordered: user texts, then assistant texts, then tool calls, then tool
 * results. Codex-injected <environment_context> user messages are dropped
 * (counted as injected by the comparator on the DSH side).
 */
export function codexContextFromLogs(requestLogPath, eventsPath) {
  const lines = [];
  const seen = new Set();
  const log = existsSync(requestLogPath)
    ? readFileSync(requestLogPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  for (const entry of log) {
    const input = entry.body?.input ?? [];
    const newUsers = [];
    const newAssistants = [];
    const newCalls = [];
    const newResults = [];
    for (const item of input) {
      const projected = projectResponsesItem(item);
      if (projected === null) continue;
      if (projected.role === "user") {
        if (projected.text.startsWith("<environment_context>")) continue; // codex-injected
        const key = "user|" + projected.text;
        if (seen.has(key)) continue;
        seen.add(key);
        newUsers.push(projected);
        continue;
      }
      // Every assistant text / tool call / tool result is re-sent in each
      // later request; the canonical conversation keeps each once.
      const key = JSON.stringify(projected);
      if (seen.has(key)) continue;
      seen.add(key);
      if (projected.role === "assistant") newAssistants.push(projected);
      else if (projected.role === "tool-call") newCalls.push(projected);
      else if (projected.role === "tool-result") newResults.push(projected);
    }
    lines.push(...newUsers, ...newAssistants, ...newCalls, ...newResults);
  }
  const finalText = finalAssistantFromEvents(eventsPath);
  if (finalText !== null && JSON.stringify({ role: "assistant", text: finalText }) !== JSON.stringify(lines[lines.length - 1])) {
    lines.push({ role: "assistant", text: finalText });
  }
  return lines;
}/** Project one Responses-API input item into the canonical shape, or null. */
function projectResponsesItem(item) {
  if (item?.type === "message") {
    if (item.role !== "user" && item.role !== "assistant") return null
    const text = (item.content ?? [])
      .filter((part) => part.type === "input_text" || part.type === "output_text" || part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
    if (text === "") return null
    return { role: item.role, text }
  }
  if (item?.type === "function_call") {
    return { role: "tool-call", name: item.name, arguments: item.arguments ?? "{}", callId: item.call_id ?? item.id }
  }
  if (item?.type === "custom_tool_call") {
    return { role: "tool-call", name: item.name, arguments: typeof item.input === "string" ? item.input : JSON.stringify(item.input ?? {}), callId: item.call_id ?? item.id }
  }
  if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") {
    return { role: "tool-result", output: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""), callId: item.call_id ?? item.id }
  }
  return null
}

/** The last assistant agent_message from the codex --json event stream. */
function finalAssistantFromEvents(eventsPath) {
  if (!existsSync(eventsPath)) return null
  let last = null
  for (const l of readFileSync(eventsPath, "utf8").split("\n").filter(Boolean)) {
    try {
      const event = JSON.parse(l)
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        if (typeof event.item.text === "string" && event.item.text !== "") last = event.item.text
      }
    } catch {}
  }
  return last
}

export async function runCodex(trajectory, outDir, opts = {}) {
  const mockBase = opts.mockBaseUrl ?? process.env.REPLAY_MOCK_BASE_URL ?? "http://127.0.0.1:18923/v1"
  const codexHome = ensureCodexHome(opts.codexHome ?? process.env.REPLAY_CODEX_HOME ?? DEFAULT_CODEX_HOME, mockBase)
  const codexBin = opts.codexBin ?? findCodexBin()
  const ws = join(outDir, "ws")
  rmSync(ws, { recursive: true, force: true })
  mkdirSync(ws, { recursive: true })
  for (const f of opts.seedFiles ?? []) writeFileSync(join(ws, f.name), f.base64 ? Buffer.from(f.base64, 'base64') : f.content)
  const eventsFile = join(outDir, "codex-events.jsonl")
  rmSync(eventsFile, { force: true })
  const child = spawn(process.execPath, [codexBin, "exec", "--json", "--skip-git-repo-check", "--ephemeral", "-C", ws, trajectory.task], {
    cwd: ws,
    env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: "mock-token", NO_COLOR: "1", FORCE_COLOR: "0", ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = "", stderr = ""
  child.stdout.on("data", (d) => { stdout += d })
  child.stderr.on("data", (d) => { stderr += d })
  const exitCode = await new Promise((resolveExit) => child.on("close", resolveExit))
  writeFileSync(eventsFile, stdout)
  writeFileSync(join(outDir, "codex-stdout.txt"), stdout)
  writeFileSync(join(outDir, "codex-stderr.txt"), stderr)
  const reqLog = opts.requestLogPath ?? join(outDir, "mock-requests.jsonl")
  const context = codexContextFromLogs(reqLog, eventsFile)
  return { exitCode, context, stdout, stderr }
}

// CLI entry
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const [trajPath, outDir] = process.argv.slice(2)
  if (!trajPath || !outDir) { console.error("usage: node run-codex.mjs <trajectory.json> <out-dir>"); process.exit(2) }
  const trajectory = JSON.parse(readFileSync(trajPath, "utf8"))
  mkdirSync(outDir, { recursive: true })
  const result = await runCodex(trajectory, outDir)
  console.log("exit:", result.exitCode, "| context lines:", result.context.length)
  process.exit(result.exitCode === 0 ? 0 : 1)
}