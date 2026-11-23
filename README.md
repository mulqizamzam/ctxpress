# ctxpress — ContextPress

A **context-management plugin for DeepSeek Harness (DSH 0.2.3-alpha.2)**, written from
scratch as a DSH-native imitation of [`ranxianglei/billion-context`](https://github.com/ranxianglei/billion-context)
dsh lane. Same *design*, new code, **no dependency on the billion-context package**, **no
wire interception** — it rides DSH's own seams.

## What it does

billion-context's value on DSH is a model-facing context surface plus gating: native tools
that let an agent turn *self-direct* compaction, a live `/acp` status command, and a gate
that stands the host's stock auto-compaction aside. `ctxpress` reproduces that surface
against DSH 0.2.3's real services:

| Surface | What it rides |
|---|---|
| `ctxpress_compact` / `ctxpress_context` / `ctxpress_recall` (native tools) | `ctx.tools.register` + `ctx.compaction.compactNow` |
| `/ctx` command (`status` \| `compact` \| `recall [chars]`) | `ctx.commands.register` (mirrors DSH's own `/compact`) |
| A system-prompt "compression philosophy" section | `ctx.systemPrompt.section` |
| A context ledger fed by the `compaction/summary` event (single source of truth) | `ctx.on` + optional JSON persistence |
| The always-on gate + DSH 0.2.3 overlay rows | `compaction-basic` `auto:false`; per-provider `retryPolicy.retryableCodes` (adds `MALFORMED_RESPONSE`) |

## Two module entries

- **`ctxpress`** (main) — the tools, the `/ctx` command, the prompt section, and the ledger.
- **`ctxpress-gate`** (always-on) — declares the lane is owned so disabling the main plugin
  never leaves the DSH presets waiting on a service no one provides (the billion-context
  `bili-compaction-gate` pattern). Carries the overlay-row builder (`buildOverlayRows`).

## Install / mount

`ctxpress` is a Cordis plugin. Mount it in a DSH profile's `cordis.patch.yml` / bundle
overlay, alongside the DSH service packages it uses:

```yaml
# dsh.bundle.patch.yml (see the shipped file for the full overlay)
- insert:
    - id: ctxpress
      name: ctxpress            # resolves the package's main export → dist/index.js
    - id: ctxpress-gate
      name: ctxpress/gate       # resolves the ./gate export → dist/gate.js
- id: compaction-basic
  config:
    auto: false
```

The shipped `dsh.bundle.patch.yml` is the ready overlay for DSH 0.2.3. `ctxpress-gate`
`inject = []` so it stays alive even when the main plugin is kill-switched.

## Tool / command reference

- **`ctxpress_compact`** — compact older history via the harness compaction seam. With an
  active agent it drives `ctx.compaction.compactNow`; keyless it returns a structured
  "no active agent" receipt.
- **`ctxpress_context`** — read-only context pressure: auto-stand-aside on/off, compaction
  count, cumulative shadowed tokens, and the last provider/model.
- **`ctxpress_recall`** — re-surface the most recent compacted range (shadowed seqs + the
  summary the harness wrote), capped by an optional `limit` (default `CTXPRESS_RECALL_LIMIT`, 4000).
- **`/ctx`** — no-arg = status; `/ctx compact` = compact; `/ctx recall [chars]` = recall.

## Configuration (env > file > default)

| Knob | Env | File key | Default |
|---|---|---|---|
| Auto-stand-aside | `CTXPRESS_AUTO_STAND_ASIDE` | `autoStandAside` | `true` |
| Extra retry codes | `CTXPRESS_RETRY_CODES` | `extraRetryCodes` | `MALFORMED_RESPONSE` |
| State dir (ledger) | `CTXPRESS_STATE_DIR` | `stateDir` | unset (no persistence) |
| Recall cap | `CTXPRESS_RECALL_LIMIT` | `recallLimit` | `4000` |

## Verify

- **Unit tests** (no model, no network) — `npm test` (or `node --import tsx --test tests/*.test.ts`):
  28 assertions over config precedence, the ledger, tool argument validation + graceful
  no-agent paths, command parsing, and the gate's overlay-row builder.
- **Real DSH load** — `npm run verify` boots a keyless DSH AgentLoop the way DSH's own
  tests do, mounts `ctxpress` + `ctxpress-gate`, and asserts all three tools and the
  `/ctx` command register in the **real** service registries, then executes
  `ctxpress_context` through the real tool pipeline. `npm run verify:dist` does the same
  against the built `dist/` artifact.

## Honest boundaries

- **No compression kernel / no proxy.** DSH already summarizes through its own compaction
  backend (`compactNow`); `ctxpress` adds the model-facing surface, observability, and
  gating — the parts billion-context adds on top of a host.
- **Recall is summary-first.** It returns the shadowed seqs + the backend's summary, not a
  full re-expansion of shadowed nodes (that would reach into the session log, a larger seam).
- **The retry-code overlay** is version-specific: DSH 0.2.3 keeps `retryPolicy` under each
  provider row. `buildOverlayRows` ships the verified `compaction-basic` row; the retry row
  is documented in `dsh.bundle.patch.yml` and applied to your active provider row, no-op'ing
  with a warning when absent.

## Local dev / build note

The repo ships a prebuilt `dist/`. To rebuild, `esbuild` is required:

```sh
npm run build
```

Local verification resolves the `@deepseek-ai/*` packages from the DSH checkout by
symlinking them into `node_modules/@deepseek-ai/` (see `docs` in the repo / the link farm
this workspace uses). Published, the package depends on them normally from the registry.
