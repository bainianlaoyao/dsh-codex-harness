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
 * - `fork_context`: true selects the DSH `fork` subagent provider — the child
 *   inherits the parent's completed-turn history, codex's fork semantics
 *   (fallback: the configured provider when the deployment registers no
 *   `fork`); false/omitted uses the configured provider (default `spawn`,
 *   a fresh history-less child).
 * - `resume_agent`: DSH has no pause/resume; a followup with a neutral
 *   continue message starts the next turn on the same conversation.
 * - `items`: validated by codex's message-vs-items rules and mapped onto the
 *   DSH text-only prompt (non-text items render as `[type] <reference>` text).
 *   Model echo noise is normalized BEFORE the codex union (same adaptation as
 *   exec_command's blank-justification exemption): an items array of all-empty
 *   stub objects next to a real message is dropped, and a blank message next
 *   to meaningful items is dropped; genuinely providing both still errors.
 * - agent statuses are the DSH registry vocabulary (running/idle/…), not the
 *   codex AgentStatus enum; status output shapes match codex's field names.
 *
 * @module dsh-codex/tools/multi-agent
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { isBlankText, stripStubEntries } from './echo-noise.js?v=2'

export const name = 'tool-codex-multi-agent'
export const inject = ['tools', 'subagents']

const WAIT_POLL_MS = 250
const MIN_WAIT_TIMEOUT_MS = 10000
const DEFAULT_WAIT_TIMEOUT_MS = 30000
const MAX_WAIT_TIMEOUT_MS = 3600000

/** Structured collab input items (codex multi_agents_spec.rs create_collab_input_items_schema). */
const COLLAB_INPUT_ITEMS_SCHEMA = {
  type: 'array',
  description: 'Structured input items. Use this to pass explicit mentions (for example app:// connector paths).',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: { type: 'string', description: 'Input item type: text, image, local_image, audio, local_audio, skill, or mention.' },
      text: { type: 'string', description: 'Text content when type is text.' },
      image_url: { type: 'string', description: 'Image URL when type is image.' },
      audio_url: { type: 'string', description: 'Audio data URL when type is audio.' },
      path: { type: 'string', description: 'Path when type is local_image/local_audio/skill, or structured mention target such as app://<connector-id> or plugin://<plugin-name>@<marketplace-name> when type is mention.' },
      name: { type: 'string', description: 'Display name when type is skill or mention.' },
    },
  },
}

/** Map codex ThreadId parsing onto DSH's identity SessionId cast. DSH session
 * ids are unconstrained strings, so the codex "invalid agent id" error only
 * surfaces if the seam ever rejects a target during the parse. */
function parseAgentIdTarget(target) {
  try {
    return SessionId(target)
  } catch (err) {
    throw new Error(`invalid agent id ${target}: ${err}`)
  }
}

function parseAgentIdTargets(targets) {
  if (targets.length === 0) throw new Error('agent ids must be non-empty')
  return targets.map(parseAgentIdTarget)
}

/** Content-bearing fields of a collab item (codex create_collab_input_items_schema). */
const COLLAB_ITEM_FIELDS = ['type', 'text', 'image_url', 'audio_url', 'path', 'name']

/**
 * Normalize model echo noise before the codex message-vs-items union — the
 * same adaptation as exec_command's blank-justification exemption: models
 * routinely echo a tool's full optional schema, so `items` filled with
 * all-empty stub objects next to a real `message` (and a blank `message`
 * next to real items) must not hard-fail the call.
 * - an items array with ≥1 entry but NO meaningful entry is treated as
 *   absent (echo stub); a deliberate `[]` keeps the codex "Items can't be
 *   empty" error;
 * - a blank/whitespace message next to meaningful items is dropped so the
 *   items win (reverse echo shape); a blank message as the ONLY input keeps
 *   the codex "Empty message can't be sent to an agent" error.
 * Genuinely providing both non-empty inputs still fails with the codex error.
 */
function normalizeCollabInput(message, items) {
  const meaningfulItems = stripStubEntries(items, COLLAB_ITEM_FIELDS)
  const hasMeaningfulItems = Array.isArray(meaningfulItems) && meaningfulItems.length > 0
  return {
    message: isBlankText(message) && hasMeaningfulItems ? undefined : message,
    items: meaningfulItems,
  }
}

