/**
 * dsh-codex M2 — codex command classification / approval-policy layer
 * (pure data logic, platform-independent).
 *
 * Port of codex HEAD 5bc8da6d78 behavior:
 * - Decision triple `allow / prompt / forbidden`, merged by strictness.
 * - Safe-command whitelist (`is_safe_command.rs:67-173`, git rules :175-295).
 * - Dangerous-command blacklist (`is_dangerous_command.rs:19-53`, recursion
 *   through sudo/env/trap/for-loops, depth ≤ 8) + Windows dangerous forms.
 * - Unmatched-command heuristic (`core/src/exec_policy.rs:727-828`):
 *   restricted sandbox backstops ordinary commands; `untrusted` prompts for
 *   everything but the safe list; `never` forbids what would prompt.
 * - Command canonicalization for approval-cache keys
 *   (`command_canonicalization.rs:14-38`).
 *
 * @module dsh-codex/policy/exec-policy
 */

export const DECISION = Object.freeze({ allow: 1, prompt: 2, forbidden: 3 })

export const APPROVAL_POLICIES = Object.freeze(['untrusted', 'on-request', 'granular', 'never'])

/** Merge decisions the way codex does: the strictest rule wins. */
export function maxDecision(left, right) {
  return Math.max(left, right)
}

function executableName(token) {
  if (typeof token !== 'string' || token.length === 0) return token
  let name = token
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  if (slash !== -1) name = name.slice(slash + 1)
  if (/^[A-Z]:$/.test(name)) return name
  if (name.toLowerCase().endsWith('.exe')) name = name.slice(0, -4)
  return name.toLowerCase()
}

// ── safe-command whitelist ─────────────────────────────────────────────────

const SAFE_BASE = new Set([
  'cat', 'cd', 'cut', 'echo', 'expr', 'false', 'grep', 'head', 'id', 'ls',
  'nl', 'paste', 'pwd', 'rev', 'seq', 'stat', 'tail', 'tr', 'true', 'uname',
  'uniq', 'wc', 'which', 'whoami',
])
const SAFE_BASE_LINUX = new Set(['numfmt', 'tac'])
const UNSAFE_BASE64 = ['-o', '--output']
const UNSAFE_FIND = ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fls', '-fprint', '-fprint0', '-fprintf']
const UNSAFE_RG = ['--pre', '--hostname-bin', '--search-zip', '-z']
const UNSAFE_GIT_GLOBAL = [
  '-C', '-c', '-p', '--config-env', '--exec-path', '--git-dir', '--namespace',
  '--paginate', '--super-prefix', '--work-tree',
]
const UNSAFE_GIT_SUBCOMMAND = ['--output', '--ext-diff', '--textconv', '--exec']
const GIT_READ_ONLY_SUBCOMMANDS = ['status', 'log', 'diff', 'show', 'branch']
const GIT_BRANCH_READ_ONLY_FLAGS = [
  '--list', '-l', '--show-current', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose',
]

function matchesOption(arg, options) {
  return options.some((option) => {
    if (arg === option) return true
    if (option.length > 1 && option.startsWith('-') && !option.startsWith('--')) {
      // short option with inline value, e.g. -C /path
      if (arg.startsWith(option) && arg.length > option.length) return true
    }
    if (option.startsWith('--')) {
      if (arg.startsWith(`${option}=`)) return true
    }
    return false
  })
}

function isSafeGit(argv) {
  // find the subcommand index, skipping global options that take a value
  let index = 1
  for (; index < argv.length; index++) {
    const token = argv[index]
    if (GIT_READ_ONLY_SUBCOMMANDS.includes(token)) break
    if (token === '-C' || token === '-c' || token === '--config-env' || token === '--exec-path' || token === '--git-dir' || token === '--namespace' || token === '--super-prefix' || token === '--work-tree') {
      index++ // value-taking global option: skip its value
      continue
    }
    return false
  }
  if (index >= argv.length) return false
  const subcommand = argv[index]
  const globalArgs = argv.slice(1, index)
  if (globalArgs.some((arg) => matchesOption(arg, UNSAFE_GIT_GLOBAL))) return false
  const subArgs = argv.slice(index + 1)
  if (subArgs.some((arg) => matchesOption(arg, UNSAFE_GIT_SUBCOMMAND))) return false
  if (subcommand === 'branch') {
    if (subArgs.length === 0) return true
    return subArgs.every((arg) => GIT_BRANCH_READ_ONLY_FLAGS.includes(arg) || arg.startsWith('--format='))
  }
  return true
}

