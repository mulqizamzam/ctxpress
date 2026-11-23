/**
 * ctxpress — context-management plugin for DeepSeek Harness (DSH 0.2.3-alpha.2).
 *
 * A Cordis plugin that imitates ranxianglei/billion-context's dsh lane in DSH-native form.
 * It rides DSH's own seams — no wire interception, no external proxy:
 *
 *   - registers model-callable tools (`ctxpress_compact`, `ctxpress_context`, `ctxpress_recall`)
 *     so an agent turn can self-direct compaction, as bili's `compress` tool does on the wire;
 *   - registers a human `/ctx` command (status | compact | recall), the analogue of bili's `/acp`;
 *   - contributes a system-prompt "compression philosophy" section so the model knows when to use them;
 *   - owns a context ledger fed by the single `compaction/summary` event (single source of truth).
 *
 * Compose it in a `cordis.yml` / bundle-patch overlay alongside the DSH service packages
 * (`@deepseek-ai/dsh-tools`, `-commands`, `-compaction`, `-system-prompt`); see `dsh.bundle.patch.yml`.
 * The always-on `ctxpress-gate` entry is a separate module (`./gate`); see DESIGN.md.
 * @module ctxpress
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { resolveConfig } from './config'
import { ContextLedger } from './context-ledger'
import { defineCtxpressTools } from './tools'
import { registerCtxpressCommand } from './command'
import { SECTION_NAME, SECTION_ORDER, compressionPhilosophy } from './prompt'
import { textOf } from './tools-text'

export const name = 'ctxpress'
export const inject = ['tools', 'commands', 'compaction', 'systemPrompt']

/** The projected `compaction/summary` event payload (structural; the package owns the full type). */
interface CompactionSummaryPayload {
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount: number
  readonly provider?: string
  readonly model?: string
  readonly summary: readonly ContentBlock[]
}

/**
 * Apply ctxpress.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  const config = resolveConfig()
  const ledger = new ContextLedger(config.recallLimit)
  const logger = ctx.logger('ctxpress')

  // Register the model-callable tools; each disposer is auto-attached to this plugin's fiber.
  for (const tool of defineCtxpressTools(ctx, ledger, config)) {
    ctx.tools.register(tool)
  }

  // The human /ctx command (status | compact | recall).
  registerCtxpressCommand(ctx, ledger, config)

  // System-prompt compression guidance, scoped to whether the tools are actually visible.
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: ({ scope }) => compressionPhilosophy(ctx.tools.get('ctxpress_compact', scope) !== undefined),
    retirement: 'ctxpress is no longer installed; its context-management tools are unavailable.',
  })

  // The summary event is the single source of truth for the ledger. Guarded: on a composition
  // that has not declared `compaction/summary` (e.g. a keyless verify harness), registering it
  // is a no-op rather than a crash — the tools and command still work; only the live feed is off.
  try {
    ctx.on('compaction/summary', (evt: CompactionSummaryPayload) => {
      ledger.recordSummary({
        shadowedSeqs: evt.shadowedSeqs,
        shadowedTokenCount: evt.shadowedTokenCount,
        provider: evt.provider,
        model: evt.model,
        summaryText: textOf(evt.summary),
      })
      logger.debug?.(`compaction/summary observed: ${evt.shadowedSeqs.length} shadowed (~${evt.shadowedTokenCount} tokens)`)
    })
  } catch (error: unknown) {
    logger.debug?.(`compaction/summary event not registered: ${String((error as Error)?.message ?? error)}`)
  }

  // Persist the ledger snapshot on unload (best-effort; a snapshot, not a cross-copy source of truth).
  ctx.effect(function* () {
    yield async () => {
      if (config.stateDir !== undefined) ledger.save(config.stateDir)
    }
  }, 'ctxpress ledger persistence')

  logger.info?.(`loaded (auto-stand-aside ${config.autoStandAside ? 'on' : 'off'}; recall cap ${config.recallLimit})`)
}
