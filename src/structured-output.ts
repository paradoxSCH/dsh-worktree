/**
 * Child-scoped structured output used by the worktree in-process runner.
 *
 * Derived from DeepSeek Harness' MIT-licensed
 * @deepseek-ai/dsh-subagent-in-process-driver implementation. It lives here
 * because rc.6 does not export the attachment interface required by a custom
 * child-session cwd adapter.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ToolArgsError, validateJsonSchemaValue, type ObjectJsonSchema } from '@deepseek-ai/dsh-tools'

export const STRUCTURED_OUTPUT_TOOL = 'structured_output'

export const STRUCTURED_OUTPUT_INSTRUCTION
  = 'When you have your final answer, you MUST report it by calling the '
    + `\`${STRUCTURED_OUTPUT_TOOL}\` tool with arguments matching its parameter schema exactly. `
    + 'Do not finish with a plain text answer: only the tool call counts as your result.'

export interface StructuredAttachment {
  captured(): { value: unknown } | undefined
}

export function attachStructuredRuntime(childCtx: Context, schema: ObjectJsonSchema): StructuredAttachment {
  const staged = new WeakMap<ToolExecution, { value: unknown }>()
  let pending: { parent: ToolExecution['token']; value: unknown } | undefined
  let captured: { value: unknown } | undefined

  const schemaEntry: ToolSchema = {
    name: STRUCTURED_OUTPUT_TOOL,
    description:
      'Report your final structured result. Call this exactly once, when your answer is complete; '
      + 'the arguments must match this tool\'s parameter schema exactly.',
    parameters: schema as unknown as Record<string, unknown>,
  }

  childCtx.tools.register({
    ...schemaEntry,
    output: {
      schema: {
        type: 'object',
        properties: { recorded: { type: 'boolean', const: true } },
        required: ['recorded'],
        additionalProperties: false,
      },
      render: () => [{ type: 'text', text: 'Structured output recorded.' }],
    },
    execute(args: unknown, exec: ToolRunContext): Promise<{ recorded: true }> {
      const violations = validateJsonSchemaValue(schema, args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      staged.set(exec, { value: args })
      exec.concludeTurn()
      return Promise.resolve({ recorded: true })
    },
  })

  childCtx.systemPrompt.section({
    name: `tool:${STRUCTURED_OUTPUT_TOOL}`,
    order: 190,
    text: STRUCTURED_OUTPUT_INSTRUCTION,
  })

  childCtx.tools.guard(exec => captured === undefined && pending === undefined
    ? undefined
    : `structured output already recorded: the run is complete, so \`${exec.name}\` is not executed`)

  childCtx.on('tools/result', function (this: unknown, exec, result) {
    if (exec.name === STRUCTURED_OUTPUT_TOOL) {
      const entry = staged.get(exec)
      if (entry === undefined) return
      staged.delete(exec)
      if (result.isError) return
      if (exec.parent === undefined) {
        if (captured === undefined) captured = { value: entry.value }
      } else if (captured === undefined && pending === undefined) {
        pending = { parent: exec.parent, value: entry.value }
      }
      return
    }
    if (pending?.parent !== exec.token) return
    const entry = pending
    pending = undefined
    if (result.isError) return
    if (captured === undefined) captured = { value: entry.value }
  })

  return { captured: () => captured }
}
