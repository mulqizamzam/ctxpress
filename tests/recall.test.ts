/**
 * The recall driver: `summaryReceipt` (the summary-first path, now receipt-shaped)
 * and `expandReceipt` (the sessionQuery-backed transcript path with receipt grading).
 * The driver receives an already-resolved `LedgerEntry` (or `undefined`); tests
 * resolve entries through the real `ContextLedger` so the index math is exercised.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ContextLedger, type LedgerEntry } from '../src/context-ledger'
import { resolveConfig, type CtxpressConfig } from '../src/config'
import { expandReceipt, summaryReceipt, type RecallArgs, type SessionQueryLike } from '../src/recall'

const ev = (seq: number, type: string, data: unknown): never => ({ seq, time: 0, type, data }) as never

/** A ledger holding one standard entry (shadowedSeqs [1,2], compactionId c-1). */
function oneEntryLedger(over: Record<string, unknown> = {}): ContextLedger {
  const ledger = new ContextLedger(4000)
  ledger.recordSummary({ shadowedSeqs: [1, 2], shadowedTokenCount: 10, compactionId: 'c-1', summarySeq: 7, ...over } as never)
  return ledger
}

function standardEntry(): LedgerEntry {
  const e = oneEntryLedger().entry(0)
  if (e === undefined) throw new Error('test setup: expected an entry')
  return e
}

function sq(events: unknown[], opts: { code?: string; abortOnSignal?: boolean } = {}): SessionQueryLike {
  return {
    readSession: async (_id, signal) => {
      if (opts.abortOnSignal && signal?.aborted) throw new Error('aborted')
      if (opts.code !== undefined) throw Object.assign(new Error('read failed'), { code: opts.code })
      return { events: events as never }
    },
  }
}

const DEFAULT_EVENTS = () => [
  ev(1, 'user/message', { content: [{ type: 'text', text: 'hi' }] }),
  ev(2, 'assistant/message', { message: { content: [{ type: 'text', text: 'hello' }] } }),
]

interface Over {
  entry?: LedgerEntry | undefined
  agentId?: string | undefined
  getSessionQuery?: () => SessionQueryLike | undefined
  args?: RecallArgs
  config?: CtxpressConfig
  signal?: AbortSignal
  logger?: (error: unknown) => void
}

function expandParams(over: Over = {}) {
  return {
    entry: over.entry !== undefined ? over.entry : standardEntry(),
    agentId: over.agentId !== undefined ? over.agentId : 'agent-1',
    getSessionQuery: over.getSessionQuery ?? (() => sq(DEFAULT_EVENTS())),
    args: over.args ?? {},
    config: over.config ?? resolveConfig({}, {}),
    signal: over.signal ?? new AbortController().signal,
    logger: over.logger,
  }
}

test('summaryReceipt: no entry → no-compaction; with entry → capped summary + entry fields', () => {
  const cfg = resolveConfig({}, {})
  assert.deepEqual(summaryReceipt(undefined, 4000, cfg), { hadCompaction: false, mode: 'unavailable', unavailableReason: 'no-compaction' })
  const l = oneEntryLedger({ summaryText: 'X'.repeat(20) })
  const r = summaryReceipt(l.entry(0), 5, cfg)
  assert.equal(r.mode, 'summary')
  assert.equal(r.hadCompaction, true)
  assert.deepEqual(r.shadowedSeqs, [1, 2])
  assert.equal(r.shadowedTokens, 10)
  assert.equal(r.compactionId, 'c-1')
  assert.equal(r.summary, 'XXXXX')
  const bare = oneEntryLedger({ summaryText: undefined })
  const r2 = summaryReceipt(bare.entry(0), 5, cfg)
  assert.equal(r2.summary, '(no summary retained)')
})

test('expandReceipt: out-of-range index → no-compaction', async () => {
  const r = await expandReceipt({ ...expandParams({}), entry: oneEntryLedger().entry(99) })
  assert.deepEqual(r, { hadCompaction: false, mode: 'unavailable', unavailableReason: 'no-compaction' })
})

