import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defineCtxpressTools } from '../src/tools'
import { ContextLedger } from '../src/context-ledger'
import { resolveConfig } from '../src/config'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { makeCtx, makeExec } from './helpers'

function setup() {
  const ctx = makeCtx()
  const ledger = new ContextLedger(100)
  const config = resolveConfig({}, {})
  const defs = defineCtxpressTools(ctx as never, ledger, config)
  return { ctx, ledger, config, defs }
}

test('exposes the three expected tool names, in order', () => {
  const { defs } = setup()
  assert.deepEqual(defs.map((d) => d.name), ['ctxpress_compact', 'ctxpress_context', 'ctxpress_recall'])
})

test('compact: no active agent → graceful receipt, no compaction call', async () => {
  const { defs, ctx } = setup()
  let called = 0
  ctx.compaction.compactNow = async () => { called += 1; return null }
  const out: { compacted?: boolean; message?: string } = await defs[0].execute({}, makeExec(undefined) as never)
  assert.equal(out.compacted, false)
  assert.match(out.message ?? '', /No active agent/)
  assert.equal(called, 0)
})

test('compact: with an agent, success receipt reflects the result', async () => {
  const { defs, ctx } = setup()
  ctx.compaction.compactNow = async () => ({ shadowedSeqs: [1, 2], shadowedTokenCount: 40, summary: [{ type: 'text', text: 'sum' }] })
  const out: { ok?: boolean; compacted?: boolean; shadowedItems?: number; message?: string } =
    await defs[0].execute({}, makeExec({ id: 'agent1' }) as never)
  assert.equal(out.ok, true)
  assert.equal(out.compacted, true)
  assert.equal(out.shadowedItems, 2)
  assert.match(out.message ?? '', /Compacted 2 history items/)
})

test('compact: empty compaction (null) → "no compactable history"', async () => {
  const { defs, ctx } = setup()
  ctx.compaction.compactNow = async () => null
  const out: { compacted?: boolean; message?: string } = await defs[0].execute({}, makeExec({ id: 'a' }) as never)
  assert.equal(out.compacted, false)
  assert.match(out.message ?? '', /No compactable history/)
})

test('compact: ManualCompactionError busy → human receipt', async () => {
  const { defs, ctx } = setup()
  ctx.compaction.compactNow = async () => { throw new ManualCompactionError('busy', 'agent busy') }
  const out: { compacted?: boolean; message?: string } = await defs[0].execute({}, makeExec({ id: 'a' }) as never)
  assert.equal(out.compacted, false)
  assert.match(out.message ?? '', /already in progress|idle/)
})

test('context: reads the ledger and echoes the config flag', async () => {
  const { defs, ledger } = setup()
  ledger.recordSummary({ shadowedSeqs: [1, 2, 3], shadowedTokenCount: 30, provider: 'deepseek', model: 'dsv3' })
  const out: Record<string, unknown> = await defs[1].execute({}, makeExec() as never)
  assert.equal(out.hasCompactions, true)
  assert.equal(out.count, 1)
  assert.equal(out.totalShadowedTokens, 30)
  assert.equal(out.lastProvider, 'deepseek')
  assert.equal(out.autoStandAside, true)
})

test('recall: surfaces the most recent summary, capped by the arg', async () => {
  const { defs, ledger } = setup()
  ledger.recordSummary({ shadowedSeqs: [1, 2], shadowedTokenCount: 10, summaryText: 'A'.repeat(50) })
  const out: { hadCompaction?: boolean; summary?: string; shadowedTokens?: number } =
    await defs[2].execute({ limit: 5 }, makeExec() as never)
  assert.equal(out.hadCompaction, true)
  assert.equal(out.summary, 'AAAAA')
  assert.equal(out.shadowedTokens, 10)
})

test('recall: nothing compacted yet → hadCompaction false', async () => {
  const { defs } = setup()
  const out: { hadCompaction?: boolean } = await defs[2].execute({}, makeExec() as never)
  assert.equal(out.hadCompaction, false)
})
