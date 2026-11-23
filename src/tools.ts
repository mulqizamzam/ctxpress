/**
 * The model-callable ctxpress tools: `ctxpress_compact`, `ctxpress_context`, `ctxpress_recall`.
 *
 * Each is a `defineTool` definition; registration happens in the plugin entry. `execute`
 * receives the runtime `ToolRunContext`, whose `agent` (set by the agent loop) is the seam
 * that lets `compact` drive the real `ctx.compaction.compactNow` — so a model turn can
 * self-direct compaction exactly as billion-context's `compress` tool does on the wire.
 * Keyless (no agent) executions degrade to a structured "no active agent" result, never a crash.
 * @module ctxpress/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CommandId } from '@deepseek-ai/dsh-commands'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CtxpressConfig } from './config'
import type { ContextLedger } from './context-ledger'

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
    description: 'Re-surface the most recently compacted range: the shadowed history items and the summary the harness wrote.',
    parameters: {
      limit: { type: 'number', description: 'Maximum characters of the summary to surface. Defaults to the configured cap.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hadCompaction: { type: 'boolean', required: true },
          shadowedSeqs: { type: 'array', items: { type: 'integer' } },
          shadowedTokens: { type: 'integer' },
          summary: { type: 'string' },
        },
      },
      render: (_a, v) => {
        if (!v.hadCompaction) return [{ type: 'text', text: '[ctxpress] nothing compacted yet to recall.' }]
        return [{ type: 'text', text: `[ctxpress] recalled ${v.shadowedSeqs?.length ?? 0} shadowed items (~${v.shadowedTokens ?? 0} tokens):\n${v.summary}` }]
      },
    },
    async execute(args) {
      const r = ledger.recall()
      if (!r.hadCompaction || r.last === undefined) return { hadCompaction: false }
      const cap = typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : config.recallLimit
      const summary = r.last.summaryText !== undefined ? r.last.summaryText.slice(0, cap) : '(no summary retained)'
      return {
        hadCompaction: true,
        shadowedSeqs: r.last.shadowedSeqs as number[],
        shadowedTokens: r.last.shadowedTokenCount,
        summary,
      }
    },
  })

  return [compact, context, recall] as const
}
