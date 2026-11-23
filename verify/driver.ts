/**
 * Verification driver. The registration facts (tool presence, command presence) are checked
 * SYNCHRONOUSLY so they print before a keyless process exits on its own. The pipeline
 * execution is best-effort and, if it settles in time, is reported before a clean exit.
 */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'

const TOOL_NAMES = ['ctxpress_compact', 'ctxpress_context', 'ctxpress_recall']

export const name = 'ctxpress-verify-driver'

export function apply(ctx: Context): void {
  // (a) tools present in the REAL tools registry — synchronous.
  const present = TOOL_NAMES.filter((n) => ctx.tools.get(n) !== undefined)
  const missing = TOOL_NAMES.filter((n) => ctx.tools.get(n) === undefined)
  console.log(`[verify] ctxpress tools present: ${present.join(', ') || '(none)'}`)
  if (missing.length > 0) console.log(`[verify] MISSING tools: ${missing.join(', ')}`)

  // (c) the /ctx command — a global command resolves for any agent; sync.
  let commandRegistered = false
  let commandNote = ''
  try {
    const cmd = ctx.commands.find({} as Agent, 'ctx')
    commandRegistered = cmd !== undefined
    commandNote = cmd ? `yes — ${cmd.description}` : 'NO'
  } catch (error) {
    commandNote = `lookup skipped (keyless): ${String((error as Error)?.message ?? error)}`
  }
  console.log(`[verify] /ctx command: ${commandNote}`)

  // (b) best-effort: run one tool through the real pipeline, then report and exit cleanly.
  const keepAlive = setTimeout(() => {
    console.log('[verify] execute did not settle before timeout; reporting sync facts and exiting.')
    reportAndExit(ctx)
  }, 5000)
  void ctx.tools
    .execute({
      calls: [{ type: 'tool-call', id: brandString<ToolCallId>('ctxpress-verify'), name: 'ctxpress_context', arguments: '{}' }],
      signal: new AbortController().signal,
    })
    .then((res) => {
      clearTimeout(keepAlive)
      const first = res.results?.[0]?.result?.content
      const text = Array.isArray(first) ? first.map((b) => (typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('') : ''
      console.log(`[verify] ctxpress_context execute → ${text || JSON.stringify(res.results?.[0] ?? res)}`)
      reportAndExit(ctx)
    })
    .catch((error) => {
      clearTimeout(keepAlive)
      console.log(`[verify] ctxpress_context execute error: ${String((error as Error)?.message ?? error)}`)
      reportAndExit(ctx)
    })

  function reportAndExit(_ctx: Context): void {
    const ok = present.length === 3 && commandRegistered
    console.log(`[verify] ${ok ? 'PASS' : 'CHECK'} — ${present.length}/3 tools, /ctx ${commandRegistered ? 'registered' : 'not found'}`)
    // Let the keyless process exit naturally; the process has no other live handles.
    process.exit(ok ? 0 : 1)
  }
}
