/**
 * The recall driver: builds the model-facing receipt for `ctxpress_recall`.
 *
 * Two paths:
 *   - `summaryReceipt` — the summary-first path (the pre-existing behavior, now
 *     receipt-shaped): the harness summary text, capped, plus the entry's facts.
 *   - `expandReceipt` — the expand path: re-surface the ORIGINAL shadowed
 *     transcript by riding the optional `ctx.sessionQuery` exact-read seam,
 *     filtering the session log to the entry's `shadowedSeqs`, and rendering it
 *     under the configured `expandLimit` cap.
 *
 * Both degrade to a structured `unavailable` receipt rather than throwing when
 * a prerequisite is missing (no compaction, no agent, no sessionQuery, or a
 * failed read) — never a crash, never a silent empty result.
 *
 * Free of the Cordis runtime: `sessionQuery` is supplied by the caller through
 * `getSessionQuery`, and the agent id is a plain string. This keeps the driver
 * unit-testable and lets the tool decide whether the seam is present.
 * @module ctxpress/recall
 */
import type { CtxpressConfig } from './config.js'
import type { LedgerEntry } from './context-ledger.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { renderTranscript } from './recall-render.js'

/**
 * The read seam the expand path rides. The live service is `ctx.sessionQuery`;
 * a verify stub or future backend satisfies this same shape. Kept minimal so
 * the driver never couples to the full engine.
 */
export interface SessionQueryLike {
  readonly readSession: (sessionId: unknown, signal?: AbortSignal) => Promise<{ readonly events: readonly SessionEvent[] }>
}

/** The `ctxpress_recall` arguments. */
export interface RecallArgs {
  /** Max characters of the summary (summary mode) or transcript (expand mode). */
  readonly limit?: number
  /** Set true to re-surface the original shadowed transcript instead of the summary. */
  readonly expand?: boolean
  /** Which observed compaction to recall, 0 = newest. */
  readonly index?: number
}

/** The model-facing recall receipt. `additionalProperties: false` at the tool boundary. */
export interface RecallReceipt {
  readonly hadCompaction: boolean
  readonly mode: 'summary' | 'expanded' | 'unavailable'
  readonly unavailableReason?: 'no-compaction' | 'no-agent' | 'no-session-query' | 'read-failed'
  readonly readErrorCode?: string
  readonly shadowedSeqs?: readonly number[]
  readonly shadowedTokens?: number
  readonly compactionId?: string
  readonly summary?: string
  readonly transcript?: string
  readonly truncated?: boolean
  readonly expandedChars?: number
}

export interface ExpandParams {
  /** The pre-resolved entry (via `ledger.entry(index)`); `undefined` = nothing compacted / out of range. */
  readonly entry: LedgerEntry | undefined
  /** The caller's session id (`String(exec.agent.id)`), or `undefined` when there is no active agent. */
  readonly agentId: string | undefined
  /** Resolves the optional sessionQuery read seam; `undefined` = the service is not mounted. */
  readonly getSessionQuery: () => SessionQueryLike | undefined
  readonly args: RecallArgs
  readonly config: CtxpressConfig
  readonly signal: AbortSignal
  /** Diagnostics sink for read failures (logged, never model-facing beyond the code). Optional; no-op when absent. */
  readonly logger?: (error: unknown) => void
}

/** The facts shared by every receipt that has an entry. */
function entryFacts(entry: LedgerEntry): Pick<RecallReceipt, 'hadCompaction' | 'shadowedSeqs' | 'shadowedTokens' | 'compactionId'> {
  return {
    hadCompaction: true,
    shadowedSeqs: entry.shadowedSeqs,
    shadowedTokens: entry.shadowedTokenCount,
    ...entry.compactionId !== undefined ? { compactionId: entry.compactionId } : {},
  }
}

/**
 * The summary-first receipt.
 * @param entry — the resolved entry; `undefined` → the no-compaction receipt.
 * @param limit — the resolved cap in characters (the caller folds `args.limit` / config in).
 * @param _config — carried for signature stability; the cap is already resolved by the caller.
 */
export function summaryReceipt(entry: LedgerEntry | undefined, limit: number, _config: CtxpressConfig): RecallReceipt {
  if (entry === undefined) return { hadCompaction: false, mode: 'unavailable', unavailableReason: 'no-compaction' }
  return {
    ...entryFacts(entry),
    mode: 'summary',
    summary: entry.summaryText !== undefined ? entry.summaryText.slice(0, limit) : '(no summary retained)',
  }
}

/**
 * The expand receipt: re-surface the original shadowed transcript via the optional
 * sessionQuery exact read, graded into a structured receipt on every failure path.
 */
export async function expandReceipt(params: ExpandParams): Promise<RecallReceipt> {
  const { entry, agentId, args, config, signal } = params

  // 1. Nothing compacted (or the requested index is out of range).
  if (entry === undefined) return { hadCompaction: false, mode: 'unavailable', unavailableReason: 'no-compaction' }
  const facts = entryFacts(entry)

  // 2. No active agent → cannot resolve a session id.
  if (agentId === undefined) return { ...facts, mode: 'unavailable', unavailableReason: 'no-agent' }

  // 3. The read seam is optional; absent → structured receipt, not a crash.
  const sq = params.getSessionQuery()
  if (sq === undefined) return { ...facts, mode: 'unavailable', unavailableReason: 'no-session-query' }

  // 4. Resolve the cap: a valid positive `args.limit` wins, else the configured expand cap.
  const cap = typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : config.expandLimit

  // 5. Read the session log; grade every failure into a `read-failed` receipt.
  let snap: { readonly events: readonly SessionEvent[] }
  try {
    snap = await sq.readSession(agentId, signal)
  } catch (error: unknown) {
    let code: string
    if (signal.aborted) code = 'ABORTED'
    else if (typeof (error as { code?: unknown })?.code === 'string') code = (error as { code: string }).code
    else code = 'UNEXPECTED'
    params.logger?.(error)
    return { ...facts, mode: 'unavailable', unavailableReason: 'read-failed', readErrorCode: code }
  }

  // 6. Order-preserving filter to the entry's shadowed seqs (surface order).
  const events = entry.shadowedSeqs
    .map((seq) => snap.events.find((e) => e.seq === seq))
    .filter((e): e is SessionEvent => e !== undefined)

  // 7. The log held none of the shadowed seqs → honest read-failed, not an empty success.
  if (events.length === 0) return { ...facts, mode: 'unavailable', unavailableReason: 'read-failed', readErrorCode: 'NO_MATCHING_EVENTS' }

  // 8. Render under the cap and return the expanded receipt.
  const { text, truncated } = renderTranscript(events, cap)
  return { ...facts, mode: 'expanded', transcript: text, truncated, expandedChars: text.length }
}
