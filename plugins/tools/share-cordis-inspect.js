/**
 * Make Host Cordis inspect-provider registration idempotent.
 *
 * `@deepseek-ai/dsh-tool-cordis` registers process-global inspect providers
 * named Service / Event / Builtin / Tool onto `ctx.cordisInspect`. The
 * shipped `cordis` preset already mounts that row, so a second creative
 * preset that also mounts `tool-cordis` fails with:
 *
 *   Host Cordis inspect provider "Service" is already registered
 *
 * Tools themselves are scope-layered and must still be mounted per preset.
 * Only the inspect-provider directory is a process singleton, so duplicate
 * first-party ids are skipped instead of aborting the preset mount.
 *
 * @module dsh-codex/tools/share-cordis-inspect
 */

export const name = 'share-cordis-inspect'
export const inject = ['cordisInspect']

const DUPLICATE = /Host Cordis inspect provider ".*" is already registered/

export function shareInspectRegister(originalRegister) {
  return function sharedRegister(registration) {
    try {
      return originalRegister(registration)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (DUPLICATE.test(message)) return () => {}
      throw error
    }
  }
}

export function apply(ctx) {
  const inspect = ctx.cordisInspect
  const originalRegister = inspect.register
  const sharedRegister = shareInspectRegister(originalRegister.bind(inspect))
  ctx.effect(() => {
    inspect.register = sharedRegister
    return () => {
      if (inspect.register === sharedRegister) inspect.register = originalRegister
    }
  }, 'share-cordis-inspect: idempotent provider register')
}
