# ctxpress Recall Re-Expansion (Expand Mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `expand` mode to `ctxpress_recall` / `/ctx recall` so the model can re-surface the *original* shadowed transcript (not just the summary) of a compacted range, riding DSH's `sessionQuery` exact reads.

**Architecture:** The plugin already owns a context ledger fed by the `compaction/summary` session event (it holds `shadowedSeqs` per observed compaction). Expand mode adds: the ledger records `compactionId` + the summary event's `seq` (v2 snapshot), a pure transcript renderer (`src/recall-render.ts`), and an async driver (`src/recall.ts`) that lazily reads `ctx.get('sessionQuery', false).readSession(agent.id)`, filters the log to the entry's `shadowedSeqs`, and renders `User:` / `Assistant:` / `Tool call:` / `Tool result:` lines under a new `expandLimit` cap. Missing service → structured `unavailable` receipt, never a crash.

**Tech Stack:** TypeScript (ESM, esbuild build, no runtime deps beyond the existing `@deepseek-ai/*` seam typings), `node:test` + `tsx` unit tests, keyless DSH AgentLoop verify harness.

**Spec:** `docs/superpowers/specs/2026-11-23-recall-reexpansion-design.md` (read it first; this plan is its concrete argumentation).

## Global Constraints

- DSH target 0.2.3-alpha.2; ride seams only (`ctx.tools`, `ctx.commands`, `ctx.systemPrompt.section`, `ctx.sessionQuery` exact reads, the `session/event` feed). No wire interception, no new storage, no new runtime dependencies.
- **No new synchronous session-event reads** — `Session.eventAt` / `snapshotEvents` / `ownEvents` are deprecated and prohibited for new production code (DSH repo policy). All history access goes through `sessionQuery.readSession` (async).
- Expand availability is **optional**: a composition without `sessionQuery` (including the keyless verify harness) must degrade to an `unavailable` receipt, never a boot failure or crash.
- Full-text `sessionQuery.searchEvents` is opt-in on stock profiles (`openAt: never`); expand must not depend on it — exact reads only.
- Output receipts keep `additionalProperties: false` JSON schemas; model-facing text changes are reviewed as prompt changes.
- All new behavior is model/user-triggered; the `ctxpress-gate` overlay rows are unchanged.
- No model, no network in any test or verify path.

## Review Focus

Five input classes / failure modes the spec implies; each is pinned by a test named in the owning task:

1. **Expand targeted an entry whose `shadowedSeqs` are absent from the log** (resume/replay skew, or the agent id belongs to a different session) → `read-failed` receipt with `readErrorCode: 'NO_MATCHING_EVENTS'`, never an empty "expanded" success. — Task 4, test `expandReceipt: zero matching events → NO_MATCHING_EVENTS`.
2. **`sessionQuery` present but `readSession` rejects with a non-`SessionQueryError`** (unexpected throw, no `.code`) → `read-failed` with `readErrorCode: 'UNEXPECTED'`, error logged, no crash. — Task 4, test `expandReceipt: unexpected error → UNEXPECTED`.
3. **`limit` arg invalid in expand mode** (non-finite, zero, negative, non-number) → falls back to `config.expandLimit`, mirroring the summary path's cap rule. — Task 4, test `expandReceipt: invalid limit arg falls back to expandLimit`.
4. **`index` out of range** (≥ held entries) → `no-compaction` receipt (`hadCompaction: false`), not a silent shift to the newest entry. — Task 4, test `expandReceipt: out-of-range index → no-compaction` (via `ledger.entry()` test in Task 2 + driver test).
5. **A v1 snapshot file (no `version`, no new fields) on disk while running v2 code** → `parseSnapshot` tolerates it; `save` writes `version: 2`. No boot rehydration, so user-visible behavior is unchanged. — Task 2, test `parseSnapshot accepts a v1-shaped file`.

---

### Task 1: Config — `expandLimit` knob

**Files:**
- Modify: `src/config.ts` (`CtxpressConfig`, `CtxpressInput`, `resolveConfig`)
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `CtxpressConfig.expandLimit: number` (default `8000`; precedence `CTXPRESS_EXPAND_LIMIT` env > `file.expandLimit` > default; non-positive → `8000` — same positive-integer floor pattern as `recallLimit`).

- [ ] **Step 1: Write the failing tests** in `tests/config.test.ts`

