/**
 * dsh-codex — tool-surface restriction for codex mode.
 *
 * Hides the HOST-GLOBAL `bash` tool from codex sessions. The host composition
 * (dsh-base bundle) ships `tool-bash` ENABLED for DSH-native presets, and
 * scoped tool catalogs include global registrations unless restricted — so
 * without this row a codex session would see `bash` beside `exec_command`,
 * and commands run through `bash` would BYPASS the codex approval gate that
 * lives on exec_command (tools/exec-command.js). codex HEAD's tool surface
 * has no `bash` tool: the only terminal tools are exec_command/write_stdin.
 *
 * `deny: ['bash']` requires the name to be known in the global registry; on
 * this deployment host tool-bash is enabled, so it resolves. A deployment
 * where host tool-bash is disabled should drop this row (the deny would then
 * fail loudly at preset mount).
 *
 * @module dsh-codex/tools/restrict
 */

export const name = 'tool-codex-restrict'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.restrict({ deny: ['bash'] })
}
