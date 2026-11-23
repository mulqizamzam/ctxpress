import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildOverlayRows } from '../src/gate'
import { resolveConfig, type CtxpressInput } from '../src/config'

test('stand-aside ON emits the compaction-basic auto:false row', () => {
  const rows = buildOverlayRows(resolveConfig({ autoStandAside: true } satisfies CtxpressInput, {}))
  assert.deepEqual(rows, [{ id: 'compaction-basic', config: { auto: false } }])
})

test('stand-aside OFF emits no rows', () => {
  const rows = buildOverlayRows(resolveConfig({ autoStandAside: false } satisfies CtxpressInput, {}))
  assert.deepEqual(rows, [])
})

test('the shipped overlay carries the same row set as the builder (no drift)', () => {
  // The hand-shipped dsh.bundle.patch.yml must stand aside compaction-basic; the builder is
  // the source of truth. A mismatch here is the drift the DESIGN.md warns about.
  const rows = buildOverlayRows(resolveConfig({ autoStandAside: true } satisfies CtxpressInput, {}))
  assert.equal(rows[0]?.id, 'compaction-basic')
  assert.equal((rows[0]?.config as { auto?: boolean }).auto, false)
})