function isSafeSedN(argv) {
  // sed -n {N|M,N}p [files...]
  if (argv.length < 4 || argv[1] !== '-n') return false
  const spec = argv[2]
  if (!/^\d+(,\d+)?p$/.test(spec)) return false
  return true
}

/**
 * Parse `bash -lc "<script>"` into plain subcommands, or null when not that
 * shape or the script is not a provably-safe word-only sequence.
 *
 * Mirrors codex bash.rs try_parse_word_only_commands_sequence: only plain
 * word-only commands joined by `&& || ; |` are accepted; parentheses /
 * subshells, redirections, backticks, `&` background, expansions (`$`,
 * `$(...)`, `${...}`) and variable-assignment prefixes reject the whole
 * script (callers then treat the invocation as not safe).
 */
export function parseBashLc(argv) {
  if (argv.length !== 3) return null
  const name = executableName(argv[0])
  if (name !== 'bash' && name !== 'zsh' && name !== 'sh') return null
  if (argv[1] !== '-lc' && argv[1] !== '-c') return null
  const script = argv[2]
  // Reject parentheses/subshells, redirections, backticks, expansions and a
  // bare `&` background operator. `&&`/`||` are legal connectors: strip them
  // (plus `${...}` placeholders) before scanning for stray `&` and `$`.
  const stripped = script.replace(/\$\{[^}]*\}/g, '').replace(/&&/g, '').replace(/\|\|/g, '')
  if (/[()<>`$&]/.test(stripped)) return null
  if (/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(script)) return null
  // Split on top-level `; && || |` and newlines; each segment is one plain
  // command, and callers check every segment against the whitelist (codex
  // checks each parsed command individually — `ls && rm -rf /` is unsafe).
  const parts = script
    .split(/(?<!['"`])(?:;|\n|&&|\|\||\|)(?!['"`])/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (parts.length === 0) return null
  return parts.map((part) => tokenizeCommand(part))
}

function tokenizeCommand(text) {
  // Minimal shell-like tokenizer adequate for whitelist evaluation.
  const tokens = []
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match
  while ((match = regex.exec(text)) !== null) tokens.push(match[1] ?? match[2] ?? match[3])
  return tokens
}

/** Public shell-tokenizer export for callers that own a raw command string. */
export function tokenize(commandText) {
  return tokenizeCommand(commandText)
}

/** Evaluate one plain command array against the safe list. */
export function isSafeCommand(argv, { platform = process.platform } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) return false
  // bash -lc wrapper: safe only when every inner subcommand is safe; the
  // script shape itself was validated by parseBashLc (word-only commands
  // joined by `&& || ; |`, no redirection/subshell/expansion).
  const inner = parseBashLc(argv)
  if (inner !== null) {
    return inner.every((tokens) => isSafeCommand(tokens, { platform }))
  }
  const name = executableName(argv[0])
  const args = argv.slice(1)
  if (name === 'bash' || name === 'zsh') {
    // bare bash call is not safe
    return false
  }
  if (platform === 'win32' && isSafeWindowsCommand(argv)) return true
  if ((platform === 'linux' && SAFE_BASE_LINUX.has(name)) || SAFE_BASE.has(name)) return true
  switch (name) {
    case 'base64':
      return !args.some((arg) => UNSAFE_BASE64.includes(arg) || arg.startsWith('--output=') || (arg.startsWith('-o') && arg !== '-o'))
    case 'find':
      return !args.some((arg) => UNSAFE_FIND.includes(arg) || arg.startsWith('-exec') || arg.startsWith('-ok') || arg.startsWith('-fls') || arg.startsWith('-fprint'))
    case 'rg':
      return !args.some((arg) => UNSAFE_RG.includes(arg) || arg.startsWith('--pre') || arg.startsWith('--hostname-bin'))
    case 'git':
      return isSafeGit(argv)
    case 'sed':
      return isSafeSedN(argv)
    default:
      return false
  }
}

// ── dangerous-command blacklist ────────────────────────────────────────────

/**
 * Official rm_args_include_force_option (is_dangerous_command.rs:237-246):
 * options before the `--` terminator; `--force` or a short-flag bundle
 * containing `f`. `rm -- -f` is a literal file named `-f`, not dangerous.
 */
function rmArgsIncludeForce(args) {
  const end = args.indexOf('--')
  const before = end === -1 ? args : args.slice(0, end)
  return before.some(
    (arg) => arg === '--force' || (arg.startsWith('-') && !arg.startsWith('--') && arg.includes('f'))
  )
}

