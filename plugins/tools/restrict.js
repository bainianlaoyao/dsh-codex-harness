/** Hide the host shell and its guidance only in this preset's scope. */
import { scopeOf } from '@deepseek-ai/dsh-scope'
export const name = 'tool-codex-restrict'
export const inject = ['tools']
export function apply(ctx) {
  if (ctx.tools.view(scopeOf(ctx)).restrictableNames.has('bash')) ctx.tools.restrict({ deny: ['bash'] })
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    return assembly.tools.some(tool => tool.name === 'bash') ? assembly
      : { ...assembly, sections: assembly.sections.filter(section => section.name !== 'tool:bash') }
  })
}