```ts
test('expandLimit defaults to 8000', () => {
  assert.equal(resolveConfig({}, {}).expandLimit, 8000)
})
test('expandLimit: env beats file beats default', () => {
  assert.equal(resolveConfig({ expandLimit: 5000 }, { CtxPRESS_EXPAND_LIMIT: '123' }).expandLimit, 123)
  assert.equal(resolveConfig({ expandLimit: 5000 }, {}).expandLimit, 5000)
})
test('expandLimit: non-positive env falls back to default', () => {
  assert.equal(resolveConfig({}, { CtxPRESS_EXPAND_LIMIT: '0' }).expandLimit, 8000)
  assert.equal(resolveConfig({}, { CtxPRESS_EXPAND_LIMIT: 'abc' }).expandLimit, 8000)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --import tsx --test tests/config.test.ts`
Expected: FAIL — `expandLimit` is `undefined` (property missing).

- [ ] **Step 3: Implement in `src/config.ts`**

Add `expandLimit?: number` to `CtxpressInput` and `readonly expandLimit: number` to `CtxpressConfig`. In `resolveConfig`, next to the `recallLimit` block:

```ts
const rawExpandLimit =
  envInt(env, 'CTXPRESS_EXPAND_LIMIT')
  ?? file.expandLimit
  ?? 8000
const expandLimit = rawExpandLimit > 0 ? rawExpandLimit : 8000
```

and return `expandLimit` in the config object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test tests/config.test.ts`
Expected: PASS (all config tests, old + new).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): add CtxPRESS_EXPAND_LIMIT knob (default 8000)"
```

---

### Task 2: Ledger v2 — `compactionId`/`summarySeq`, `entry(index)`, snapshot `version: 2` + pure `parseSnapshot`

**Files:**
- Modify: `src/context-ledger.ts`
- Test: `tests/context-ledger.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks rely on these exact shapes):
  - `LedgerEntry` gains `readonly compactionId?: string` and `readonly summarySeq?: number`.
  - `recordSummary(evt)` accepts optional `compactionId?: string` and `summarySeq?: number` (stored when present).
  - `entry(index: number): LedgerEntry | undefined` — `0` = newest, `1` = second-newest, …; negative, non-integer, or out-of-range → `undefined`.
  - `recall(index?: number): LedgerRecall` — delegates to `entry(index ?? 0)` (existing one-arg callers keep working).
  - `save(stateDir)` writes `{ version: 2, entries, totalShadowedTokens }` (same 0o600 behavior).
  - `export function parseSnapshot(raw: string | undefined): { entries: LedgerEntry[]; totalShadowedTokens: number } | undefined`
    - `undefined` / invalid JSON / non-object / `entries` not an array → `undefined`.
    - Accepts `version` `2`, `1`, or absent; keeps object items and normalizes: `ts` (number, else `0`), `shadowedSeqs` (number[] else `[]`), `shadowedTokenCount` (number else `0`), optional strings only when `typeof string` (`provider`, `model`, `summaryText`, `compactionId`), `summarySeq` only when `typeof number`.
    - `totalShadowedTokens` is recomputed as the sum of the normalized entries (never trusted from the file).
    - **No call site in `apply()`** — boot rehydration is a v2 candidate (spec non-goal).

- [ ] **Step 1: Write the failing tests** in `tests/context-ledger.test.ts`

```ts
test('recordSummary carries compactionId and summarySeq when supplied', () => {
  const l = new ContextLedger()
  l.recordSummary({ shadowedSeqs: [1, 2], shadowedTokenCount: 9, compactionId: 'c-1', summarySeq: 42 })
  assert.deepEqual(l.entry(0)?.compactionId, 'c-1')
  assert.equal(l.entry(0)?.summarySeq, 42)
})

test('entry(index): 0 = newest, 1 = second-newest, out-of-range → undefined', () => {
  const l = new ContextLedger()
  l.recordSummary({ shadowedSeqs: [1], shadowedTokenCount: 1 })
  l.recordSummary({ shadowedSeqs: [2], shadowedTokenCount: 2 })
  assert.deepEqual(l.entry(0)?.shadowedSeqs, [2])
  assert.deepEqual(l.entry(1)?.shadowedSeqs, [1])
  assert.equal(l.entry(2), undefined)
  assert.equal(l.entry(-1), undefined)
  assert.equal(l.entry(1.5), undefined)
})

