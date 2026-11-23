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
| `ctxpress_compact` / `ctxpress_context` / `ctxpress_recall` (native tools) | `ctx.tools.register` + `ctx.compaction.compactNow` (+ optional `ctx.sessionQuery` exact read for recall expand) |
| `/ctx` command (`status` \| `compact` \| `recall [chars]` \| `recall expand [chars]`) | `ctx.commands.register` (mirrors DSH's own `/compact`) |
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
- **`ctxpress_recall`** — re-surface a compacted range: the shadowed seqs + the summary the
  harness wrote by default, or the original shadowed transcript with `expand=true` (capped by
  the expand limit); `index` selects which observed compaction (0 = newest); `limit` caps the
  surfaced text (default summary cap `CTXPRESS_RECALL_LIMIT` 4000 / expand cap
  `CTXPRESS_EXPAND_LIMIT` 8000). Expand rides the optional `ctx.sessionQuery` exact read;
  without it the receipt reports `no-session-query`.
- **`/ctx`** — no-arg = status; `/ctx compact` = compact; `/ctx recall [chars]` = recall;
  `/ctx recall expand [chars]` = expanded recall of the newest compaction.

## Configuration (env > file > default)

| Knob | Env | File key | Default |
|---|---|---|---|
| Auto-stand-aside | `CTXPRESS_AUTO_STAND_ASIDE` | `autoStandAside` | `true` |
| State dir (ledger) | `CTXPRESS_STATE_DIR` | `stateDir` | unset (no persistence) |
| Recall cap | `CTXPRESS_RECALL_LIMIT` | `recallLimit` | `4000` |
| Expand cap | `CTXPRESS_EXPAND_LIMIT` | `expandLimit` | `8000` |

(The per-provider `retryPolicy.retryableCodes` addition is not a knob: DSH 0.2.3
keeps retry policy under each provider row, and the provider row id is build-specific.
`dsh.bundle.patch.yml` documents the row to add by hand — see its retry-code note.)

## Verify

- **Unit tests** (no model, no network) — `npm test` (or `node --import tsx --test tests/*.test.ts`):
  covers config precedence, the ledger, tool argument validation + graceful no-agent
  paths, command parsing, the gate's overlay-row builder (including a real no-drift check
  against the shipped `dsh.bundle.patch.yml`), and the `session/event` ledger-feed
  regression (the summary must arrive via the session feed, not a dead context-bus name).
- **Type gate** — `npm run typecheck` runs `tsc` over `src/` against the real DSH seam
  typings; this is the check that would have caught the `compaction/summary` miswiring,
  since the build itself is esbuild (no type-check). `npm run build:types` emits the
  declaration files the published `types` field points at.
- **Real DSH load** — `npm run verify` boots a keyless DSH AgentLoop the way DSH's own
  tests do, mounts `ctxpress` + `ctxpress-gate`, and asserts all three tools and the
  `/ctx` command register in the **real** service registries, then executes
  `ctxpress_context` through the real tool pipeline and drives `ctxpress_recall`
  summary / expand receipts end-to-end (seeding the ledger through the real
  `session/event` feed, and a verify-only `sessionQuery` stub for the expand path).
  `npm run verify:dist` does the same against the built `dist/` artifact.

## Honest boundaries

- **No compression kernel / no proxy.** DSH already summarizes through its own compaction
  backend (`compactNow`); `ctxpress` adds the model-facing surface, observability, and
  gating — the parts billion-context adds on top of a host.
- **Recall is summary-first; expand rides the read seam.** The default path returns the
  shadowed seqs + the backend's summary. `expand=true` re-surfaces the original shadowed
  transcript by riding the optional `ctx.sessionQuery` exact read (no new storage, no
  synchronous log reads — DSH's `2026-09-09` deprecation policy). When the service is
  absent it reports a `no-session-query` receipt rather than fail; when the log holds none
  of the entry's seqs it reports `NO_MATCHING_EVENTS` rather than an empty success.
- **The retry-code overlay** is version-specific: DSH 0.2.3 keeps `retryPolicy` under each
  provider row. `buildOverlayRows` ships the verified `compaction-basic` row; the retry row
  is documented in `dsh.bundle.patch.yml` and applied to your active provider row, no-op'ing
  with a warning when absent.

## Local dev / build note

The repo ships a prebuilt `dist/`. To rebuild, `esbuild` is required:

```sh
npm run build
```

Local verification resolves the `@deepseek-ai/*` packages from a DSH checkout by
symlinking them into `node_modules/@deepseek-ai/` (an environment-specific link farm; it
is gitignored and not part of the published package). To build locally without the
registry, the `typescript` / `esbuild` / `@types/node` dev tools are likewise linked from
the host checkout's store into `node_modules/` (also gitignored). Published, the package
depends on the pinned `@deepseek-ai/*` versions from the registry.
