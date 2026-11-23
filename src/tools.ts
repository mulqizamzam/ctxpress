/**
 * The model-callable ctxpress tools: `ctxpress_compact`, `ctxpress_context`, `ctxpress_recall`.
 *
 * Each is a `defineTool` definition; registration happens in the plugin entry. `execute`
 * receives the runtime `ToolRunContext`, whose `agent` (set by the agent loop) is the seam
 * that lets `compact` drive the real `ctx.compaction.compactNow` — so a model turn can
 * self-direct compaction exactly as billion-context's `compress` tool does on the wire.
 * Keyless (no agent) executions degrade to a structured "no active agent" result, never a crash.
 *
 * `ctxpress_recall` has two paths: the summary-first default (the harness summary text) and
 * `expand=true`, which re-surfaces the ORIGINAL shadowed transcript through the optional
 * `ctx.sessionQuery` exact-read seam. Both return the receipt-shaped `RecallReceipt`.
 * @module ctxpress/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CommandId } from '@deepseek-ai/dsh-commands'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CtxpressConfig } from './config.js'
import type { ContextLedger } from './context-ledger.js'
import { expandReceipt, summaryReceipt, type RecallReceipt, type SessionQueryLike } from './recall.js'

/** Map a manual-compaction failure code to a short model-facing receipt. */
function compactErrorReceipt(e: ManualCompactionError): string {
  switch (e.code) {
    case 'busy': return 'A compaction is already in progress or the agent is not idle.'
    case 'cancelled': return 'Compaction cancelled.'
    case 'changed': return 'The selected history changed before it could be replaced.'
    case 'summary': return 'Compaction could not produce a useful summary.'
    case 'commit': return 'Compaction did not finish cleanly; inspect the session state before retrying.'
    case 'persistence': return 'Compaction finished but the session could not be saved.'
    default: return `Compaction failed: ${e.code}`
  }
}

/**
 * Build the three ctxpress tool definitions.
 * @param ctx - the plugin context (provides `ctx.compaction`, `ctx.logger`).
 * @param ledger - the shared context ledger the tools read/write.
 * @param config - the resolved plugin configuration.
 */