test('save writes version 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctxpress-ledger-'))
  const l = new ContextLedger()
  l.recordSummary({ shadowedSeqs: [1], shadowedTokenCount: 5 })
  assert.equal(l.save(dir), true)
  const parsed = JSON.parse(readFileSync(join(dir, 'ctxpress-ledger.json'), 'utf8'))
  assert.equal(parsed.version, 2)
})

test('parseSnapshot: v2 round-trip and v1-shaped file both load', () => {
  const v2 = JSON.stringify({ version: 2, entries: [{ ts: 1, shadowedSeqs: [1], shadowedTokenCount: 5, compactionId: 'c', summarySeq: 7 }], totalShadowedTokens: 5 })
  const r2 = parseSnapshot(v2)
  assert.equal(r2?.entries.length, 1)
  assert.equal(r2?.entries[0].compactionId, 'c')
  assert.equal(r2?.totalShadowedTokens, 5)
  const v1 = JSON.stringify({ entries: [{ ts: 1, shadowedSeqs: [9], shadowedTokenCount: 3 }], totalShadowedTokens: 3 })
  const r1 = parseSnapshot(v1)
  assert.equal(r1?.entries.length, 1)
  assert.equal(r1?.entries[0].shadowedSeqs?.[0], 9)
  assert.equal(r1?.entries[0].compactionId, undefined)
})

test('parseSnapshot: garbage, missing entries, or undefined → undefined', () => {
  assert.equal(parseSnapshot(undefined), undefined)
  assert.equal(parseSnapshot('not json'), undefined)
  assert.equal(parseSnapshot(JSON.stringify({ entries: 'nope' })), undefined)
})
```

(Update the existing `save persists a JSON snapshot` test if it asserts the old file shape — add the `version` expectation; keep the 0o600 test as-is.)

- [ ] **Step 2: Run to verify they fail**

Run: `node --import tsx --test tests/context-ledger.test.ts`
Expected: FAIL — `entry`, `parseSnapshot`, and the new `recordSummary` fields don't exist.

- [ ] **Step 3: Implement in `src/context-ledger.ts`**

- Extend `LedgerEntry` and the `recordSummary` input/spread (mirror the `provider`/`model` conditional-spread pattern).
- `entry(index)`: `if (!Number.isInteger(index) || index < 0) return undefined; return this.entries.at(-1 - index)` (note: `Array.at` with a negative index is valid here because it's only reached after the integer guard; keep the guard explicit).
- `recall(index = 0)`: `const last = this.entry(index); return { hadCompaction: last !== undefined, last }`.
- `save`: add `version: 2` to the written object.
- `parseSnapshot` as a pure exported function per the interface rules above.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test tests/context-ledger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/context-ledger.ts tests/context-ledger.test.ts
git commit -m "feat(ledger): v2 fields (compactionId/summarySeq), entry(index), parseSnapshot"
```

---

### Task 3: Transcript renderer (`src/recall-render.ts`)

**Files:**
- Create: `src/recall-render.ts`
- Test: `tests/recall-render.test.ts`

**Interfaces:**
- Consumes: `textOf` from `src/tools-text.js` (existing); `SessionEvent` type from `@deepseek-ai/dsh-session/types` (devDep, type-only import — erased at build).
- Produces:

```ts
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
export function renderTranscript(events: readonly SessionEvent[], limit: number): { text: string; truncated: boolean }
```

- [ ] **Step 1: Write the failing tests** in `tests/recall-render.test.ts`

Synthetic events are plain object literals shaped like `SessionEvent` (cast `as never` at the call site, matching how existing tests fake DSH types):

