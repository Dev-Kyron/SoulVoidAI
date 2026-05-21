/**
 * Runs automation actions from the UI. If an action is blocked on a missing
 * permission, the user is prompted interactively; on approval the action is
 * retried exactly once. Outcomes surface as toasts, with an Undo affordance
 * for reversible actions.
 */
import { vs } from './bridge'
import { useUiStore } from '../store/useUiStore'
import { useConfigStore } from '../store/useConfigStore'
import { useChatStore } from '../store/useChatStore'
import { useWidgetStore } from '../store/useWidgetStore'
import type {
  ActionRequest,
  ActionResult,
  ScreenshotResult,
  ToolCall,
  ToolInvocation
} from '@shared/types'

export async function runAction(
  req: ActionRequest,
  label: string
): Promise<ActionResult | null> {
  const ui = useUiStore.getState()
  let result = await vs.automation.execute(req)

  if (result.needsPermission) {
    const granted = await ui.promptPermission(result.needsPermission, label)
    if (!granted) {
      ui.pushToast('info', `${label} cancelled — permission was not granted.`)
      return null
    }
    await useConfigStore.getState().setPermission(result.needsPermission, true)
    result = await vs.automation.execute(req)
  }

  if (!result.ok) {
    ui.pushToast('error', result.error ?? `${label} failed.`)
    return result
  }

  // A captured screenshot is attached straight to the chat composer.
  if (result.type === 'screenshot' && result.data) {
    const shot = result.data as ScreenshotResult
    useChatStore.getState().addImageAttachment(`screenshot-${Date.now()}.png`, shot.dataUrl)
    useWidgetStore.getState().setTab('chat')
    ui.pushToast('success', 'Screenshot captured and attached to chat.')
    return result
  }

  // OCR'd screen text is attached to the chat composer as a text file.
  if (result.type === 'read-screen' && result.data) {
    const { text } = result.data as { text: string }
    if (text.trim().length === 0) {
      ui.pushToast('info', 'No readable text found on screen.')
      return result
    }
    useChatStore.getState().addTextAttachment(`screen-text-${Date.now()}.txt`, text)
    useWidgetStore.getState().setTab('chat')
    ui.pushToast('success', result.output ?? 'Screen text attached to chat.')
    return result
  }

  ui.pushToast('success', result.output ?? `${label} complete.`, result.undoId)
  return result
}

export async function undoAction(undoId: string): Promise<void> {
  const result = await vs.automation.undo(undoId)
  useUiStore.getState().pushToast(result.ok ? 'success' : 'error', result.message)
}

/* ------------------------------ agent tools ----------------------------- */

import { toolSpecByName } from '@shared/agent-tools'

const MAX_TOOL_RESULT = 8000

/** Builds a concise text result for the model from an action outcome. */
function toolResultText(result: ActionResult): string {
  if (result.type === 'read-screen') {
    const text = (result.data as { text?: string })?.text ?? ''
    return text.trim() ? `Text visible on screen:\n${text}` : 'No readable text found on screen.'
  }
  if (result.type === 'file-read') {
    return (result.data as { text?: string })?.text ?? '(empty file)'
  }
  if (result.type === 'file-list' && Array.isArray(result.data)) {
    const entries = result.data as Array<{ name: string; kind: string }>
    return entries.length > 0
      ? entries.map((e) => `${e.kind === 'dir' ? '[dir] ' : ''}${e.name}`).join('\n')
      : '(empty directory)'
  }
  return result.output ?? 'Done.'
}

/**
 * Executes one AI tool call: maps it to an automation action, prompts for any
 * missing permission, runs it, and returns the invocation with its result.
 *
 * `requestId` is the agent loop's correlation id — passed through to main so
 * the action's abort controller registers against the same key the LLM call
 * does. When the user clicks Stop, `vs.ai.abort(requestId)` then kills the
 * tool's in-flight fetch / subprocess too, not just the LLM stream.
 */
export async function runAgentTool(
  call: ToolCall,
  requestId?: string
): Promise<ToolInvocation> {
  // MCP-provided tools are name-prefixed; they're routed to the MCP manager
  // in the main process, which calls the right server's tool.
  if (call.name.startsWith('mcp_')) {
    const result = await vs.mcp.callTool(call.name, call.args)
    return { ...call, ok: result.ok, result: result.text.slice(0, MAX_TOOL_RESULT) }
  }

  // Look the tool up in the shared spec table — keeps the renderer and the
  // main-process tool list in lockstep. Adding a new entry to the spec is
  // the only change required to route it.
  const spec = toolSpecByName(call.name)
  if (!spec) {
    return { ...call, ok: false, result: `Unknown tool: ${call.name}` }
  }
  const actionType = spec.actionType

  const request: ActionRequest = { type: actionType, params: call.args, requestId }
  let result = await vs.automation.execute(request)

  if (result.needsPermission) {
    const granted = await useUiStore
      .getState()
      .promptPermission(result.needsPermission, call.name.replace(/_/g, ' '))
    if (!granted) {
      return {
        ...call,
        ok: false,
        result: `The user denied the "${result.needsPermission}" permission, so this could not run.`
      }
    }
    await useConfigStore.getState().setPermission(result.needsPermission, true)
    result = await vs.automation.execute(request)
  }

  if (!result.ok) {
    return { ...call, ok: false, result: result.error ?? 'The action failed.' }
  }

  // `see_screen` produces a screenshot that should be fed back to the model
  // as input on the next turn. `generate_image` produces a picture the USER
  // wants to see — same data shape, different destination.
  let image: string | undefined
  let imageOutput: string | undefined
  const data = result.data as { dataUrl?: string } | undefined
  if (call.name === 'see_screen' && data?.dataUrl) image = data.dataUrl
  if (call.name === 'generate_image' && data?.dataUrl) imageOutput = data.dataUrl

  return {
    ...call,
    ok: true,
    result: toolResultText(result).slice(0, MAX_TOOL_RESULT),
    ...(image ? { image } : {}),
    ...(imageOutput ? { imageOutput } : {})
  }
}
