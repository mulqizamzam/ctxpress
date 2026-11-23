/**
 * ctxpress configuration: `env > file > default` resolution for the plugin's knobs.
 *
 * A knob is only added when it changes observable behavior; there are no
 * config-only conveniences. The resolver is pure and fully testable.
 * @module ctxpress/config
 */

/** The plugin's configuration after defaulting. */
export interface CtxpressConfig {
  /** Whether the gate plugin stands DSH's stock auto-compaction aside (`compaction-basic.auto: false`). */
  readonly autoStandAside: boolean
  /** Directory the context ledger persists its state JSON into (best-effort). */
  readonly stateDir: string | undefined
  /** Maximum characters `ctxpress:recall` / `/ctx recall` surface for one compacted range. */
  readonly recallLimit: number
  /** Maximum characters the recall expand path surfaces for one compacted range's original transcript. */
  readonly expandLimit: number
}

/** Raw, partially-specified config: every field is an env/file/default candidate. */
export interface CtxpressInput {
  readonly autoStandAside?: boolean
  readonly stateDir?: string
  readonly recallLimit?: number
  readonly expandLimit?: number
}

/** The process env block the resolver reads. Injected for testability. */
export type CtxpressEnv = Record<string, string | undefined>

function envBool(env: CtxpressEnv, key: string): boolean | undefined {
  const raw = env[key]
  if (raw === undefined || raw === '') return undefined
  return raw === '1' || raw.toLowerCase() === 'true'
}

function envInt(env: CtxpressEnv, key: string): number | undefined {
  const raw = env[key]
  if (raw === undefined || raw === '') return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Resolve the plugin configuration. Precedence is `env > file > default`, applied per key.
 * @param file - the file-level config (already parsed JSON; `{}` when absent).
 * @param env - the env block to read; `process.env` in production.
 * @returns the fully-defaulted configuration.
 */
export function resolveConfig(
  file: CtxpressInput = {},
  env: CtxpressEnv = process.env as CtxpressEnv,
): CtxpressConfig {
  const autoStandAside =
    envBool(env, 'CTXPRESS_AUTO_STAND_ASIDE')
    ?? file.autoStandAside
    ?? true

  // The recall cap must stay a positive integer: 0 or negative would truncate the
  // retained summary from the end (or surface nothing) in `recordSummary`/`recall`.
  const rawRecallLimit =
    envInt(env, 'CTXPRESS_RECALL_LIMIT')
    ?? file.recallLimit
    ?? 4000
  const recallLimit = rawRecallLimit > 0 ? rawRecallLimit : 4000

  // The expand cap must stay a positive integer for the same reason as recallLimit.
  const rawExpandLimit =
    envInt(env, 'CTXPRESS_EXPAND_LIMIT')
    ?? file.expandLimit
    ?? 8000
  const expandLimit = rawExpandLimit > 0 ? rawExpandLimit : 8000

  return {
    autoStandAside: autoStandAside === true,
    stateDir: file.stateDir ?? env.CTXPRESS_STATE_DIR,
    recallLimit,
    expandLimit,
  }
}