```ts
const ev = (seq: number, type: string, data: unknown): never => ({ seq, time: 0, type, data }) as never

test('renders user/assistant/tool-call/tool-result lines in input order', () => {
  const events = [
    ev(1, 'user/message', { content: [{ type: 'text', text: 'hi' }] }),
    ev(2, 'assistant/message', { message: { content: [{ type: 'text', text: 'hello' }] } }),
    ev(3, 'tool/call', { name: 'read', arguments: '{"p":"a"}' }),
    ev(4, 'tool/result', { message: { content: [{ type: 'text', text: 'file body' }], isError: false } }),
  ]
  const { text, truncated } = renderTranscript(events, 4000)
  assert.equal(text, 'User: hi\nAssistant: hello\nTool call: read {"p":"a"}\nTool result: file body')
  assert.equal(truncated, false)
})

test('skips log-only and unrecognized event types', () => {
  const events = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'compaction/summary', { shadowedSeqs: [1] }),
    ev(3, 'user/message', { content: [{ type: 'text', text: 'hi' }] }),
  ]
  assert.equal(renderTranscript(events, 100).text, 'User: hi')
})

test('marks interrupted assistant messages and errored tool results', () => {
  const events = [
    ev(1, 'assistant/message', { message: { content: [{ type: 'text', text: 'partial' }] }, interrupted: true }),
    ev(2, 'tool/result', { message: { content: [{ type: 'text', text: 'oops' }], isError: true } }),
  ]
  assert.equal(renderTranscript(events, 100).text, 'Assistant: partial [interrupted]\nTool result: oops [error]')
})

test('drops events whose projected text is empty; keeps bare tool/call', () => {
  const events = [
    ev(1, 'user/message', { content: [] }),
    ev(2, 'tool/call', { name: 'bash', arguments: '' }),
  ]
  assert.equal(renderTranscript(events, 100).text, 'Tool call: bash')
})

test('caps at limit keeping the oldest lines, with an elided-chars marker', () => {
  const events = [ev(1, 'user/message', { content: [{ type: 'text', text: 'A'.repeat(60) }] })]
  const { text, truncated } = renderTranscript(events, 50)
  assert.equal(truncated, true)
  assert.match(text, /\[truncated: \d+ chars elided\]/)
  assert.ok(text.length <= 50 + 40) // cap + marker
})

test('empty input → empty text, not truncated', () => {
  assert.deepEqual(renderTranscript([], 100), { text: '', truncated: false })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test tests/recall-render.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/recall-render.ts`**

Rendering table (deterministic; the caller passes pre-filtered, pre-ordered events):

| event `type` | line |
|---|---|
| `user/message` | `User: ${textOf(data.content)}` — skip when `textOf` is `''` |
| `assistant/message` | `Assistant: ${textOf(data.message.content)}` + ` [interrupted]` when `data.interrupted === true` — skip when projected text is `''` |
| `tool/call` | `Tool call: ${data.name} ${data.arguments}` — always emitted (arguments may be empty) |
| `tool/result` | `Tool result: ${textOf(data.message.content)}` + ` [error]` when `data.message.isError` — skip when projected text is `''` |
| anything else | skipped |