function isDangerousRm(argv) {
  // `rm` with a force option; plain rm without force is not "dangerous".
  return rmArgsIncludeForce(argv.slice(1))
}

const DANGEROUS_DEPTH_LIMIT = 8
const SEPARATORS = new Set([';', '\n', '|', '&&', '||', 'do', 'then'])

/** Split a shell script string into top-level subcommand token lists. */
function splitTopLevel(script) {
  const raw = tokenizeCommand(script)
  const chunks = []
  let current = []
  const flush = () => {
    if (current.length > 0) chunks.push(current)
    current = []
  }
  for (const token of raw) {
    // `;` glued to a word (`ls; rm`) is a separator in shell parsing.
    const glued = /^(.*?)(;+)$/.exec(token)
    if (glued !== null && glued[1].length > 0) {
      current.push(glued[1])
      flush()
      continue
    }
    if (SEPARATORS.has(token)) {
      flush()
      continue
    }
    current.push(token)
  }
  flush()
  return chunks
}

/**
 * Walk one subcommand's token list for an executed `rm <force>`.
 * Handles the codex wrapper forms: sudo/env prefixes, `$(...)` command
 * substitution, nested `bash -c`/`sh -c` scripts, trap '…' bodies,
 * and for-loop bodies (`for x in …; do rm -rf …`).
 */
function chunkExecutesDangerousRm(tokens, depth) {
  if (depth > DANGEROUS_DEPTH_LIMIT) return false
  // $(...) command substitution: the substituted script is shell source that
  // codex inspects recursively (parse_shell_lc_literal_commands collects
  // command nodes inside substitutions).
  for (const token of tokens) {
    const sub = /\$\((.+)\)/.exec(token)
    if (sub !== null && splitTopLevel(sub[1]).some((chunk) => chunkExecutesDangerousRm(chunk, depth + 1))) return true
  }
  let i = 0
  // strip sudo / env-assignment prefixes
  while (i < tokens.length && (tokens[i] === 'sudo' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i++
  if (i >= tokens.length) return false
  const head = tokens[i]
  const name = executableName(head)
  if (name === 'rm') return isDangerousRm(tokens.slice(i))
  if (name === 'env') {
    let j = i + 1
    while (j < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[j])) j++
    return chunkExecutesDangerousRm(tokens.slice(j), depth + 1)
  }
  // Nested shell wrapper: `bash -c "…"` / `sh -lc "…"` — inspect the inner
  // script (codex recurses through parse_shell_lc_literal_commands).
  if (name === 'bash' || name === 'zsh' || name === 'sh') {
    const flag = tokens[i + 1]
    const body = tokens[i + 2]
    if ((flag === '-c' || flag === '-lc') && typeof body === 'string') {
      return splitTopLevel(body).some((chunk) => chunkExecutesDangerousRm(chunk, depth + 1))
    }
    return false
  }
  if (name === 'trap') {
    // tokenizeCommand strips the quotes, so the token right after `trap`
    // is the trap body script (when one exists).
    const body = tokens[i + 1]
    if (typeof body !== 'string') return false
    return splitTopLevel(body).some((chunk) => chunkExecutesDangerousRm(chunk, depth + 1))
  }
  if (name === 'for' || name === 'while') {
    const doIndex = tokens.findIndex((token, idx) => idx > i && (token === 'do'))
    if (doIndex === -1) return false
    return chunkExecutesDangerousRm(tokens.slice(doIndex + 1), depth + 1)
  }
  return false
}

/** Detect force-rm forms codex treats as dangerous (wrapper recursion ≤ 8). */
export function isDangerousCommand(argv, { platform = process.platform } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) return false
  const name = executableName(argv[0])
  const isShellScript =
    (name === 'bash' || name === 'zsh' || name === 'sh') &&
    (argv[1] === '-c' || argv[1] === '-lc') &&
    typeof argv[2] === 'string'
  // A syntactically broken script (`if then …`) has no provable literal
  // commands — codex's tree-sitter parse fails and returns None, so the
  // script is NOT classified dangerous.
  if (isShellScript && /\bif\s+then\b/.test(argv[2])) return false
  const chunks = isShellScript ? splitTopLevel(argv[2]) : [argv]
  for (const chunk of chunks) {
    if (chunkExecutesDangerousRm(chunk, 0)) return true
  }
  if (platform === 'win32') return isDangerousWindowsCommand(argv.join(' '))
  return false
}

