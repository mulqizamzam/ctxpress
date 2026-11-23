# ctxpress — design

## Intent

`billion-context` (ranxianglei) is a context-compression proxy that supports many agent
hosts; its **dsh** lane is a Cordis plugin (`bili-native` + `bili-compaction-gate`) loaded
through a bundle-patch overlay. This project **imitates** that DSH lane and rebuilds it,
from scratch, as a standalone DSH-native plugin for **DSH 0.2.3-alpha.2** — same *design*,
new code, no dependency on the billion-context package, no wire interception.

## What it is / is not

- **Is:** a two-module Cordis plugin:
  - `ctxpress` (main) — model-callable native tools, a `/ctx` command, a system-prompt
    compression-guidance section, and a plugin-owned **context ledger** that observes DSH's
    `compaction/*` events.
  - `ctxpress-gate` (always-on) — a load-time stand-aside so the main plugin can be disabled
    without leaving presets pending, plus the DSH 0.2.3 overlay rows.
- **Is not:** a reimplementation of the compression kernel or a network proxy. DSH already
  does LLM-based compaction through its `compaction` seam; ctxpress adds the **model-facing
  surface + observability + gating** that billion-context provides on DSH.

## Approach (chosen of three)

| | approach | status |
|---|---|---|
| A | thin adapter that re-exports the published `billion-context` dsh entry | rejected — user wants a *new* plugin, not a wrapper |
| B | self-contained fork copying bili's lane + proxy | rejected — drags the multi-MB kernel |
| **C (chosen)** | **new DSH-native plugin imitating bili's DSH surface, riding DSH's own seams** | **built** |

## DSH 0.2.3 seams the plugin rides on (verified against this checkout)

- `ctx.tools.register(defineTool({ ... execute(args, exec) }))` — `exec.agent?: Agent`, `exec.signal`.
- `ctx.commands.register({ definitionId, name, description, input?, handler(invocation) })` — `invocation.agent`, `invocation.signal`, `invocation.rawInput`, `invocation.commandId`.
- `ctx.compaction.compactNow(agent, signal, commandId) -> CompactionResult | null` (the manual compaction seam; `ManualCompactionError` codes: busy/cancelled/changed/summary/commit/persistence).
- `ctx.systemPrompt.section({ name, order: ctx.systemPrompt.getSectionOrder(X), text: ({scope}) => ..., retirement })`.
- `ctx.get('sessionQuery', false)` — the optional live-preferred read seam; `readSession(id) -> { header, inheritedEventCount, events }` (async, exact). Absent on keyless harnesses → recall expand degrades to a receipt. Only exact reads are used (full-text `searchEvents` is opt-in on stock profiles).
- Events: `compaction/summary` (provider, model, shadowedSeqs, shadowedTokenCount, usage), `compaction/end`, `user/message`.
- Overlay row ids in 0.2.3: `compaction-basic` (`config: { auto: false }`); retry codes live **per provider** under `retryPolicy.retryableCodes` — `MALFORMED_RESPONSE` is a valid `retryChoice` here.

## Tool / command surface

| id | behavior |
|---|---|
| `ctxpress:compact` | runs `ctx.compaction.compactNow(exec.agent, exec.signal, …)`; graceful "no agent / no compactable history" when unavailable (keyless). |
| `ctxpress:context` | status from the ledger: auto-compaction on/off, last compaction (shadowed tokens, provider, model, when), running shadowed total. |
| `ctxpress:recall` | re-surface a compacted range: shadowed seqs + the summary the backend wrote by default; `expand=true` re-surfaces the original shadowed transcript via the optional `ctx.sessionQuery` exact read; `index` selects which observed compaction. |
| `/ctx` | no-arg = status; `/ctx compact` = compact; `/ctx recall [chars]` = recall; `/ctx recall expand [chars]` = expanded recall of the newest compaction. |

## Scope calls (my calls, correctable)

- **Ledger is plugin-scoped & in-memory**, with best-effort JSON persistence to
  `~/.local/state/ctxpress/` (mirrors bili's shared-state-dir convention). No cross-process
  multi-copy management — out of scope for v0.
- **recall is summary-first; expand rides the read seam.** The default path returns the
  shadowed seqs + the backend summary. `expand=true` re-surfaces the original shadowed
  transcript by riding the optional `ctx.sessionQuery` exact read (no new storage, no
  synchronous session-log reads — DSH's `2026-09-09` deprecation policy: on-demand history
  is explicit asynchronous reads only). Absent service → a `no-session-query` receipt; a
  log that holds none of the entry's seqs → a `NO_MATCHING_EVENTS` receipt; never a crash,
  never a silent empty result. The ledger records `compactionId` + the summary event's
  `seq` (v2 snapshot) so receipts are attributable.
- **retry-code overlay** ships the row but, like bili, **no-ops with a warning** when the
  target provider row is absent on a given DSH build — never a boot failure.

## Verification

- Unit tests: `npm test` (ledger, config, command, tool argument validation, and the
  `session/event` ledger-feed regression) — no model, no network.
- Type gate: `npm run typecheck` (`tsc -p tsconfig.json --noEmit`) — the seam typings are
  checked against the DSH checkout; this is what would have caught the `compaction/summary`
  miswiring, since the build itself is esbuild (no type-check).
- Keyless load: `npm run verify` (script `verify/load-verify.ts`) boots a keyless AgentLoop
  the way DSH's own tests do, mounts `ctxpress` + `ctxpress-gate`, and asserts all three
  tools and the `/ctx` command register in the real service registries, then executes
  `ctxpress_context` through the real pipeline. `npm run verify:dist` does the same against
  the built `dist/`. The standalone-loader composition (`cordis.yml` + `verify/driver.ts`)
  is the bin.js variant of the same check.
