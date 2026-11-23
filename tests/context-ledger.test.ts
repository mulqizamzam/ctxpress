import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextLedger } from '../src/context-ledger'

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
