/**
 * The always-on gate entry (`ctxpress-gate`), mirroring billion-context's `bili-compaction-gate`.
 *
 * The main `ctxpress` plugin declares the lane is owned; this gate lives in its OWN entry so
 * that disabling or kill-switching the main plugin never leaves the DSH presets waiting on a
 * service no one provides — they fall back to stock compaction instead. This is the #3662
 * pattern: the gate carries the service the preset gate rows wait on.
 *
 * `buildOverlayRows` is the single source of truth for the bundle-patch overlay, so the
 * shipped `dsh.bundle.patch.yml` and the code can never drift apart (enforced by a test).
 * @module ctxpress/gate
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig, type CtxpressConfig } from './config.js'

export const name = 'ctxpress-gate'
export const inject: string[] = []

/** One row of a DSH `cordis.patch.yml` / bundle-patch overlay. */
export interface OverlayRow {
  readonly id: string
  readonly config: Record<string, unknown>
}

/**
 * Build the overlay rows ctxpress needs on DSH 0.2.3:
 *  - `compaction-basic` stood aside (`auto: false`) when the lane is owned, so the model-driven
 *    tools are the sole compaction trigger; otherwise leave it untouched.
 *
 * Retry-code additions are deliberately NOT emitted here: in 0.2.3 the `retryPolicy` lives
 * under each provider row and the provider row id is build-specific, so the row can only be
 * documented by hand (`dsh.bundle.patch.yml` carries the note). There is no config knob for
 * it.
 */
export function buildOverlayRows(config: CtxpressConfig = resolveConfig()): OverlayRow[] {
  const rows: OverlayRow[] = []
  if (config.autoStandAside) {
    rows.push({ id: 'compaction-basic', config: { auto: false } })
  }
  return rows
}

/**
 * Apply the gate. Non-strict: reads the compaction service only when present so it never blocks
 * boot on an older DSH build that has not mounted the seam yet.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  const config = resolveConfig()
  const logger = ctx.logger('ctxpress-gate')
  ctx.effect(function* () {
    logger.info?.(`ctxpress lane owned; auto-stand-aside ${config.autoStandAside ? 'on' : 'off'}`)
    // A service the preset gate rows can wait on; present so long as this entry is alive.
    // Only the lane facts go on the bus — no local paths (stateDir) or other resolved
    // config that consumers of this service should not see.
    const gate = { owned: true, autoStandAside: config.autoStandAside }
    yield ctx.provide('ctxpressLaneOwner', gate)
  }, 'ctxpress gate lifecycle')
}