export function defineCtxpressTools(ctx: Context, ledger: ContextLedger, config: CtxpressConfig) {
  const compact = defineTool({
    name: 'ctxpress_compact',
    description: 'Compact older conversation history into a summary. Reports how many history items and roughly how many tokens were saved.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          compacted: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          shadowedItems: { type: 'integer' },
          shadowedTokens: { type: 'integer' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: `[ctxpress] ${v.message}` }],
    },
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        return { ok: true, compacted: false, message: 'No active agent in this execution context. Run the /ctx compact command instead.' }
      }
      const commandId = brandString<CommandId>('ctxpress:compact')
      try {
        const result = await ctx.compaction.compactNow(agent, exec.signal, commandId)
        if (result === null) return { ok: true, compacted: false, message: 'No compactable history yet.' }
        // The `compaction/summary` event is the single source of truth for the ledger
        // (observed in the plugin entry); here we only report the immediate receipt.
        return {
          ok: true,
          compacted: true,
          message: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`,
          shadowedItems: result.shadowedSeqs.length,
          shadowedTokens: result.shadowedTokenCount,
        }
      } catch (e: unknown) {
        if (exec.signal.aborted) return { ok: true, compacted: false, message: 'Compaction cancelled.' }
        if (e instanceof ManualCompactionError) return { ok: true, compacted: false, message: compactErrorReceipt(e) }
        ctx.logger('ctxpress').error?.('compact failed', e)
        return { ok: false, compacted: false, message: `Compaction failed: ${String((e as Error)?.message ?? e)}` }
      }
    },
  })

  const context = defineTool({
    name: 'ctxpress_context',
    description: 'Read current context pressure: how much history has been compacted and the last compaction facts. Read-only.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hasCompactions: { type: 'boolean', required: true },
          count: { type: 'integer', required: true },
          totalShadowedTokens: { type: 'integer', required: true },
          autoStandAside: { type: 'boolean', required: true },
          lastProvider: { type: 'string' },
          lastModel: { type: 'string' },
        },
      },
      render: (_a, v) => {
        const last = v.lastProvider !== undefined || v.lastModel !== undefined
          ? ` last: ${[v.lastProvider, v.lastModel].filter(Boolean).join('/')}`
          : ''
        const body = v.hasCompactions
          ? `${v.count} compaction(s), ~${v.totalShadowedTokens} tokens shadowed${last}.`
          : 'No compactions observed yet in this session.'
        return [{ type: 'text', text: `[ctxpress] context: auto-stand-aside ${v.autoStandAside ? 'ON' : 'OFF'}; ${body}` }]
      },
    },
    async execute() {
      const s = ledger.status()
      return {
        hasCompactions: s.hasCompactions,
        count: s.count,
        totalShadowedTokens: s.totalShadowedTokens,
        autoStandAside: config.autoStandAside,
        ...s.last?.provider !== undefined ? { lastProvider: s.last.provider } : {},
        ...s.last?.model !== undefined ? { lastModel: s.last.model } : {},
      }
    },
  })

  const recall = defineTool({
    name: 'ctxpress_recall',
    description: 'Re-surface a compacted range: the harness summary by default, or the original shadowed transcript with expand=true. index selects which observed compaction (0 = newest). Read-only.',
    parameters: {
      limit: { type: 'number', description: 'Max characters of the summary (summary mode) or the transcript (expand mode). Defaults to the configured cap (recallLimit / expandLimit).' },
      expand: { type: 'boolean', description: 'Set true to re-surface the original shadowed transcript instead of the summary.' },
      index: { type: 'integer', description: 'Which observed compaction to recall, 0 = newest. Defaults to 0.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hadCompaction: { type: 'boolean', required: true },
          mode: { type: 'string', enum: ['summary', 'expanded', 'unavailable'], required: true },
          unavailableReason: { type: 'string', enum: ['no-compaction', 'no-agent', 'no-session-query', 'read-failed'] },
          readErrorCode: { type: 'string' },
          shadowedSeqs: { type: 'array', items: { type: 'integer' } },
          shadowedTokens: { type: 'integer' },
          compactionId: { type: 'string' },
          summary: { type: 'string' },
          transcript: { type: 'string' },
          truncated: { type: 'boolean' },
          expandedChars: { type: 'integer' },
        },
      },
      render: (_a, v: RecallReceipt) => {
        if (v.mode === 'unavailable') {
          return [{ type: 'text', text: `[ctxpress] recall unavailable (${v.unavailableReason}${v.readErrorCode ? `: ${v.readErrorCode}` : ''}).` }]
        }
        if (v.mode === 'summary') {
          return [{ type: 'text', text: `[ctxpress] recalled ${v.shadowedSeqs?.length ?? 0} shadowed items (~${v.shadowedTokens ?? 0} tokens):\n${v.summary}` }]
        }
        return [{ type: 'text', text: `[ctxpress] expanded ${v.shadowedSeqs?.length ?? 0} shadowed items (~${v.shadowedTokens ?? 0} tokens): ${v.expandedChars} chars${v.truncated ? ' (truncated)' : ''}:\n${v.transcript}` }]
      },
    },
    async execute(args, exec) {
      const index = Number.isInteger(args.index) && (args.index as number) >= 0 ? (args.index as number) : 0
      const entry = ledger.entry(index)
      if (args.expand === true) {
        return expandReceipt({
          entry,
          agentId: exec.agent !== undefined ? String(exec.agent.id) : undefined,
          getSessionQuery: () => ctx.get('sessionQuery', false) as SessionQueryLike | undefined,
          args,
          config,
          signal: exec.signal,
          logger: (e) => ctx.logger('ctxpress').error?.(e),
        })
      }
      const cap = typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : config.recallLimit
      return summaryReceipt(entry, cap, config)
    },
  })

  return [compact, context, recall] as const
}
