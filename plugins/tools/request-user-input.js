/**
 * dsh-codex M1 — `request_user_input` question tool.
 *
 * Codex-parity schema (HEAD 5bc8da6d78, request_user_input_spec.rs) executed
 * through the DSH `ctx.userQuestions` seam: the tool pauses until a UI
 * provider returns a human answer, then feeds that answer back into the agent
 * loop as an ordinary tool result (mirrors @deepseek-ai/dsh-tool-ask-user).
 *
 * @module dsh-codex/tools/request-user-input
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-codex-request-user-input'
export const inject = ['tools', 'userQuestions']

/** Validate the model-supplied questions. Codex's only constraint is that
 * every question carries non-empty options; the schema enforces the rest. */
function validateQuestions(questions) {
  for (const question of questions) {
    if (question.options.length === 0) {
      throw new Error('request_user_input requires non-empty options for every question')
    }
  }
}

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'request_user_input',
      description:
        'Request user input for one to three short questions and wait for the response.',
      parameters: {
        questions: {
          type: 'array',
          required: true,
          description: 'Questions to show the user. Prefer 1 and do not exceed 3',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: {
                type: 'string',
                required: true,
                description: 'Stable identifier for mapping answers (snake_case).',
              },
              header: {
                type: 'string',
                required: true,
                description: 'Short header label shown in the UI (12 or fewer chars).',
              },
              question: {
                type: 'string',
                required: true,
                description: 'Single-sentence prompt shown to the user.',
              },
              options: {
                type: 'array',
                required: true,
                description:
                  'Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with "(Recommended)". Do not include an "Other" option in this list; the client will add a free-form "Other" option automatically.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    label: { type: 'string', required: true, description: 'User-facing label (1-5 words).' },
                    description: {
                      type: 'string',
                      required: true,
                      description: 'One short sentence explaining impact/tradeoff if selected.',
                    },
                  },
                },
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
            answers: {
              type: 'object',
              required: true,
              additionalProperties: true,
              description: 'Answers keyed by question id; each value is { answers: [string] }.',
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        validateQuestions(args.questions)
        const result = await ctx.userQuestions.ask({
          questions: args.questions.map((question) => ({
            id: question.id,
            question: question.question,
            header: question.header,
            options: question.options,
          })),
          ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
          signal: exec.signal,
        })
        if (result == null) {
          throw new Error('request_user_input was cancelled before receiving a response')
        }
        const answers = {}
        for (const answer of result.answers ?? []) {
          const list = [...(Array.isArray(answer.selected) ? answer.selected : [])]
          if (typeof answer.custom === 'string' && answer.custom.length > 0) list.push(answer.custom)
          answers[answer.id] = { answers: list }
        }
        return { answers }
      },
      presentCall: (args) => ({ card: 'generic', title: 'Request user input', kind: 'other', rawInput: args.questions }),
    })
  )
}