/** Validate codex's message-vs-items union and return the canonical input items. */
function parseCollabInput(message, items) {
  const { message: m, items: it } = normalizeCollabInput(message, items)
  const hasMessage = m !== undefined
  const hasItems = it !== undefined
  if (hasMessage && hasItems) throw new Error('Provide either message or items, but not both')
  if (!hasMessage && !hasItems) throw new Error('Provide one of: message or items')
  if (hasMessage) {
    if (m.trim().length === 0) throw new Error("Empty message can't be sent to an agent")
    return [{ type: 'text', text: m }]
  }
  if (it.length === 0) throw new Error("Items can't be empty")
  return it
}

/** Map codex collab input items onto the DSH text-only subagent prompt. */
function inputItemsToPrompt(inputItems) {
  return inputItems.map((item) => {
    if (item.type === 'text' && typeof item.text === 'string') {
      return { type: 'text', text: item.text }
    }
    const reference = item.path ?? item.image_url ?? item.audio_url ?? item.name ?? ''
    return { type: 'text', text: `[${item.type}] ${reference}` }
  })
}

/** Observe one agent's status from the DSH registry. */
function agentStatusOf(ctx, id) {
  const agents = ctx.get('agents')
  const agent = agents?.get(id)
  return agent?.status ?? 'unknown'
}

