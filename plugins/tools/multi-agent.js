/**
 * dsh-codex M2/P1 — codex Collab V1 tool set over the DSH subagent seam.
 *
 * Maps codex HEAD's `multi_agent_v1` namespace tools (spawn_agent, send_input,
 * resume_agent, wait_agent, close_agent) onto `ctx.subagents`
 * (startContinuable / followup / interrupt / the agent registry). Flat tool
 * names (DSH tools are not namespaced); schema fields follow the codex specs
 * (multi_agents_spec.rs) with unrepresentable fields documented:
 * - `agent_type` / `service_tier` / `reasoning_effort`: accepted for schema
 *   parity, ignored (DSH AgentOptions only carries provider/model/maxTokens).
 * - `resume_agent`: DSH has no pause/resume; a followup with a neutral
 *   continue message starts the next turn on the same conversation.
 * - `send_input.items`: accepted, ignored (followup carries one text message).
 *
 * @module dsh-codex/tools/multi-agent
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'

export const name = 'tool-codex-multi-agent'
export const inject = ['tools', 'subagents']

const WAIT_POLL_MS = 250

function registerMultiAgentTools(ctx, config) {
  const provider = config.provider ?? 'spawn'

  ctx.tools.register(
    defineTool({
      name: 'spawn_agent',
      description:
        'Spawn a subagent to work on a task independently. Returns an agent id for send_input / resume_agent / wait_agent / close_agent. ' +
        '(DSH mapping of codex multi_agent_v1.spawn_agent: the child is a continuable subagent on the ' + provider + ' provider.)',
      parameters: {
        message: { type: 'string', required: true, description: 'The initial task message for the subagent.' },
        agent_type: { type: 'string', description: 'Accepted for codex schema parity; ignored (DSH uses the configured provider).' },
        model: { type: 'string', description: 'Optional model id for the subagent (maps to AgentOptions.model).' },
        service_tier: { type: 'string', description: 'Accepted for codex schema parity; ignored.' },
        reasoning_effort: { type: 'string', description: 'Accepted for codex schema parity; ignored.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            agent_id: { type: 'string', required: true },
            message_id: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `spawned agent ${value.agent_id}` }],
      },
      async execute(args, exec) {
        const parent = exec.agent
        if (parent === undefined) throw new Error('spawn_agent requires a calling agent')
        const started = await ctx.subagents.startContinuable({
          provider,
          label: 'codex spawn_agent',
          request: {
            label: 'codex spawn_agent',
            prompt: [{ type: 'text', text: args.message }],
            parent,
            ...(typeof args.model === 'string' && args.model.length > 0 ? { agentOptions: { model: args.model } } : {}),
          },
          signal: exec.signal,
        })
        return { agent_id: String(started.childId), ...(started.messageId === undefined ? {} : { message_id: String(started.messageId) }) }
      },
      presentCall: (args) => ({ card: 'generic', title: 'Spawn agent', kind: 'other', rawInput: args.message }),
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'send_input',
      description:
        'Deliver one message to a spawned agent as its next turn. When `interrupt` is true, the current turn is cancelled first. ' +
        'Returns only delivery confirmation (codex multi_agent_v1.send_input).',
      parameters: {
        target: { type: 'string', required: true, description: 'The agent id returned by spawn_agent.' },
        message: { type: 'string', description: 'The message to deliver.' },
        items: { type: 'array', description: 'Accepted for codex schema parity; ignored (DSH followup carries one text message).', items: { type: 'json' } },
        interrupt: { type: 'boolean', description: 'Cancel the target\'s current turn before delivering (default false).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { message_id: { type: 'string' } },
        },
        render: (args, _value) => [{ type: 'text', text: `message queued as the next turn for agent ${args.target}` }],
      },
      async execute(args, exec) {
        const parent = exec.agent
        if (parent === undefined) throw new Error('send_input requires a calling agent')
        const id = SessionId(args.target)
        if (args.interrupt === true) ctx.subagents.interrupt(id, { kind: 'ancestor', agent: parent })
        const text = typeof args.message === 'string' && args.message.length > 0 ? args.message : 'Continue.'
        const messageId = await ctx.subagents.followup(parent, id, [{ type: 'text', text }], {
          source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
          signal: exec.signal,
        })
        return { message_id: String(messageId) }
      },
      presentCall: (args) => ({ card: 'generic', title: `Send input → agent ${args.target}`, kind: 'other', rawInput: args.message ?? '' }),
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'resume_agent',
      description:
        'Resume an agent that is idle between turns by starting its next turn with a neutral continue message. ' +
        '(codex multi_agent_v1.resume_agent; DSH has no pause/resume, so this is a followup wake.)',
      parameters: {
        id: { type: 'string', required: true, description: 'The agent id returned by spawn_agent.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { message_id: { type: 'string' } },
        },
        render: (args, _value) => [{ type: 'text', text: `resumed agent ${args.id}` }],
      },
      async execute(args, exec) {
        const parent = exec.agent
        if (parent === undefined) throw new Error('resume_agent requires a calling agent')
        const id = SessionId(args.id)
        const messageId = await ctx.subagents.followup(parent, id, [{ type: 'text', text: 'Continue.' }], {
          source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
          signal: exec.signal,
        })
        return { message_id: String(messageId) }
      },
      presentCall: (args) => ({ card: 'generic', title: `Resume agent ${args.id}`, kind: 'other', rawInput: '' }),
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'wait_agent',
      description:
        'Wait until the named agents are idle (their current turn settles). Returns each agent\'s observed status. ' +
        '(codex multi_agent_v1.wait_agent; timeout range 10s-1h.)',
      parameters: {
        agents: { type: 'array', description: 'Agent ids to wait for.', items: { type: 'string' } },
        task_ids: { type: 'array', description: 'Accepted for codex schema parity; ignored.', items: { type: 'string' } },
        timeout_ms: { type: 'number', description: 'Maximum wait (default 30000, range 10000-3600000).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            agents: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  status: { type: 'string', required: true },
                },
              },
            },
            timed_out: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.timed_out
              ? `wait timed out; statuses: ${value.agents.map((entry) => `${entry.id}=${entry.status}`).join(', ')}`
              : `agents settled: ${value.agents.map((entry) => `${entry.id}=${entry.status}`).join(', ')}`,
          },
        ],
      },
      async execute(args, exec) {
        const ids = Array.isArray(args.agents) ? args.agents.filter((id) => typeof id === 'string') : []
        if (ids.length === 0) return { agents: [], timed_out: false }
        const agents = ctx.get('agents')
        if (agents === undefined) throw new Error('wait_agent: the agent registry is unavailable')
        const timeout = Math.min(Math.max(Number(args.timeout_ms) || 30000, 10000), 3600000)
        const deadline = Date.now() + timeout
        const statusOf = (id) => {
          const agent = agents.get(SessionId(id))
          if (agent === undefined) return 'unknown'
          return agent.status
        }
        while (true) {
          const statuses = ids.map((id) => ({ id, status: statusOf(id) }))
          if (statuses.every((entry) => entry.status === 'idle' || entry.status === 'unknown')) return { agents: statuses, timed_out: false }
          if (Date.now() >= deadline) return { agents: statuses, timed_out: true }
          await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS))
        }
      },
      presentCall: (args) => ({ card: 'generic', title: 'Wait for agents', kind: 'other', rawInput: args.agents ?? [] }),
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'close_agent',
      description:
        'Request cancellation of an agent\'s current turn. Fire-and-return: the agent may keep running briefly; ' +
        'already-finished targets are accepted no-ops (codex multi_agent_v1.close_agent).',
      parameters: {
        target: { type: 'string', required: true, description: 'The agent id to close.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { accepted: { type: 'boolean', required: true } },
        },
        render: (args, _value) => [{ type: 'text', text: `close requested for agent ${args.target}` }],
      },
      execute(args, exec) {
        const parent = exec.agent
        if (parent === undefined) throw new Error('close_agent requires a calling agent')
        ctx.subagents.interrupt(SessionId(args.target), { kind: 'ancestor', agent: parent })
        return Promise.resolve({ accepted: true })
      },
      presentCall: (args) => ({ card: 'generic', title: `Close agent ${args.target}`, kind: 'other', rawInput: '' }),
    })
  )
}

export const Config = z.object({
  provider: z.string().default('spawn'),
})

export function apply(ctx, config) {
  registerMultiAgentTools(ctx, { provider: config.provider ?? 'spawn' })
}
