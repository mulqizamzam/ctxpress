/**
 * The `/ctx` command — the human-facing surface over the compaction seam, mirroring DSH's own
 * `/compact` (command-compact) but with a status default, a compact subcommand, and a recall
 * subcommand. This is the command equivalent of billion-context's `/acp`.
 * @module ctxpress/command
 */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CommandDefinitionId } from '@deepseek-ai/dsh-commands/types'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { CommandId } from '@deepseek-ai/dsh-commands'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CtxpressConfig } from './config'
import type { ContextLedger } from './context-ledger'

const USAGE = 'Usage: /ctx [status|compact|recall [chars]]'

function statusText(ctx: Context, ledger: ContextLedger, config: CtxpressConfig): string {
  const s = ledger.status()
  const gate = config.autoStandAside ? 'ON' : 'OFF'
  if (!s.hasCompactions) return `ctxpress: auto-stand-aside ${gate}; no compactions observed yet in this session.`
  const last = s.last
  const meta = [last?.provider, last?.model].filter(Boolean).join('/')
  return `ctxpress: auto-stand-aside ${gate}; ${s.count} compaction(s), ~${s.totalShadowedTokens} tokens shadowed. Last${meta ? ` (${meta})` : ''}: ${last?.shadowedSeqs.length ?? 0} items, ~${last?.shadowedTokenCount ?? 0} tokens.`
}

async function runCompact(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  try {
    const result = await ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)
    if (result === null) return { kind: 'success', text: 'No compactable history yet.' }
    // The `compaction/summary` event feeds the ledger (single source of truth); this is the receipt.
    return { kind: 'success', text: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).` }
  } catch (error: unknown) {
    if (invocation.signal.aborted) return { kind: 'error', text: 'Compaction cancelled.' }
    if (error instanceof ManualCompactionError) return { kind: 'error', text: `Compaction failed: ${error.code}.` }
    throw error
  }
}

function runRecall(ledger: ContextLedger, config: CtxpressConfig, raw: string): CommandResult {
  const r = ledger.recall()
  if (!r.hadCompaction || r.last === undefined) return { kind: 'success', text: 'Nothing compacted yet to recall.' }
  const charsArg = raw.trim().match(/(\d+)/u)?.[1]
  const cap = charsArg !== undefined ? Number.parseInt(charsArg, 10) : config.recallLimit
  const summary = r.last.summaryText !== undefined ? r.last.summaryText.slice(0, cap) : '(no summary retained)'
  return { kind: 'success', text: `Recalled ${r.last.shadowedSeqs.length} shadowed items (~${r.last.shadowedTokenCount} tokens):\n${summary}` }
}

/**
 * Register the `/ctx` command with lifecycle-correct teardown.
 * @param ctx - context carrying `commands`, `compaction`, `logger`.
 * @param ledger - the shared context ledger.
 * @param config - the resolved configuration.
 */
export function registerCtxpressCommand(ctx: Context, ledger: ContextLedger, config: CtxpressConfig): void {
  const active = new Set<Promise<CommandResult>>()

  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const tokens = invocation.rawInput.trim().split(/\s+/u).filter((t) => t.length > 0)
    const op = tokens[0] === undefined ? 'status' : tokens[0].toLowerCase()
    let operation: Promise<CommandResult>
    if (op === 'compact' || op === 'c') {
      operation = runCompact(ctx, invocation)
    } else if (op === 'recall' || op === 'r') {
      operation = Promise.resolve(runRecall(ledger, config, tokens.slice(1).join(' ')))
    } else if (op === 'status' || op === 's' || op === '') {
      operation = Promise.resolve({ kind: 'success' as const, text: statusText(ctx, ledger, config) })
    } else {
      operation = Promise.resolve({ kind: 'error' as const, text: USAGE })
    }
    active.add(operation)
    const retire = (): void => { active.delete(operation) }
    void operation.then(retire, retire)
    return operation
  }

  ctx.effect(function* () {
    yield async () => { await Promise.allSettled(active) }
    yield ctx.commands.register({
      definitionId: brandString<CommandDefinitionId>('ctxpress:ctx'),
      name: 'ctx',
      description: 'Context management: /ctx [status|compact|recall [chars]]',
      input: { hint: 'status | compact | recall [chars]' },
      handler,
    })
  }, 'ctxpress /ctx command lifecycle')
}