test('expandReceipt: no agent → no-agent receipt', async () => {
  const r = await expandReceipt({ ...expandParams({}), agentId: undefined })
  assert.equal(r.mode, 'unavailable')
  assert.equal(r.unavailableReason, 'no-agent')
  assert.equal(r.hadCompaction, true)
  assert.deepEqual(r.shadowedSeqs, [1, 2])
})

test('expandReceipt: no sessionQuery → no-session-query receipt', async () => {
  const r = await expandReceipt({ ...expandParams({}), getSessionQuery: () => undefined })
  assert.equal(r.mode, 'unavailable')
  assert.equal(r.unavailableReason, 'no-session-query')
})

test('expandReceipt: successful expand renders the shadowed transcript', async () => {
  const r = await expandReceipt(expandParams({}))
  assert.equal(r.mode, 'expanded')
  assert.equal(r.hadCompaction, true)
  assert.equal(r.transcript, 'User: hi\nAssistant: hello')
  assert.equal(r.truncated, false)
  assert.equal(r.expandedChars, (r.transcript ?? '').length)
  assert.equal(r.compactionId, 'c-1')
})

test('expandReceipt: zero matching events → NO_MATCHING_EVENTS', async () => {
  const l = oneEntryLedger({ shadowedSeqs: [50] })
  const r = await expandReceipt({
    ...expandParams({}),
    entry: l.entry(0),
    getSessionQuery: () => sq([ev(1, 'user/message', { content: [{ type: 'text', text: 'hi' }] })]),
  })
  assert.equal(r.mode, 'unavailable')
  assert.equal(r.unavailableReason, 'read-failed')
  assert.equal(r.readErrorCode, 'NO_MATCHING_EVENTS')
})

test('expandReceipt: typed error carries its code; unexpected error → UNEXPECTED; aborted → ABORTED', async () => {
  const typed = await expandReceipt({ ...expandParams({}), getSessionQuery: () => sq([], { code: 'SESSION_QUERY_CORRUPT_SESSION' }) })
  assert.equal(typed.readErrorCode, 'SESSION_QUERY_CORRUPT_SESSION')
  assert.equal(typed.unavailableReason, 'read-failed')

  const logged: unknown[] = []
  const unexpected = await expandReceipt({
    ...expandParams({}),
    getSessionQuery: () => ({ readSession: async () => { throw new Error('boom') } }),
    logger: (e) => { logged.push(e) },
  })
  assert.equal(unexpected.readErrorCode, 'UNEXPECTED')
  assert.equal(logged.length, 1)

  const controller = new AbortController()
  controller.abort()
  const r = await expandReceipt({
    ...expandParams({ getSessionQuery: () => sq([], { abortOnSignal: true }) }),
    signal: controller.signal,
  })
  assert.equal(r.readErrorCode, 'ABORTED')
})

test('expandReceipt: invalid limit arg falls back to expandLimit', async () => {
  const cfg = resolveConfig({ expandLimit: 12 }, {})
  const events = [ev(1, 'user/message', { content: [{ type: 'text', text: 'B'.repeat(40) }] })]
  for (const badLimit of [0, -3, Number.NaN, 'x' as unknown as number]) {
    const r = await expandReceipt({ ...expandParams({ config: cfg, args: { limit: badLimit } }), getSessionQuery: () => sq(events) })
    assert.equal(r.mode, 'expanded')
    assert.equal(r.truncated, true)
    assert.match(r.transcript ?? '', /\[truncated: \d+ chars elided\]/)
    assert.ok((r.transcript ?? '').length <= 12 + 40) // cap 12 + marker
  }
  const good = await expandReceipt({ ...expandParams({ config: cfg, args: { limit: 4000 } }), getSessionQuery: () => sq(events) })
  assert.equal(good.truncated, false)
})