`text = lines.join('\n')`; `truncated = text.length > limit`; when truncated: `text = text.slice(0, limit) + `\n[truncated: ${text.length - limit} chars elided]``.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test tests/recall-render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recall-render.ts tests/recall-render.test.ts
git commit -m "feat(recall): pure transcript renderer with oldest-kept cap"
```

---

### Task 4: Expand driver (`src/recall.ts`)

**Files:**
- Create: `src/recall.ts`
- Test: `tests/recall.test.ts`

**Interfaces:**
- Consumes: `ContextLedger.entry` (Task 2), `renderTranscript` (Task 3), `CtxpressConfig` (Task 1), `textOf` for summary mode.
- Produces:

```ts
export interface SessionQueryLike {
  readonly readSession: (sessionId: unknown, signal?: AbortSignal) => Promise<{ readonly events: readonly SessionEvent[] }>
}
export interface RecallArgs { readonly limit?: number; readonly expand?: boolean; readonly index?: number }
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
export function summaryReceipt(entry: LedgerEntry | undefined, limit: number, config: CtxpressConfig): RecallReceipt
export interface ExpandParams {
  readonly entry: LedgerEntry | undefined        // caller pre-resolved via ledger.entry(index)
  readonly agentId: string | undefined           // caller passes String(exec.agent.id) or undefined
  readonly getSessionQuery: () => SessionQueryLike | undefined
  readonly args: RecallArgs
  readonly config: CtxpressConfig
  readonly signal: AbortSignal
  /** Diagnostics sink for read failures (logged, never model-facing beyond the code). Optional; no-op when absent. */
  readonly logger?: (error: unknown) => void
}
export async function expandReceipt(params: ExpandParams): Promise<RecallReceipt>
```

Locked semantics:
- `summaryReceipt`: `entry === undefined` → `{ hadCompaction: false, mode: 'unavailable', unavailableReason: 'no-compaction' }`. Else → `{ hadCompaction: true, mode: 'summary', shadowedSeqs, shadowedTokens, compactionId? (when present on entry), summary: entry.summaryText !== undefined ? entry.summaryText.slice(0, limit) : '(no summary retained)' }`.
- `expandReceipt`:
  1. `entry === undefined` → no-compaction (as above).
  2. `agentId === undefined` → `{ hadCompaction: true, mode: 'unavailable', unavailableReason: 'no-agent', shadowedSeqs, shadowedTokens, compactionId? }`.
  3. `getSessionQuery() === undefined` → same shape, `unavailableReason: 'no-session-query'`.
  4. `cap = (typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0) ? Math.floor(args.limit) : config.expandLimit`.
  5. `snap = await sq.readSession(agentId, signal)` inside try/catch:
     - `signal.aborted` → `readErrorCode: 'ABORTED'`;
     - else `typeof (e as { code?: unknown }).code === 'string'` → that code;
     - else `'UNEXPECTED'` (and log via an injected `logger?: (e: unknown) => void` parameter on `ExpandParams` — default no-op; the tool passes `ctx.logger('ctxpress').error`).
     - any of these → `{ hadCompaction: true, mode: 'unavailable', unavailableReason: 'read-failed', readErrorCode, shadowedSeqs, shadowedTokens, compactionId? }`.
  6. Order-preserving filter: `events = entry.shadowedSeqs.map((seq) => snap.events.find((e) => e.seq === seq)).filter((e) => e !== undefined)`.
  7. `events.length === 0` → `{ ..., unavailableReason: 'read-failed', readErrorCode: 'NO_MATCHING_EVENTS' }`.
  8. `{ text, truncated } = renderTranscript(events, cap)` → `{ hadCompaction: true, mode: 'expanded', shadowedSeqs, shadowedTokens, compactionId?, transcript: text, truncated, expandedChars: text.length }`.

- [ ] **Step 1: Write the failing tests** in `tests/recall.test.ts`

Use a fake ledger via `ContextLedger` (real class) and a `getSessionQuery` closure over an object literal implementing `SessionQueryLike`:

```ts
test('summaryReceipt: no entry → no-compaction; with entry → capped summary + entry fields', () => { ... })
test('expandReceipt: out-of-range index → no-compaction', async () => {
  // entry: undefined (caller resolved ledger.entry(99) on a 1-entry ledger)
})
test('expandReceipt: no agent → no-agent receipt', async () => { ... })
test('expandReceipt: no sessionQuery → no-session-query receipt', async () => {
  // getSessionQuery: () => undefined
})
test('expandReceipt: successful expand renders the shadowed transcript', async () => {
  // entry shadowedSeqs [1,2]; readSession resolves { events: [user seq1, assistant seq2] }
  // assert mode 'expanded', transcript contains 'User:' and 'Assistant:', expandedChars > 0
})
test('expandReceipt: zero matching events → NO_MATCHING_EVENTS', async () => {
  // entry shadowedSeqs [50]; readSession resolves { events: [user seq1] }
  // assert unavailableReason 'read-failed', readErrorCode 'NO_MATCHING_EVENTS'
})
test('expandReceipt: typed error carries its code; unexpected error → UNEXPECTED; aborted → ABORTED', async () => { ... })
test('expandReceipt: invalid limit arg falls back to expandLimit', async () => {
  // args.limit: 0, -3, 'x', NaN → transcript capped at config.expandLimit
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --import tsx --test tests/recall.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/recall.ts`** per the locked semantics (the step list IS the algorithm — implement it verbatim).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test tests/recall.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recall.ts tests/recall.test.ts
git commit -m "feat(recall): expand driver over sessionQuery exact reads with receipt grading"
```

---

### Task 5: Wire the tool, command, prompt, and ledger feed

**Files:**
- Modify: `src/tools.ts` (`ctxpress_recall` definition)
- Modify: `src/command.ts` (recall branch + `USAGE`)
- Modify: `src/prompt.ts` (recall bullet)
- Modify: `src/index.ts` (pass `compactionId`/`summarySeq` into `recordSummary`)
- Modify: `tests/helpers.ts` (`FakeCtx.get`)
- Test: `tests/tools.test.ts`, `tests/command.test.ts`, `tests/index.test.ts`

**Interfaces:**
- Consumes: `summaryReceipt` / `expandReceipt` / `RecallReceipt` / `SessionQueryLike` (Task 4); `ledger.entry` (Task 2); `config.expandLimit` (Task 1).
- Produces: the model-visible `ctxpress_recall` schema below; `/ctx recall expand [chars]`.

`ctxpress_recall` tool (replaces the current definition at `src/tools.ts:124-158`):

- `description`: `Re-surface a compacted range: the harness summary by default, or the original shadowed transcript with expand=true. index selects which observed compaction (0 = newest). Read-only.`
- `parameters`:
  - `limit` (number) — `Max characters of the summary (summary mode) or the transcript (expand mode). Defaults to the configured cap (recallLimit / expandLimit).`
  - `expand` (boolean) — `Set true to re-surface the original shadowed transcript instead of the summary.`
  - `index` (integer) — `Which observed compaction to recall, 0 = newest. Defaults to 0.`
- `output.schema` (all optional unless noted; `additionalProperties: false`):
  `hadCompaction` (boolean, required), `mode` (string, required; enum `summary`/`expanded`/`unavailable`), `unavailableReason` (string; enum `no-compaction`/`no-agent`/`no-session-query`/`read-failed`), `readErrorCode` (string), `shadowedSeqs` (array of integers), `shadowedTokens` (integer), `compactionId` (string), `summary` (string), `transcript` (string), `truncated` (boolean), `expandedChars` (integer)
- `render`:
  - `mode === 'unavailable'` → `[ctxpress] recall unavailable (${v.unavailableReason}${v.readErrorCode ? `: ${v.readErrorCode}` : ''}).`
  - `mode === 'summary'` → existing text: `[ctxpress] recalled ${v.shadowedSeqs?.length ?? 0} shadowed items (~${v.shadowedTokens ?? 0} tokens):\n${v.summary}`
  - `mode === 'expanded'` → `[ctxpress] expanded ${v.shadowedSeqs?.length ?? 0} shadowed items (~${v.shadowedTokens ?? 0} tokens): ${v.expandedChars} chars${v.truncated ? ' (truncated)' : ''}:\n${v.transcript}`
- `execute(args, exec)`:
  ```ts
  const index = Number.isInteger(args.index) && (args.index as number) >= 0 ? (args.index as number) : 0
  const entry = ledger.entry(index)
  if (args.expand === true) {
    return expandReceipt({
      entry,
      agentId: exec.agent !== undefined ? String(exec.agent.id) : undefined,
      getSessionQuery: () => ctx.get('sessionQuery', false) as SessionQueryLike | undefined,
      args,
      config,
      signal: exec.signal,
      logger: (e) => ctx.logger('ctxpress').error?.(e),
    })
  }
  const cap = typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : config.recallLimit
  return summaryReceipt(entry, cap, config)
  ```
  (Update the module doc comment: the three-tool story now includes expand.)

`/ctx` command (`src/command.ts`):
- `USAGE = 'Usage: /ctx [status|compact|recall [chars]|recall expand [chars]]'`; update the registered `description`/`input.hint` to match.
- Recall branch: `const rest = tokens.slice(1)`. When `rest[0] === 'expand' || rest[0] === 'e'`:
  - `chars = rest.slice(1).map(t => t.match(/^(\d+)$/u)?.[1]).find((s) => s !== undefined)` → `Number.parseInt(chars, 10)` (first integer token wins; extra tokens ignored) → pass as `args.limit` override; else use `config.expandLimit` via the driver's fallback (i.e. only set `limit` when found).
  - `entry = ledger.entry(0)` (command always expands the newest; index selection is tool-only — spec "left to builder" call, locking it here).
  - Call `expandReceipt` with `agentId: invocation.agent !== undefined ? String(invocation.agent.id) : undefined`, `getSessionQuery: () => ctx.get('sessionQuery', false) as SessionQueryLike | undefined`, `signal: invocation.signal`.
  - Result text: no-compaction → `Nothing compacted yet to recall.`; unavailable → `ctxpress: recall expand unavailable (${reason}${code ? `: ${code}` : ''}).`; expanded → `ctxpress: expanded recall of ${n} shadowed items (~${t} tokens), ${chars} chars${truncated ? ' (truncated)' : ''}:\n${transcript}` (kind `success` in all three — mirrors how the command currently treats receipts).
- The plain `recall [chars]` path keeps its current sync summary behavior (or route it through `summaryReceipt` — same text).

`prompt.ts`: replace the recall bullet with:
`'- ctxpress:recall — re-surface a compacted range: the harness summary by default, or the original shadowed transcript with expand=true. Use expand when you need the actual detail that was compressed away.'`

`index.ts`: in the `recordSummary` call, add `compactionId: evt.compactionId !== undefined ? String(evt.compactionId) : undefined` and `summarySeq: typeof event.seq === 'number' ? event.seq : undefined`.

`tests/helpers.ts`: add to `FakeCtx`: `readonly provided: Map<string, unknown>` and `get(name: string, _strict?: boolean): unknown { return this.provided.get(name) }` (tests seed via `ctx.provided.set('sessionQuery', stub)`).

Tests:
- `tests/tools.test.ts` — update the two existing recall tests (they now assert `mode: 'summary'` / `hadCompaction: false` shape) and add:
  - `expand: sessionQuery absent → no-session-query receipt` (no `provided.set`)
  - `expand: with stub sessionQuery → expanded receipt` (`ctx.provided.set('sessionQuery', { readSession: async () => ({ events: [fake user ev seq1, fake assistant ev seq2] }) })`; ledger entry with `shadowedSeqs: [1, 2]`; `makeExec({ id: 's' })`)
  - `expand: index out of range → no-compaction`
- `tests/command.test.ts` — add:
  - `/ctx recall expand` with a seeded ledger + `ctx.provided.set('sessionQuery', stub)` + `inv(' recall expand ')` → success text matches `/expanded recall of 2 shadowed items/`
  - `/ctx recall expand 3` caps the transcript (seed a long one; assert truncation or the 3-char prefix)
  - `/ctx recall expand` without `sessionQuery` → text matches `/unavailable \(no-session-query\)/`
  - `inv('bogus')` still returns usage (regression)
- `tests/index.test.ts` — extend the recall test: after `summaryEvent()` (seq 7, `compactionId: 'c1'`), assert `out.mode === 'summary'` and `out.compactionId === 'c1'`.

- [ ] **Step 1: Write the failing tests** (the test additions above, in the three files).
- [ ] **Step 2: Run to verify they fail**

Run: `node --import tsx --test tests/tools.test.ts tests/command.test.ts tests/index.test.ts`
Expected: FAIL — `ctxpress_recall` still returns the old shape; `FakeCtx.get` missing; command has no expand branch.

- [ ] **Step 3: Implement** the tool, command, prompt, index, and helpers changes per the locked shapes above.
- [ ] **Step 4: Run the whole suite**

Run: `node --import tsx --test tests/*.test.ts`
Expected: PASS (all suites green).

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts src/command.ts src/prompt.ts src/index.ts tests/helpers.ts tests/tools.test.ts tests/command.test.ts tests/index.test.ts
git commit -m "feat(recall): wire expand mode into ctxpress_recall, /ctx, prompt, and ledger feed"
```

---

### Task 6: Real-pipeline verify harness (stub `sessionQuery`)

**Files:**
- Create: `verify/stubs-session-query.ts`
- Modify: `verify/load-verify.ts`, `verify/load-verify-dist.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: a green `npm run verify` / `npm run verify:dist` that proves the expand receipt end-to-end in the real DSH tool pipeline.

`verify/stubs-session-query.ts` — a second verify-only module (same shape as `stubs.ts`):

```ts
export const name = 'ctxpress-verify-stub-session-query'
export function apply(ctx: Context): void {
  ctx.provide('sessionQuery', {
    readSession: async () => ({ events: [... ] }), // two events: user seq 10, assistant seq 11
  })
}
```
Seeded events must match the ledger seed the harness emits (below): `{ seq: 10, type: 'user/message', data: { content: [{ type: 'text', text: 'original user text' }] } }` and `{ seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'original assistant text' }] } } }` (cast with `as never` where typings complain — verify files already do this).

`load-verify.ts` (mirror into `load-verify-dist.ts`): after the existing mount + registration asserts, before the final `PASS` computation, add:

1. **Seed the ledger through the real feed:** `ctx.emit('session/event', undefined, { seq: 42, time: 0, type: 'compaction/summary', data: { compactionId: 'c-verify', summary: [{ type: 'text', text: 'sum' }], shadowedRange: { start: 10, end: 11 }, shadowedSeqs: [10, 11], shadowedTokenCount: 99, provider: 'p', model: 'm' } })` then `await settle(40)`.
   - If the real `EventsService` arity differs (listener receives `(session, event)`), adjust the emit args accordingly — the plugin listener signature is `(_session, event)`.
2. **Summary path:** execute `ctxpress_recall` with `arguments: '{}'` → assert the result text contains `recalled 2 shadowed items`.
3. **Negative expand (service absent):** execute `ctxpress_recall` with `arguments: '{"expand":true}'` and `agent: { id: 'sess-verify' }` (ToolBatchInput accepts `agent`):
   - When `ctx.get('sessionQuery', false) === undefined` (the expected keyless case): assert text matches `unavailable \(no-session-query\)`.
   - When a real `sessionQuery` happens to be mounted: skip this assert and log it (non-deterministic harness must not flake).
4. **Positive expand:** `await ctx.plugin(squStub as never)` (import of `stubs-session-query.ts`), `await settle(40)`, re-execute the same expand call → assert text matches `expanded 2 shadowed items` and contains `original user text` / `original assistant text`.
5. `ok = <all existing asserts> && <new asserts that ran>` → existing PASS/FAIL + exit code logic.

- [ ] **Step 1: Create `verify/stubs-session-query.ts`** and extend both verify scripts per the locked steps (write the asserts as `console.log` + booleans feeding `ok`, matching the existing style).
- [ ] **Step 2: Run the source-harness verify**

Run: `npm run verify`
Expected: `PASS` exit 0, with the new lines: summary receipt, `no-session-query` receipt (or the skip log), expanded receipt containing the seeded transcript lines.

- [ ] **Step 3: Build and run the dist-harness verify**

Run: `npm run build && npm run verify:dist`
Expected: same `PASS` against the built `dist/`.

- [ ] **Step 4: Commit**

```bash
git add verify/stubs-session-query.ts verify/load-verify.ts verify/load-verify-dist.ts
git commit -m "verify: sessionQuery stub + expand receipt assertions in both harnesses"
```

---

### Task 7: Docs + full gate

**Files:**
- Modify: `README.md` (tool reference, `/ctx` line, config table, "Honest boundaries"), `DESIGN.md` (scope calls + boundary note)

**Interfaces:** none (documentation only) — but this task is the merge gate.

- [ ] **Step 1: Update `README.md`:**
  - Tools table: `ctxpress_recall` row → "re-surface a compacted range: summary by default, or the original shadowed transcript with `expand=true`; `index` selects among observed compactions".
  - Command line: `/ctx recall [chars] | /ctx recall expand [chars]`.
  - Config table: add `| Expand cap | CtxPRESS_EXPAND_LIMIT | expandLimit | 8000 |`.
  - "Honest boundaries": replace "Recall is summary-first" with: "Recall expand rides `ctx.sessionQuery` exact reads (no new storage, no sync log reads); when the service is absent it reports `no-session-query` rather than fail."
- [ ] **Step 2: Update `DESIGN.md`:** add a scope call — "expand mode: optional `sessionQuery` read seam; no rehydration; no search" — and note the DSH `2026-09-09` deprecation compliance (async exact reads only).
- [ ] **Step 3: Run the full gate**

Run: `npm test && npm run typecheck && npm run build && npm run verify && npm run verify:dist`
Expected: all green. (`typecheck` is the gate that would catch a `sessionQuery` seam mismatch; `verify:dist` re-proves the built artifact after the dist rebuild.)

- [ ] **Step 4: Commit**

```bash
git add README.md DESIGN.md
git commit -m "docs: expand mode in README/DESIGN; full gate green"
```

---

## Execution notes

- Tasks 1–5 are strictly ordered (each consumes the previous interfaces); 6 needs 1–5; 7 last.
- If `ctx.emit('session/event', ...)` arity or `ToolBatchInput.agent` typing resists in Task 6, that's a harness-plumbing detail: keep the asserts, adjust the call shape, and note the deviation in the commit message — do not weaken an assert.
- `npm run typecheck` must pass at every commit boundary from Task 3 onward (it type-checks against the real DSH seam typings).
