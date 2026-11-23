import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, type CtxpressInput } from '../src/config'

function envOf(input: Record<string, string | undefined>): Record<string, string | undefined> {
  return input
}

test('defaults (no file, no env)', () => {
  const c = resolveConfig({}, {})
  assert.equal(c.autoStandAside, true)
  assert.equal(c.recallLimit, 4000)
  assert.equal(c.stateDir, undefined)
})

test('file layer applies when env is absent', () => {
  const file: CtxpressInput = { autoStandAside: false, recallLimit: 11 }
  const c = resolveConfig(file, {})
  assert.equal(c.autoStandAside, false)
  assert.equal(c.recallLimit, 11)
})

test('env overrides file, per key', () => {
  const file: CtxpressInput = { autoStandAside: false, recallLimit: 11 }
  const c = resolveConfig(file, envOf({ CTXPRESS_AUTO_STAND_ASIDE: '1', CTXPRESS_RECALL_LIMIT: '7' }))
  assert.equal(c.autoStandAside, true) // env wins over file
  assert.equal(c.recallLimit, 7) // env wins over file
})

test('non-positive recallLimit falls back to the default', () => {
  assert.equal(resolveConfig({}, envOf({ CTXPRESS_RECALL_LIMIT: '0' })).recallLimit, 4000)
  assert.equal(resolveConfig({}, envOf({ CTXPRESS_RECALL_LIMIT: '-3' })).recallLimit, 4000)
  assert.equal(resolveConfig({ recallLimit: 0 }, {}).recallLimit, 4000)
})

test('env stateDir passes through', () => {
  const c = resolveConfig({}, envOf({ CTXPRESS_STATE_DIR: '/tmp/ctx' }))
  assert.equal(c.stateDir, '/tmp/ctx')
})
