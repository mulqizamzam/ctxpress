import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
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
  // the source of truth. A mismatch here is the drift the DESIGN.md warns about. The yml is
  // a stable hand-shipped format, so the check is line-structural (no YAML dependency):
  // the non-comment lines must carry exactly the builder's row set.
  const yml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'dsh.bundle.patch.yml'), 'utf8')
  const lines = yml.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('#'))
  const builder = buildOverlayRows(resolveConfig({ autoStandAside: true } satisfies CtxpressInput, {}))
  assert.deepEqual(builder, [{ id: 'compaction-basic', config: { auto: false } }])
  // The overlay must mount both ctxpress entries...
  assert.ok(lines.includes('- id: ctxpress'), 'shipped overlay missing the ctxpress insert row')
  assert.ok(lines.includes('- id: ctxpress-gate'), 'shipped overlay missing the ctxpress-gate insert row')
  // ...and stand aside compaction-basic with auto: false, matching the builder row.
  const i = lines.indexOf('- id: compaction-basic')
  assert.notEqual(i, -1, 'shipped overlay missing the compaction-basic row')
  assert.ok(lines.slice(i, i + 3).includes('auto: false'), 'shipped overlay does not stand aside compaction-basic')
  // No config-row drift: with the gate on, the builder emits exactly the compaction-basic
  // stand-aside, so the shipped file must carry no other TOP-LEVEL config row (the insert
  // rows are indented and are entry mounts, not builder rows).
  const topLevelIdRows = yml.split('\n').filter((l) => /^- id:/.test(l)).map((l) => l.trim())
  assert.deepEqual(topLevelIdRows, ['- id: compaction-basic'], `shipped overlay rows drifted from the builder: ${topLevelIdRows.join(', ')}`)
})
