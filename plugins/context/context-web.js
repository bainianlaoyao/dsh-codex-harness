/** Browser-authenticated read-only session context endpoint. Installed once on
 * the host, never in a per-agent preset (where exact routes would collide). */
import { readContextState } from './context-state.js'
import z from '@deepseek-ai/schemastery'
import { budgetFor, notePage, windowsPage } from './context-tools.js'

export const name = 'codex-context-web'
export const inject = ['connection', 'sessions', 'sessionQuery', 'tokenMeter', 'llm', 'sessionProjections']

export function apply(ctx) {
  ctx.sessionProjections.register({ key: 'codexContextVersion', stateVersion: 1,
    stateSchema: z.number(), init: () => 0,
    apply: (state, event) => ['tool/result', 'compaction/end', 'turn/end'].includes(event.type) ? event.seq + 1 : state,
    wire: { viewSchema: z.number(), view: state => state },
  })
  ctx.connection.fetch.register({
    path: '/api/codex-context.state', methods: ['GET', 'HEAD'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const params = new URL(request.url).searchParams
        const raw = params.get('sessionId')
        if (typeof raw !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(raw)) return json({ error: 'Invalid sessionId' }, 400)
        let session = ctx.sessions.get(raw)
        let observation
        if (!session) {
          // readSession() uses detached Session.create and rejects some valid
          // persisted fork suffixes. observeSession restores with the storage
          // eventState and gives us an immutable cut, without activating agent.
          observation = await ctx.sessionQuery.observeSession(raw, { signal: request.signal, projectionMode: 'none' })
          const events = observation.events
          session = { id: raw, header: observation.header, seq: events.length,
            snapshotEvents: (from = 0, until = events.length) => events.slice(from, until) }
        }
        try {
          if (!session || session.header.agentPreset !== 'codex') return json({ enabled: false }, 404)
          const state = readContextState(session)
          if (request.method === 'HEAD') return new Response(null, { status: state.mode === 'notes' ? 204 : 404,
            headers: { 'cache-control': 'no-store' } })
          if (state.mode !== 'notes') return json({ enabled: false })
          const budget = observation ? { known: false, capacity: null, estimatedUsed: null,
            estimatedRemaining: null, explanation: 'Cold session: live budget unavailable until resume.' }
            : await budgetFor(ctx, session, request.signal)
          Object.assign(budget, latestReportedBudget(session, state.windows.at(-1)?.seq ?? 0))
          const page = notePage(session, { cursor: params.get('noteCursor') || undefined }, false)
          const timeline = windowsPage(session, { offset: Number(params.get('windowOffset') || 0) })
          return json({ enabled: true, windowId: state.windowId, ...timeline,
            note: { revision: state.noteRevision, windowId: state.noteOwnerWindowId,
              read: state.noteRead, content: page.text, nextCursor: page.nextCursor }, budget,
            fallback: state.windows.some(window => window.kind === 'summary-fallback'),
            warning: 'Deleting the active Note does not erase copies in append-only tool logs, exports, or backups.' })
        } finally { observation?.[Symbol.dispose]?.() }
      } catch (error) {
        ctx.logger.warn(`codex context view failed: ${error instanceof Error ? error.message : String(error)}`)
        return json({ error: 'Context view unavailable' }, 500)
      }
    },
  })
}

/** The cached model-visible estimate is distinct from the live meter. Only a
 * successful own tool result IN THIS WINDOW counts as a model tool report. */
export function latestReportedBudget(session, fromSeq) {
  const events = session.snapshotEvents(fromSeq)
  const calls = new Set()
  for (const event of events) if (event.type === 'tool/call' && event.data.name === 'get_context_remaining') calls.add(event.data.callId)
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event.type !== 'tool/result' || !calls.has(event.data.message?.source?.callId)) continue
    const message = event.data.message
    const block = message.role === 'tool' ? message : message.content?.[0]
    if (!block || block.isError) continue
    try {
      const text = block.content?.find(part => part.type === 'text')?.text
      const parsed = JSON.parse(text)
      if (!Number.isSafeInteger(parsed.estimatedRemaining) || !Number.isSafeInteger(parsed.capacity)) continue
      return { modelRemaining: parsed.estimatedRemaining, toolCapacity: parsed.capacity, modelUpdatedAt: event.time }
    } catch { /* An older result renderer may not contain structured JSON. */ }
  }
  return {}
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  } })
}
