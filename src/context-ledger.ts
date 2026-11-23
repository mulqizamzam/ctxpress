/**
 * The plugin-owned context ledger: a bounded, ordered record of the compactions this
 * session has observed, plus the aggregate numbers `ctxpress:context` / `/ctx` report.
 *
 * It is deliberately free of the Cordis runtime so it can be unit-tested and reused as
 * a pure module. Observation is wired up in the plugin entry; persistence is optional
 * and best-effort here (the file is a snapshot, not a source of truth across copies).
 * @module ctxpress/context-ledger
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One observed compaction, as seen on `compaction/summary`. */
export interface LedgerEntry {
  /** Epoch ms the summary was observed. */
  readonly ts: number
  /** Surface seqs of the shadowed nodes, in surface order. */
  readonly shadowedSeqs: readonly number[]
  /** Heuristic token count of the shadowed content. */
  readonly shadowedTokenCount: number
  /** The provider route that wrote the summary, when logged. */
  readonly provider?: string
  /** The model that wrote the summary, when logged. */
  readonly model?: string
  /** Plain-text projection of the summary blocks, bounded by `summaryLimit`. */
  readonly summaryText?: string
  /** Stable identity of this compaction's durable lifecycle, when the event logged one. */
  readonly compactionId?: string
  /** Log seq of the `compaction/summary` event this entry was observed from, when known. */
  readonly summarySeq?: number
}

/** The status view `ctxpress:context` / `/ctx` render. */
export interface LedgerStatus {
  /** Whether the ledger has observed any compaction yet. */
  readonly hasCompactions: boolean
  /** Number of compactions currently held (bounded). */
  readonly count: number
  /** Cumulative shadowed tokens across the held entries. */
  readonly totalShadowedTokens: number
  /** The most-recent entry, when any. */
  readonly last: LedgerEntry | undefined
}

/** What `ctxpress:recall` / `/ctx recall` return for the most recent compaction. */
export interface LedgerRecall {
  readonly hadCompaction: boolean
  readonly last: LedgerEntry | undefined
}

const MAX_ENTRIES = 50

/**
 * The context ledger. Threaded through the plugin entry; one instance per plugin load.
 * @param summaryLimit — max chars retained per entry's `summaryText` (mirrors the recall cap).
 */
export class ContextLedger {
  private readonly entries: LedgerEntry[] = []
  private readonly totalShadowedTokens = { value: 0 }
  private readonly summaryLimit: number

  constructor(summaryLimit: number = 4000) {
    this.summaryLimit = summaryLimit
  }

  /**
   * Record a `compaction/summary` observation.
   * @param evt — the projected summary fields; `ts` defaults to now.
   */
  recordSummary(evt: {
    readonly shadowedSeqs: readonly number[]
    readonly shadowedTokenCount: number
    readonly provider?: string
    readonly model?: string
    readonly summaryText?: string
    readonly compactionId?: string
    readonly summarySeq?: number
    readonly ts?: number
  }): void {
    const entry: LedgerEntry = {
      ts: evt.ts ?? Date.now(),
      shadowedSeqs: [...evt.shadowedSeqs],
      shadowedTokenCount: evt.shadowedTokenCount,
      ...evt.provider !== undefined ? { provider: evt.provider } : {},
      ...evt.model !== undefined ? { model: evt.model } : {},
      ...evt.summaryText !== undefined ? { summaryText: evt.summaryText.slice(0, this.summaryLimit) } : {},
      ...evt.compactionId !== undefined ? { compactionId: evt.compactionId } : {},
      ...evt.summarySeq !== undefined ? { summarySeq: evt.summarySeq } : {},
    }
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries.shift()
    this.totalShadowedTokens.value += entry.shadowedTokenCount
  }

  /** The status view over the held entries. */
  status(): LedgerStatus {
    const last = this.entries.at(-1)
    return {
      hasCompactions: this.entries.length > 0,
      count: this.entries.length,
      totalShadowedTokens: this.totalShadowedTokens.value,
      last,
    }
  }

  /**
   * The entry held at one position, counted from the newest.
   * `0` = most recent, `1` = second-most recent, and so on.
   * @param index — non-negative integer offset from the newest entry.
   * @returns the entry, or `undefined` when the index is negative, non-integer, or out of range.
   */
  entry(index: number): LedgerEntry | undefined {
    if (!Number.isInteger(index) || index < 0) return undefined
    return this.entries.at(-1 - index)
  }

  /** Recall a compaction by its offset from the newest; `0` (the default) is the most recent. */
  recall(index?: number): LedgerRecall {
    const last = this.entry(index ?? 0)
    return { hadCompaction: last !== undefined, last }
  }

  /**
   * Best-effort persist the current snapshot. Returns true when a file was written.
   * The snapshot holds conversation-derived summary text, so it is created owner-only
   * (0o600); a pre-existing file keeps its mode.
   */
  save(stateDir: string | undefined): boolean {
    if (stateDir === undefined) return false
    try {
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(join(stateDir, 'ctxpress-ledger.json'), JSON.stringify({ version: 2, entries: this.entries, totalShadowedTokens: this.totalShadowedTokens.value }, null, 2), { mode: 0o600 })
      return true
    } catch {
      return false
    }
  }
}

/**
 * Parse a persisted ledger snapshot (v2, or a legacy v1-shaped file) back into
 * normalized entries. Pure and read-only: it never writes, and returns
 * `undefined` for anything that is not a well-formed snapshot object.
 *
 * `totalShadowedTokens` is always recomputed as the sum of the normalized
 * entries — the value stored in the file is never trusted. This is the
 * rehydration path for a future boot-load; it has no call site in `apply()`.
 * @param raw — the raw file text, or `undefined` when no file was read.
 * @returns the normalized snapshot, or `undefined` when the input is unusable.
 */
export function parseSnapshot(raw: string | undefined): { entries: LedgerEntry[]; totalShadowedTokens: number } | undefined {
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const candidate = parsed as { entries?: unknown }
  if (!Array.isArray(candidate.entries)) return undefined

  const entries: LedgerEntry[] = []
  for (const item of candidate.entries) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const e = item as Record<string, unknown>
    const entry: LedgerEntry = {
      ts: typeof e.ts === 'number' ? e.ts : 0,
      shadowedSeqs: Array.isArray(e.shadowedSeqs) ? e.shadowedSeqs.filter((s) => typeof s === 'number') : [],
      shadowedTokenCount: typeof e.shadowedTokenCount === 'number' ? e.shadowedTokenCount : 0,
      ...typeof e.provider === 'string' ? { provider: e.provider } : {},
      ...typeof e.model === 'string' ? { model: e.model } : {},
      ...typeof e.summaryText === 'string' ? { summaryText: e.summaryText } : {},
      ...typeof e.compactionId === 'string' ? { compactionId: e.compactionId } : {},
      ...typeof e.summarySeq === 'number' ? { summarySeq: e.summarySeq } : {},
    }
    entries.push(entry)
  }
  const totalShadowedTokens = entries.reduce((sum, e) => sum + e.shadowedTokenCount, 0)
  return { entries, totalShadowedTokens }
}
