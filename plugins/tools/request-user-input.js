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

const MAX_QUESTIONS = 3
const MAX_HEADER_CHARS = 12
const SNAKE_CASE = /^[a-z][a-z0-9_]*$/

/** Validate the model-supplied questions against codex's 1–3 constraints. */
function validateQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('request_user_input: `questions` must contain 1-3 questions')
  }
  if (questions.length > MAX_QUESTIONS) {
    throw new Error(`request_user_input: at most ${MAX_QUESTIONS} questions (got ${questions.length})`)
  }
  for (const question of questions) {
    if (typeof question.id !== 'string' || !SNAKE_CASE.test(question.id)) {
      throw new Error(
        `request_user_input: question id must be a snake_case string (got ${JSON.stringify(question.id)})`
      )
    }
    if (typeof question.question !== 'string' || question.question.trim().length === 0) {
      throw new Error(`request_user_input: question ${question.id} must have a non-empty prompt`)
    }
    if (question.header !== undefined && question.header.length > MAX_HEADER_CHARS) {
      throw new Error(
        `request_user_input: question ${question.id} header must be ${MAX_HEADER_CHARS} or fewer chars`
      )
    }
    if (question.options !== undefined) {
      if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 3) {
        throw new Error(`request_user_input: question ${question.id} options must be 2-3 choices`)
      }
      for (const option of question.options) {
        if (typeof option.label !== 'string' || option.label.trim().length === 0) {
          throw new Error(`request_user_input: question ${question.id} options need non-empty labels`)
        }
      }
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
                description: 'Short header label shown in the UI (12 or fewer chars).',
              },
              question: {
                type: 'string',
                required: true,
                description: 'Single-sentence prompt shown to the user.',
              },
              options: {
                type: 'array',
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
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  selected: { type: 'array', required: true, items: { type: 'string' } },
                  custom: { type: 'string' },
                },
              },
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
            ...(question.header !== undefined ? { header: question.header } : {}),
            ...(question.options !== undefined ? { options: question.options } : {}),
          })),
          ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
          signal: exec.signal,
        })
        return result
      },
      presentCall: (args) => ({ card: 'generic', title: 'Request user input', kind: 'other', rawInput: args.questions }),
    })
  )
}