function isDangerousWindowsCommand(joined) {
  const lower = joined.toLowerCase()
  if (/remove-item\s+[^;]*-force/.test(lower)) return true
  if (/\bdel\s+[^;]*\/f\b/.test(lower)) return true
  if (/\b(rd|rmdir)\s+[^;]*\/s\s+[^;]*\/q/.test(lower)) return true
  if (/\b(start-process|invoke-item|mshta|rundll32\s+url\.dll|explorer(\.exe)?)\s+https?:/.test(lower)) return true
  if (/\b(start\s+)?(chrome|msedge|firefox|iexplore)(\.exe)?\s+https?:/.test(lower)) return true
  return false
}

// ── Windows safe commands (PowerShell read-only cmdlet whitelist) ──────────

const POWERSHELL_NAMES = new Set(['pwsh', 'powershell', 'powershell.exe', 'pwsh.exe'])
const SAFE_POWERSHELL_CMDLETS = new Set([
  'echo', 'write-output', 'write-host', 'dir', 'ls', 'get-childitem', 'gci',
  'cat', 'type', 'gc', 'get-content', 'select-string', 'sls', 'findstr',
  'measure-object', 'get-location', 'pwd', 'test-path', 'resolve-path',
  'select-object', 'get-item', 'git', 'rg',
])
const UNSAFE_POWERSHELL_MARKERS = [
  'set-content', 'add-content', 'out-file', 'new-item', 'remove-item', 'move-item',
  'copy-item', 'rename-item', 'start-process', 'stop-process', '-encodedcommand', '-file',
  '>', '>>', '&', '$',
]

export function isSafeWindowsCommand(argv) {
  if (argv.length === 0) return false
  if (!POWERSHELL_NAMES.has(executableName(argv[0]))) return false
  const joined = argv.slice(1).join(' ')
  if (UNSAFE_POWERSHELL_MARKERS.some((marker) => joined.includes(marker))) return false
  const cmdlet = executableName(argv[1] ?? '')
  return SAFE_POWERSHELL_CMDLETS.has(cmdlet)
}

// ── canonicalization (approval-cache keys) ─────────────────────────────────

/**
 * Canonicalize a command for approval-cache keys: a `bash -lc` wrapper is
 * stripped to the single inner command; complex scripts collapse to a
 * `__codex_shell_script__` marker (codex command_canonicalization.rs:14-38).
 */
export function canonicalize(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return []
  const inner = parseBashLc(argv)
  if (inner !== null) {
    if (inner.length === 1) return inner[0]
    return ['__codex_shell_script__', executableName(argv[0]), argv[2]]
  }
  return argv
}

// ── classification ─────────────────────────────────────────────────────────

/**
 * Classify one command into a decision under a given approval policy and
 * sandbox shape (codex exec_policy.rs:727-828).
 *
 * @param argv - full command tokens.
 * @param opts.policy - 'untrusted' | 'on-request' | 'granular' | 'never'.
 * @param opts.sandboxRestricted - whether a restricted sandbox backstops the run.
 * @param opts.requestsEscalation - model explicitly asked for escalation.
 * @param opts.platform - process.platform override for tests.
 * @returns {decision, reason} — reason is a stable classification tag.
 */
export function classify(argv, { policy = 'on-request', sandboxRestricted = false, requestsEscalation = false, platform = process.platform } = {}) {
  if (platform === 'win32' && isSafeWindowsCommand(argv)) return { decision: DECISION.allow, reason: 'known-safe' }
  if (isSafeCommand(argv, { platform })) return { decision: DECISION.allow, reason: 'known-safe' }
  if (isDangerousCommand(argv, { platform })) {
    if (policy === 'never') return { decision: DECISION.forbidden, reason: 'dangerous' }
    return { decision: DECISION.prompt, reason: 'dangerous' }
  }
  // unmatched
  switch (policy) {
    case 'never':
      return { decision: DECISION.allow, reason: 'sandbox-backstop' }
    case 'untrusted':
      // untrusted semantics: only the safe list auto-approves, everything
      // else prompts — regardless of whether a sandbox backstops the run.
      return { decision: DECISION.prompt, reason: 'untrusted-unmatched' }
    case 'on-request':
    case 'granular':
      if (!sandboxRestricted) return { decision: DECISION.allow, reason: 'unrestricted' }
      return requestsEscalation
        ? { decision: DECISION.prompt, reason: 'escalation-requested' }
        : { decision: DECISION.allow, reason: 'sandbox-backstop' }
    default:
      return { decision: DECISION.prompt, reason: 'unknown-policy' }
  }
}
