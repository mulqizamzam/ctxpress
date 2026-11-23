# ctxpress — recall re-expansion (expand mode)

Date: 2026-11-23 · Status: proposed · DSH target: 0.2.3-alpha.2

## Intent

Today `ctxpress_recall` / `/ctx recall` is **summary-first**: it returns the shadowed
seqs + the summary text the harness wrote. Whatever the summarizer dropped is
unavailable to the model. This design adds **expand mode**: on demand, re-surface the
actual shadowed transcript (the original user/assistant/tool events) from the session
log, so a model that compacted its way past detail can read it back.

Why now: DSH's own architecture notes already bless this direction —
`2026-09-09-deprecate-synchronous-session-event-reads` says on-demand history must use
explicit asynchronous paged reads, and `2026-07-06-recallable-compaction` (proposed,
unshipped) describes exactly these tools as a future core package. Building a bounded,
plugin-side version now fills the gap without re-inventing the unshipped core design.

## Goals

- `ctxpress_recall` accepts `expand: true` and renders the shadowed transcript of a
  chosen compaction entry (default: most recent; `index` selects among ledger-held entries).
- The transcript is the real original events — `User:` / `Assistant:` / `Tool result:`
  lines — not the summary.
- Bounded: an `expandLimit` knob caps output; the existing `limit` knob still governs
  the summary-first path.
- Graceful: when the read seam is unavailable (no `sessionQuery` in composition, or
  keyless harness), expand returns a structured receipt naming the missing service —
  never a crash, never a silent empty result.
- Zero auto behavior: expand is only triggered by the model or `/ctx`; the gate is
  untouched.

## Non-goals

- **No full-text search over shadowed spans.** DSH's proposed `history_search` and the
  experimental `dsh-tool-session-query` own that surface; we don't duplicate it.
