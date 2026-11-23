import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextLedger, parseSnapshot } from '../src/context-ledger'

test('empty ledger reports no compactions', () => {
  const l = new ContextLedger()
  const s = l.status()
  assert.equal(s.hasCompactions, false)
  assert.equal(s.count, 0)
  assert.equal(s.totalShadowedTokens, 0)
  assert.equal(l.recall().hadCompaction, false)
})

test('recordSummary accumulates and recalls the most recent', () => {
  const l = new ContextLedger(100)
  l.recordSummary({ shadowedSeqs: [1, 2, 3], shadowedTokenCount: 100, provider: 'deepseek', model: 'dsv', summaryText: 'first' })
  l.recordSummary({ shadowedSeqs: [4, 5], shadowedTokenCount: 50, summaryText: 'second' })
  const s = l.status()
  assert.equal(s.hasCompactions, true)
  assert.equal(s.count, 2)
  assert.equal(s.totalShadowedTokens, 150)
  assert.equal(s.last?.shadowedSeqs.length, 2)
  assert.equal(s.last?.summaryText, 'second')
  const r = l.recall()
  assert.equal(r.hadCompaction, true)
  assert.equal(r.last?.model, undefined) // most recent entry carried no model
})

test('recordSummary caps the retained summaryText at the ledger limit', () => {
  const l = new ContextLedger(4)
  l.recordSummary({ shadowedSeqs: [1], shadowedTokenCount: 1, summaryText: 'ABCDEFGHIJ' })
  assert.equal(l.recall().last?.summaryText, 'ABCD')
})

test('save persists a JSON snapshot into the state dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctxpress-'))
  const l = new ContextLedger(100)
  l.recordSummary({ shadowedSeqs: [1], shadowedTokenCount: 5 })
  assert.equal(l.save(dir), true)
  // No state dir configured → no write, reports false.
  assert.equal(l.save(undefined), false)
})

test('save creates the snapshot owner-only (0o600)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctxpress-'))
  const l = new ContextLedger(100)
  l.recordSummary({ shadowedSeqs: [1], shadowedTokenCount: 5 })
  assert.equal(l.save(dir), true)
  const mode = statSync(join(dir, 'ctxpress-ledger.json')).mode & 0o777
  assert.equal(mode, 0o600)
})

test('recordSummary carries compactionId and summarySeq when supplied', () => {
  const l = new ContextLedger()
  l.recordSummary({ shadowedSeqs: [1, 2], shadowedTokenCount: 9, compactionId: 'c-1', summarySeq: 42 })
  assert.deepEqual(l.entry(0)?.compactionId, 'c-1')
  assert.equal(l.entry(0)?.summarySeq, 42)
})

test('entry(index): 0 = newest, 1 = second-newest, out-of-range → undefined', () => {
  const l = new ContextLedger()
  l.recordSummary({ shadowedSeqs: [1], shadowedTokenCount: 1 })
  l.recordSummary({ shadowedSeqs: [2], shadowedTokenCount: 2 })
  assert.deepEqual(l.entry(0)?.shadowedSeqs, [2])
  assert.deepEqual(l.entry(1)?.shadowedSeqs, [1])
  assert.equal(l.entry(2), undefined)
  assert.equal(l.entry(-1), undefined)
  assert.equal(l.entry(1.5), undefined)
})

test('save writes version 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctxpress-ledger-'))
  const l = new ContextLedger()
  l.recordSummary({ shadowedSeqs: [1], shadowedTokenCount: 5 })
  assert.equal(l.save(dir), true)
  const parsed = JSON.parse(readFileSync(join(dir, 'ctxpress-ledger.json'), 'utf8'))
  assert.equal(parsed.version, 2)
})

test('parseSnapshot: v2 round-trip and v1-shaped file both load', () => {
  const v2 = JSON.stringify({ version: 2, entries: [{ ts: 1, shadowedSeqs: [1], shadowedTokenCount: 5, compactionId: 'c', summarySeq: 7 }], totalShadowedTokens: 5 })
  const r2 = parseSnapshot(v2)
  assert.equal(r2?.entries.length, 1)
  assert.equal(r2?.entries[0].compactionId, 'c')
  assert.equal(r2?.totalShadowedTokens, 5)
  const v1 = JSON.stringify({ entries: [{ ts: 1, shadowedSeqs: [9], shadowedTokenCount: 3 }], totalShadowedTokens: 3 })
  const r1 = parseSnapshot(v1)
  assert.equal(r1?.entries.length, 1)
  assert.equal(r1?.entries[0].shadowedSeqs?.[0], 9)
  assert.equal(r1?.entries[0].compactionId, undefined)
})

test('parseSnapshot: garbage, missing entries, or undefined → undefined', () => {
  assert.equal(parseSnapshot(undefined), undefined)
  assert.equal(parseSnapshot('not json'), undefined)
  assert.equal(parseSnapshot(JSON.stringify({ entries: 'nope' })), undefined)
})
