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
- Events: `compaction/summary` (provider, model, shadowedSeqs, shadowedTokenCount, usage), `compaction/end`, `user/message`.
- Overlay row ids in 0.2.3: `compaction-basic` (`config: { auto: false }`); retry codes live **per provider** under `retryPolicy.retryableCodes` — `MALFORMED_RESPONSE` is a valid `retryChoice` here.

## Tool / command surface

| id | behavior |
|---|---|
| `ctxpress:compact` | runs `ctx.compaction.compactNow(exec.agent, exec.signal, …)`; graceful "no agent / no compactable history" when unavailable (keyless). |
| `ctxpress:context` | status from the ledger: auto-compaction on/off, last compaction (shadowed tokens, provider, model, when), running shadowed total. |
| `ctxpress:recall` | re-surface the most-recent compacted range: shadowed seqs + the summary the backend wrote. |
| `/ctx` | no-arg = status; `/ctx compact` = compact; `/ctx recall` = recall. |

## Scope calls (my calls, correctable)

- **Ledger is plugin-scoped & in-memory**, with best-effort JSON persistence to
  `~/.local/state/ctxpress/` (mirrors bili's shared-state-dir convention). No cross-process
  multi-copy management — out of scope for v0.
- **recall is summary-first**: it returns the shadowed seqs + the backend summary, not a full
  re-expansion of shadowed nodes (that would require reaching into the session log, a larger
  seam). Noted as the honest boundary.
- **retry-code overlay** ships the row but, like bili, **no-ops with a warning** when the
  target provider row is absent on a given DSH build — never a boot failure.

## Verification

- Unit tests: `node --import tsx --test tests/*.test.ts` (ledger, config, command, tool
  argument validation) — no model, no network.
- Keyless load: `vendor/cordis/bin.js --config cordis.verify.yml` composes the real DSH
  service packages + `./dist/index.js` + `./dist/gate.js` and drives one `ctxpress:compact`
  and one `/ctx` through the real pipeline, proving the plugin loads and its surface wires up.
