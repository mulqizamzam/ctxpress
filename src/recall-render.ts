/**
 * `renderTranscript` — the pure projection from a session's shadowed events to
 * the `User:` / `Assistant:` / `Tool call:` / `Tool result:` transcript lines
 * the recall expand path returns.
 *
 * The caller passes events already filtered to the entry's `shadowedSeqs` and
 * ordered by surface position; this module owns only the line rendering, the
 * empty-text skipping rules, and the oldest-kept cap with its elided-chars
 * marker. No Cordis dependency — unit-testable in isolation.
 * @module ctxpress/recall-render
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { textOf } from './tools-text.js'

/**
 * Render shadowed session events as a model-facing transcript.
 * @param events — the shadowed events, in surface order (caller pre-filtered).
 * @param limit — maximum characters of transcript text (before the marker); must be > 0.
 * @returns the rendered text (capped, oldest kept, marker appended when cut) and whether the cut happened.
 */
export function renderTranscript(events: readonly SessionEvent[], limit: number): { text: string; truncated: boolean } {
  const lines: string[] = []
  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        const body = textOf(event.data.content)
        if (body.length > 0) lines.push(`User: ${body}`)
        break
      }
      case 'assistant/message': {
        const body = textOf(event.data.message.content)
        if (body.length > 0) {
          lines.push(`Assistant: ${body}${event.data.interrupted === true ? ' [interrupted]' : ''}`)
        }
        break
      }
      case 'tool/call': {
        lines.push(event.data.arguments !== '' ? `Tool call: ${event.data.name} ${event.data.arguments}` : `Tool call: ${event.data.name}`)
        break
      }
      case 'tool/result': {
        const body = textOf(event.data.message.content)
        if (body.length > 0) {
          lines.push(`Tool result: ${body}${event.data.message.isError ? ' [error]' : ''}`)
        }
        break
      }
      default:
        // Log-only and unrecognized types never enter the transcript.
        break
    }
  }

  const full = lines.join('\n')
  if (full.length <= limit) return { text: full, truncated: false }
  const elided = full.length - limit
  return { text: full.slice(0, limit) + `\n[truncated: ${elided} chars elided]`, truncated: true }
}