- **No cursor/pagination in v1.** One expand call, capped by `expandLimit`; the model
  can pick a different `index` or run a narrower follow-up. Cursor design waits for
  observed need (mirrors DSH's own deferred-work list).
- **No new compaction backend.** `compaction-basic` stays the backend; ctxpress keeps
  adding surface + gating only.
- **No cross-session recall.** The ledger is per-process; expand reads the caller's own
  session via `exec.agent`'s session id.
- **No stubs/state-checkpoint machinery.** That is the unshipped core design; when it
  lands, ctxpress' expand mode can ride its same read seam with no redesign.

## Constraints

- Must ride DSH 0.2.3-alpha.2 seams only: `ctx.sessionQuery` exact reads
  (`readSession`/`readEvent` windows), `ctx.tools`, `ctx.commands`,
  `ctx.systemPrompt.section`, the `session/event` feed. No wire interception, no new
  storage.
- **No new synchronous session-event reads** (`Session.eventAt` / `snapshotEvents` /
  `ownEvents` are deprecated; new production calls are prohibited by repo policy).
- Full-text `sessionQuery.searchEvents` is opt-in on stock profiles
  (`openAt: never`); exact reads remain available. Expand mode must not depend on
  search being enabled.
- The keyless verify harness (`npm run verify`) must stay green; it composes without
  a real `sessionQuery`, so expand availability must be optional-injected and
  receipt-graded like the existing "no active agent" paths.
- Ledger persistence stays a best-effort snapshot (0o600), never a cross-copy source
  of truth.

## Approaches considered

| # | Approach | Trade-off | Status |
|---|---|---|---|
| 1 | **Expand via `ctx.sessionQuery` exact reads** — ledger supplies `shadowedSeqs`; tool fetches the session snapshot, filters to those seqs, renders transcript | Rides the sanctioned async seam; zero new state; works on default profiles; depends on `sessionQuery` being mounted (it is, in base/web-app bundles) | **chosen** |
| 2 | Plugin-maintained shadowed-content projection (`SessionProjectionRegistry`) — capture shadowed spans incrementally from the live feed, restore on resume | No `sessionQuery` dependency, but re-implements what sessionQuery already provides; adds resume-restore state and a second persistence format; more to break | rejected for v1; remains an option if a composition genuinely lacks `sessionQuery` |
| 3 | Direct JSONL reads of `session-persistence-jsonl` root | No seam, version-fragile, bypasses storage boundaries | rejected |

## Design (approach 1)

### Data flow

```
model calls ctxpress_recall { expand: true, index?: n }
  → ledger.entry(index)            (shadowedSeqs + summary + compactionId, ts)
  → exec.agent → its session id
  → ctx.sessionQuery.readSession(sessionId)        (async, exact read)
  → filter events to entry.shadowedSeqs (surface order)
  → render transcript (User / Assistant / Tool result lines)
  → cap at expandLimit chars (oldest kept, newest truncated with marker)
  → tool text result + ledger note (expanded=chars, index)
```

### Parts

- **Ledger v2** — `LedgerEntry` gains optional `compactionId` and `summarySeq`
  (both already on the `compaction/summary` event; the plugin currently drops them).
  Snapshot file gains `version: 2`; loading a v1 file (or missing fields) degrades to
  the current behavior, never fails. **No load-on-boot rehydration in v1** — the
  non-goals keep the ledger per-process, so the snapshot stays write-only; `load()`
  is a tested pure parser (v2 + v1 degradation), with no `apply()` call site.
  Boot-hydration is a v2 candidate once cross-copy semantics are designed.
- **New module `src/recall.ts` (or same-named section in `tools.ts`)** — pure
  transcript renderer `renderTranscript(events, limit): { text, truncated }`
  (unit-testable, no Cordis dependency) + the async expand driver that resolves
  `sessionQuery` lazily (`ctx.get('sessionQuery')` at call time, not a hard `inject`).
- **Tool schema** — `ctxpress_recall` gains `expand` (bool, default false) and
  `index` (int ≥ 0 from newest, default 0). Output receipt fields: `mode:
  'summary' | 'expanded' | 'unavailable'`, `unavailableReason?: 'no-agent' |
  'no-compaction' | 'no-session-query' | 'read-failed'`,
  `readErrorCode?: string` (the typed `SessionQueryError` code, e.g.
  `SESSION_QUERY_SESSION_NOT_FOUND`, only on `read-failed`), `summary` (summary
  path) / `transcript` (expanded path — a dedicated field, never reusing
  `summary`), `expandedChars` on success. On `read-failed` the receipt names the
  failure; it never silently degrades to the summary receipt.
- **Command** — `/ctx recall` unchanged; `/ctx recall expand [chars]` and
  `/ctx recall expand <index> [chars]` trigger the expanded path. (Command syntax is
  the one place the builder may adjust to fit the existing parser; keep it
  parse-able by the current `command.ts` rules.)
- **Prompt section** — one added sentence in the compression-philosophy section,
  scoped on expand availability, so the model knows recall can re-surface originals.
- **Gate** — unchanged. `ctxpress-gate` carries no new rows.

### Config

| Knob | Env | File key | Default |
|---|---|---|---|
| Expand cap (chars) | `CTXPRESS_EXPAND_LIMIT` | `expandLimit` | `8000` |

Follows the existing env > file > default precedence.

## Verification

- **Unit** — `renderTranscript` (rendering, cap, truncation marker, mixed event
  types), ledger v2 load/save + v1-file degradation, tool arg validation
  (`expand`/`index`), and the `no-session-query` receipt path (stub context without
  the service).
- **Type gate** — `npm run typecheck` against the real DSH seam typings
  (`ctx.sessionQuery` exact-read signatures).
- **Real load** — extend `verify/stubs.ts` with a minimal `sessionQuery` stub
  (exact reads only) so `npm run verify` / `verify:dist` execute
  `ctxpress_recall { expand: true }` through the real pipeline and assert the
  expanded receipt; keyless no-stub run asserts the unavailable receipt.
- No model, no network anywhere in the test paths.

## Left to the builder

- Exact event-type → line rendering table (which `user/message`, `assistant/*`,
  tool-result shapes to render; skip log-only `compaction/*` and system head).
- Truncation direction (oldest-kept is the proposal; newest-kept is defensible).
- Whether `/ctx recall expand` reuses the renderer's cap or takes its own chars arg
  (proposal: the optional chars arg overrides `expandLimit` for that call).
- Where `compactionId` lands in the receipt text (proposal: footer line on expanded
  output, matching DSH's proposed checkpoint-footer convention).
