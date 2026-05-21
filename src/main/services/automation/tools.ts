/**
 * Re-export of the canonical tool spec table. The actual definitions live in
 * `@shared/agent-tools` so the renderer can use the same source of truth for
 * routing AI tool calls — keeping the renderer's `name → actionType` lookup
 * in lockstep with what the model is told about.
 */
export { TOOL_SPECS, toolSpecByName, type ToolSpec, type ToolParameterSchema } from '@shared/agent-tools'
