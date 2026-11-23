import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerCtxpressCommand } from '../src/command'
import { ContextLedger } from '../src/context-ledger'
import { resolveConfig } from '../src/config'
import { makeCtx } from './helpers'

function setup() {
  const ctx = makeCtx()
  const ledger = new ContextLedger(100)
  const config = resolveConfig({}, {})
  registerCtxpressCommand(ctx as never, ledger, config)
  const def = ctx.registered.find((d) => d.name === 'ctx')
  if (def === undefined || def.handler === undefined) throw new Error('/ctx command did not register')
  return { ctx, ledger, config, def }
}

function inv(rawInput: string) {
  return { rawInput, agent: { id: 'a' }, signal: new AbortController().signal, commandId: 'cid' }
}

test('registers a single /ctx command with the expected definition', () => {
  const { ctx, def } = setup()
  assert.equal(ctx.registered.length, 1)
  assert.equal(def.description.length > 0, true)
})

test('default (empty input) → status receipt', async () => {
  const { def, ledger } = setup()
  ledger.recordSummary({ shadowedSeqs: [1, 2], shadowedTokenCount: 9, provider: 'p', model: 'm' })
  const r: { kind: string; text?: string } = await def.handler(inv(''))
  assert.equal(r.kind, 'success')
  assert.match(r.text ?? '', /compaction\(s\)|no compactions/i)
})

test('/ctx compact drives compactNow and returns the receipt', async () => {
  const { ctx, def } = setup()
  ctx.compaction.compactNow = async () => ({ shadowedSeqs: [1, 2, 3], shadowedTokenCount: 12 })
  const r: { kind: string; text?: string } = await def.handler(inv(' compact'))
  assert.equal(r.kind, 'success')
  assert.match(r.text ?? '', /Compacted 3 history items/)
})

test('/ctx recall [chars] caps the summary', async () => {
  const { def, ledger } = setup()
  ledger.recordSummary({ shadowedSeqs: [1, 2], shadowedTokenCount: 10, summaryText: 'X'.repeat(40) })
  const r: { kind: string; text?: string } = await def.handler(inv(' recall 4'))
  assert.equal(r.kind, 'success')
  assert.match(r.text ?? '', /XXXX/)
})

test('unknown subcommand → usage error', async () => {
  const { def } = setup()
  const r: { kind: string; text?: string } = await def.handler(inv('bogus'))
  assert.equal(r.kind, 'error')
  assert.match(r.text ?? '', /Usage/)
})
