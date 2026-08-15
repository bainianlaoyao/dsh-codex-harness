/**
 * dsh-codex M1 — `update_plan` task-plan maintenance tool.
 *
 * Codex-parity schema (HEAD 5bc8da6d78, plan_spec.rs) with the execution
 * backend mapped onto the DSH session seam: each call appends a `plan/write`
 * snapshot to the owning agent's session, and the `plan` session projection
 * (key `plan`, last-write-wins, reset on turn start) exposes the current plan
 * to UIs, mirroring @deepseek-ai/dsh-tool-todo's `todos` projection.
 *
 * @module dsh-codex/tools/update-plan
 */

import { z } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-codex-plan'
export const inject = ['tools']

const STATUSES = ['pending', 'in_progress', 'completed']

/** Wire payload schema of the `plan` projection (whole list or pre-first-write null). */
const planProjectionSchema = z.union([
  z.array(
    z.object({
      step: z.string(),
      status: z.union([z.literal('pending'), z.literal('in_progress'), z.literal('completed')]),
    })
  ),
  z.null(),
])

/** Canonicalise and validate the model-supplied plan items. */
function toPlanList(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('invalid plan: `plan` must be a non-empty array of { step, status }')
  }
  const plan = []
  let inProgress = 0
  for (const item of raw) {
    const step = typeof item.step === 'string' ? item.step.trim() : ''
    if (step.length === 0) throw new Error('invalid plan: `step` must be a non-empty string')
    if (item.status === 'in_progress') inProgress++
    plan.push({ step, status: item.status })
  }
  if (inProgress > 1) {
    throw new Error(`invalid plan: at most one step may be in_progress (got ${inProgress})`)
  }
  return plan
}

export function apply(ctx) {
  // Register the plan projection only while the seam is composed, exactly like
  // the shipped todo tool; the unit is pure (init/apply/view), replayable, and
  // the register() disposer is returned to cordis.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register({
      key: 'plan',
      schema: planProjectionSchema,
      init: () => null,
      apply: (state, event) => {
        if (event.type === 'plan/write') return event.data.plan
        if (event.type === 'turn/start') return null
        return state
      },
      view: (state) => state,
      stateVersion: 1,
    })
  })

  ctx.tools.register(
    defineTool({
      name: 'update_plan',
      description:
        'Updates the task plan.\n' +
        'Provide an optional explanation and a list of plan items, each with a step and status.\n' +
        'At most one step can be in_progress at a time.\n',
      parameters: {
        explanation: { type: 'string', description: 'Optional explanation for this plan update.' },
        plan: {
          type: 'array',
          required: true,
          description: 'The list of steps',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              step: { type: 'string', required: true, description: 'Task step text.' },
              status: {
                type: 'string',
                required: true,
                enum: [...STATUSES],
                description: 'Step status.',
              },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            plan: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  step: { type: 'string', required: true },
                  status: { type: 'string', required: true, enum: [...STATUSES] },
                },
              },
            },
            counts: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                pending: { type: 'integer', required: true },
                in_progress: { type: 'integer', required: true },
                completed: { type: 'integer', required: true },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `Updated plan: ${value.counts.pending} pending, ${value.counts.in_progress} in progress, ${value.counts.completed} completed.`,
          },
        ],
      },
      execute(args, exec) {
        const plan = toPlanList(args.plan)
        if (!exec.agent) throw new Error('update_plan requires an owning agent session')
        exec.agent.session.append('plan/write', { plan })
        const count = (status) => plan.filter((item) => item.status === status).length
        return Promise.resolve({
          plan: plan.map((item) => ({ step: item.step, status: item.status })),
          counts: {
            pending: count('pending'),
            in_progress: count('in_progress'),
            completed: count('completed'),
          },
        })
      },
      presentCall: (args) => ({ card: 'generic', title: 'Update plan', kind: 'other', rawInput: args.plan }),
    })
  )
}