function registerMultiAgentTools(ctx, config) {
  const provider = config.provider ?? 'spawn'

  ctx.tools.register(
    defineTool({
      name: 'spawn_agent',
      description:
        'Spawn a subagent to work on a task independently. Returns an agent id for send_input / resume_agent / wait_agent / close_agent. ' +
        '(DSH mapping of codex multi_agent_v1.spawn_agent: the child is a continuable subagent on the ' + provider + ' provider.)',
      parameters: {
        message: { type: 'string', description: 'Initial plain-text task for the new agent. Use either message or items.' },
        items: COLLAB_INPUT_ITEMS_SCHEMA,
        agent_type: { type: 'string', description: 'Accepted for codex schema parity; ignored (DSH uses the configured provider).' },
        fork_context: { type: 'boolean', description: 'True forks the current thread history into the new agent; false or omitted starts with only the initial prompt.' },
        model: { type: 'string', description: 'Optional model id for the subagent (maps to AgentOptions.model).' },
        service_tier: { type: 'string', description: 'Accepted for codex schema parity; ignored.' },
        reasoning_effort: { type: 'string', description: 'Accepted for codex schema parity; ignored.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            agent_id: { type: 'string', required: true, description: 'Thread identifier for the spawned agent.' },
            nickname: {
              oneOf: [{ type: 'string' }, { type: 'null' }],
              required: true,
              description: 'User-facing nickname for the spawned agent when available.',
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `spawned agent ${value.agent_id}` }],
      },
      async execute(args, exec) {
        const parent = exec.agent
        if (parent === undefined) throw new Error('spawn_agent requires a calling agent')
        const prompt = inputItemsToPrompt(parseCollabInput(args.message, args.items))
        // codex fork semantics: fork_context=true seeds the child with the
        // parent's completed-turn history, which the DSH `fork` provider
        // supplies; fall back to the configured provider (spawn) when the
        // deployment registers none.
        const provider =
          args.fork_context === true && ctx.subagents.getProvider?.('fork') !== undefined
            ? 'fork'
            : config.provider
        const started = await ctx.subagents.startContinuable({
          provider,
          label: 'codex spawn_agent',
          request: {
            label: 'codex spawn_agent',
            prompt,
            parent,
            ...(typeof args.model === 'string' && args.model.length > 0 ? { agentOptions: { model: args.model } } : {}),
          },
          signal: exec.signal,
        })
        return { agent_id: String(started.childId), nickname: null }
      },
      presentCall: (args) => ({ card: 'generic', title: 'Spawn agent', kind: 'other', rawInput: args.message ?? args.items ?? '' }),
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
        message: { type: 'string', description: 'Legacy plain-text message to send to the agent. Use either message or items.' },
        items: COLLAB_INPUT_ITEMS_SCHEMA,
        interrupt: { type: 'boolean', description: 'Cancel the target\'s current turn before delivering (default false).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            submission_id: { type: 'string', required: true, description: 'Identifier for the queued input submission.' },
          },
        },
        render: (args, _value) => [{ type: 'text', text: `message queued as the next turn for agent ${args.target}` }],
      },
      async execute(args, exec) {
        const parent = exec.agent
        if (parent === undefined) throw new Error('send_input requires a calling agent')
        const id = parseAgentIdTarget(args.target)
        const inputItems = parseCollabInput(args.message, args.items)
        if (args.interrupt === true) ctx.subagents.interrupt(id, { kind: 'ancestor', agent: parent })
        const submissionId = await ctx.subagents.followup(parent, id, inputItemsToPrompt(inputItems), {
          source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
          signal: exec.signal,
        })
        return { submission_id: String(submissionId) }
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
          properties: {
            status: { type: 'string', required: true, description: 'Agent status observed after the resume request.' },
          },
        },
        render: (args, _value) => [{ type: 'text', text: `resumed agent ${args.id}` }],
      },
      async execute(args, exec) {
        const parent = exec.agent
        if (parent === undefined) throw new Error('resume_agent requires a calling agent')
        const id = parseAgentIdTarget(args.id)
        await ctx.subagents.followup(parent, id, [{ type: 'text', text: 'Continue.' }], {
          source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
          signal: exec.signal,
        })
        return { status: agentStatusOf(ctx, id) }
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
        targets: { type: 'array', required: true, description: 'Agent ids to wait on. Pass multiple ids to wait for whichever finishes first.', items: { type: 'string' } },
        task_ids: { type: 'array', description: 'Accepted for codex schema parity; ignored.', items: { type: 'string' } },
        timeout_ms: { type: 'number', description: `Timeout in milliseconds. Defaults to ${DEFAULT_WAIT_TIMEOUT_MS}, min ${MIN_WAIT_TIMEOUT_MS}, max ${MAX_WAIT_TIMEOUT_MS}. Prefer longer waits (minutes) to avoid busy polling.` },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'object', required: true, additionalProperties: true, description: 'Final statuses keyed by agent id.' },
            timed_out: { type: 'boolean', required: true, description: 'Whether the wait call returned due to timeout before any agent reached a final status.' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.timed_out
              ? `wait timed out; statuses: ${Object.entries(value.status).map(([id, status]) => `${id}=${status}`).join(', ')}`
              : `agents settled: ${Object.entries(value.status).map(([id, status]) => `${id}=${status}`).join(', ')}`,
          },
        ],
      },
      async execute(args, exec) {
        const ids = parseAgentIdTargets(args.targets)
        const agents = ctx.get('agents')
        if (agents === undefined) throw new Error('wait_agent: the agent registry is unavailable')
        const rawTimeout = args.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS
        if (rawTimeout <= 0) throw new Error('timeout_ms must be greater than zero')
        const timeout = Math.min(Math.max(rawTimeout, MIN_WAIT_TIMEOUT_MS), MAX_WAIT_TIMEOUT_MS)
        const deadline = Date.now() + timeout
        const statusOf = (id) => {
          const agent = agents.get(id)
          return agent === undefined ? 'unknown' : agent.status
        }
        while (true) {
          const statuses = Object.fromEntries(ids.map((id) => [id, statusOf(id)]))
          if (Object.values(statuses).every((status) => status === 'idle' || status === 'unknown')) {
            return { status: statuses, timed_out: false }
          }
          if (Date.now() >= deadline) return { status: statuses, timed_out: true }
          await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS))
        }
      },
      presentCall: (args) => ({ card: 'generic', title: 'Wait for agents', kind: 'other', rawInput: args.targets ?? [] }),
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
          properties: {
            previous_status: { type: 'string', required: true, description: 'The agent status observed before shutdown was requested.' },
          },
        },
        render: (args, _value) => [{ type: 'text', text: `close requested for agent ${args.target}` }],
      },
      execute(args, exec) {
        const parent = exec.agent
        if (parent === undefined) throw new Error('close_agent requires a calling agent')
        const id = parseAgentIdTarget(args.target)
        const previous_status = agentStatusOf(ctx, id)
        ctx.subagents.interrupt(id, { kind: 'ancestor', agent: parent })
        return Promise.resolve({ previous_status })
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
