/**
 * dsh-codex — replay runner (part 3 trajectory harness).
 *
 * A headless one-shot Agent driver with three differences from
 * @deepseek-ai/dsh-headless:
 *   1. mounts the codex agent preset (`agentPresets.mount`) so the session
 *      runs the codex tool surface;
 *   2. the provider/model come from REPLAY_PROVIDER / REPLAY_MODEL (the
 *      headless-codex profile's llm-responses row points at the trajectory
 *      mock server), not the persisted settings;
 *   3. after the run, the canonical conversation context is dumped to
 *      REPLAY_OUT as JSONL so the comparator can diff it against the codex
 *      CLI's context for the same trajectory.
 *
 * Context dump shape (one JSON object per line):
 *   {"role":"user","text":...}
 *   {"role":"assistant","text":...}
 *   {"role":"tool-call","name":...,"arguments":...,"callId":...}
 *   {"role":"tool-result","callId":...,"output":...,"isError":...}
 *   {"role":"turn-end","reason":...}
 * `user/message` events carry the full block list; only text blocks are
 * projected (tool attachments are not used by the replay trajectories).
 *
 * @module dsh-codex/harness/replay-runner
 */

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'replay-runner'
export const inject = ['agentDefaultModel', 'agents', 'sessions']

export const Config = z.object({
  task: z.string().required(),
  preset: z.string().default('codex'),
  outFile: z.string(),
})

/** Project one event into the canonical context line, or null when not part of the conversation. */
function projectEvent(event, firstSeq) {
  if (event.seq < firstSeq) return null
  switch (event.type) {
    case 'user/message': {
      const text = (event.data.message?.content ?? event.data.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      return text === '' ? null : { role: 'user', text }
    }
    case 'assistant/message': {
      // Tool-call blocks are projected from the separate tool/call events
      // (they carry the same callId); only the assistant text is kept here.
      const text = (event.data.message?.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      return text === '' ? null : { role: 'assistant', text }
    }
    case 'tool/call':
      return { role: 'tool-call', name: event.data.name, arguments: event.data.arguments, callId: event.data.callId }
    case 'tool/result': {
      // DSH stores the model-facing result text nested inside a
      // tool-result block: message.content = [{type:'tool-result',
      // toolCallId, content:[{type:'text',text}], isError}]
      const message = event.data.message
      let output = ''
      let isError = false
      for (const block of message?.content ?? []) {
        if (block.type === 'tool-result') {
          isError = Boolean(block.isError)
          output += (block.content ?? [])
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('')
        }
      }
      return { role: 'tool-result', callId: message?.source?.callId ?? message?.callId, output, isError }
    }
    case 'turn/end':
      return { role: 'turn-end', reason: event.data.reason }
    default:
      return null
  }
}

function run(ctx, task, config, io) {
  (async () => {
    try {
      await ctx.get('loader')?.await()
      const agents = ctx.get('agents')
      const sessions = ctx.get('sessions')
      const presets = ctx.get('agentPresets')
      if (agents === undefined || sessions === undefined) throw new Error('replay-runner: agents/sessions unavailable')
      const presetId = config.preset ?? 'codex'
      const provider = process.env.REPLAY_PROVIDER ?? 'openai-responses'
      const model = process.env.REPLAY_MODEL ?? 'gpt-5-codex'
      const selection = { provider, model }
      const { agent } = await agents.create({
        sessionId: SessionId('session-' + randomUUID()),
        meta: { cwd: process.cwd(), agentPreset: presetId },
        agentOptions: { provider, model },
        setup: async (agentCtx) => {
          installModelSelection(agentCtx, { current: selection, assembled: undefined })
          if (presets !== undefined) await presets.mount(agentCtx, presetId)
        },
      })
      await agent.whenIdle()
      const firstSeq = agent.session.seq
      agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))
      await agent.whenIdle()
      await sessions.flush(agent.session)
      const out = []
      for (const event of agent.session.events) {
        const projected = projectEvent(event, firstSeq)
        if (projected === null) continue
        if (Array.isArray(projected)) out.push(...projected)
        else out.push(projected)
      }
      const outFile = config.outFile ?? process.env.REPLAY_OUT
      if (outFile !== undefined) writeFileSync(outFile, out.map((l) => JSON.stringify(l)).join('\n') + '\n')
      io.stdout.write('replay-runner: done\n')
      io.exit(0)
    } catch (error) {
      io.stderr.write('dsh: ' + (error instanceof Error ? error.message : String(error)) + '\n')
      io.exit(1)
    }
  })().catch((error) => {
    io.stderr.write('dsh: ' + (error instanceof Error ? error.message : String(error)) + '\n')
    io.exit(1)
  })
}

export function apply(ctx, config) {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('replay-runner: the launcher must provide ctx.appExit before the tree mounts')
  const io = { stdout: process.stdout, stderr: process.stderr, exit }
  run(ctx, config.task, config, io)
}