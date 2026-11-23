/**
 * Regression test for the ledger feed: `apply()` must observe `compaction/summary`
 * on the `session/event` feed (session events never fire on the context bus by type
 * name), and the tools must reflect it. This is the path that was silently dead when
 * the plugin subscribed to `ctx.on('compaction/summary')` directly.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index'
import { makeCtx, makeExec } from './helpers'

/** A minimal `compaction/summary` session event (payload under `data`, as the feed carries it). */
function summaryEvent() {
  return {
    type: 'compaction/summary',
    seq: 7,
    time: 0,
    data: {
      compactionId: 'c1',
      summary: [{ type: 'text', text: 'sum' }],
      shadowedRange: { start: 1, end: 3 },
      shadowedSeqs: [1, 2, 3],
      shadowedTokenCount: 40,
      provider: 'p',
      model: 'm',
    },
  }
}

function tool(defs: { name: string }[], name: string) {
  const t = defs.find((d) => d.name === name)
  if (t === undefined) throw new Error(`tool ${name} not registered`)
  return t as { execute(args: unknown, exec?: unknown): Promise<unknown> | unknown }
}

test('apply() registers the session/event feed listener', () => {
  const ctx = makeCtx()
  apply(ctx as never)
  assert.equal(ctx.listeners.get('session/event')?.length, 1)
})

test('apply() feeds the ledger from a compaction/summary session event', async () => {
  const ctx = makeCtx()
  apply(ctx as never)
  ctx.listeners.get('session/event')?.[0]({}, summaryEvent())
  const out: Record<string, unknown> = await tool(ctx.registeredTools, 'ctxpress_context').execute({}, makeExec() as never)
  assert.equal(out.hasCompactions, true)
  assert.equal(out.count, 1)
  assert.equal(out.totalShadowedTokens, 40)
  assert.equal(out.lastProvider, 'p')
  assert.equal(out.lastModel, 'm')
})

test('apply() ignores non-summary session events', async () => {
  const ctx = makeCtx()
  apply(ctx as never)
  ctx.listeners.get('session/event')?.[0]({}, { type: 'user/message', seq: 1, time: 0, data: {} })
  const out: Record<string, unknown> = await tool(ctx.registeredTools, 'ctxpress_context').execute({}, makeExec() as never)
  assert.equal(out.hasCompactions, false)
})

test('recall surfaces the summary fed through the session/event listener', async () => {
  const ctx = makeCtx()
  apply(ctx as never)
  ctx.listeners.get('session/event')?.[0]({}, summaryEvent())
  const out: Record<string, unknown> = await tool(ctx.registeredTools, 'ctxpress_recall').execute({}, makeExec() as never)
  assert.equal(out.hadCompaction, true)
  assert.equal(out.mode, 'summary')
  assert.deepEqual(out.shadowedSeqs, [1, 2, 3])
  assert.equal(out.summary, 'sum')
  assert.equal(out.compactionId, 'c1')
})
