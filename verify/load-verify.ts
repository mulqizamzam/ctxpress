/**
 * Real DSH load verification: boot a keyless DSH agent loop the way DSH's own tests do
 * (`mountAgentLoopTestDependencies` + `AgentLoop`), mount ctxpress, and assert the three
 * tools + the /ctx command registered in the REAL service registries, then execute one
 * tool through the real pipeline.
 *
 * Run: cd ctxpress && node --import tsx verify/load-verify.ts
 */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session } from '@deepseek-ai/dsh-session'
import commandsService from '@deepseek-ai/dsh-commands'
import * as compactionStub from './stubs.ts'
import * as squStub from './stubs-session-query.ts'
import * as ctxpress from '../src/index.ts'
import * as ctxpressGate from '../src/gate.ts'

const settle = (ms: number) => new Promise((r) => { setTimeout(r, ms) })

async function main(): Promise<void> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await settle(120)

  const needed = ['tools', 'commands', 'systemPrompt', 'sessionProjections', 'compaction']
  const presentNow = needed.filter((s) => ctx.get(s, false) !== undefined)
  const missing = needed.filter((s) => ctx.get(s, false) === undefined)
  console.log(`[load] services present after AgentLoop boot: ${presentNow.join(', ') || '(none)'}`)
  console.log(`[load] services missing after boot: ${missing.join(', ') || '(none)'}`)

  // Provide any missing service ctxpress injects: the command registry (class) and the
  // manual compaction seam (stub) when the keyless boot did not mount them.
  if (ctx.get('commands', false) === undefined) await ctx.plugin(commandsService as never)
  if (ctx.get('compaction', false) === undefined) await ctx.plugin(compactionStub as never)
  await settle(40)

  // Mount ctxpress main + the always-on gate. Don't await to completion: if a service is
  // still PENDING the fiber never settles; settle briefly and read the registries instead.
  let mountError: unknown = undefined
  try {
    const mainFiber = ctx.plugin(ctxpress as never)
    const gateFiber = ctx.plugin(ctxpressGate as never)
    await Promise.race([
      Promise.all([mainFiber, gateFiber]),
      new Promise((resolve) => { setTimeout(resolve, 1500) }),
    ])
  } catch (error) {
    mountError = error
  }
  await settle(150)
  console.log(`[load] ctxpress mount: ${mountError ? 'THREW ' + String((mountError as Error)?.message ?? mountError) : 'settled/raced'}`)

  const tools = ctx.get('tools') as { get: (n: string) => unknown; execute: (i: unknown) => Promise<{ results?: { result?: { content?: { text?: string }[] }[] }[] }> }
  const commands = ctx.get('commands') as { find: (a: unknown, n: string) => unknown }
  const names = ['ctxpress_compact', 'ctxpress_context', 'ctxpress_recall']
  const present = names.filter((n) => tools.get(n) !== undefined)
  const command = commands.find({} as never, 'ctx')
  console.log(`[load] ctxpress tools present: ${present.join(', ') || '(none)'}  ${present.length === 3 ? 'OK' : 'MISSING'}`)
  console.log(`[load] /ctx command registered: ${command ? 'OK' : 'NO'}`)

  const res = await tools.execute({
    calls: [{ type: 'tool-call', id: 'ctxpress-verify', name: 'ctxpress_context', arguments: '{}' }],
    signal: new AbortController().signal,
  })
  const block = res.results?.[0]?.result?.content?.[0]
  console.log(`[load] ctxpress_context execute → ${block?.text ?? JSON.stringify(res.results?.[0] ?? res)}`)

  // — Recall expand path over the real pipeline —

  const recallText = async (argsJson: string, agent?: unknown): Promise<string | undefined> => {
    const r = await tools.execute({
      calls: [{ type: 'tool-call', id: 'ctxpress-verify-recall', name: 'ctxpress_recall', arguments: argsJson }],
      signal: new AbortController().signal,
      ...(agent !== undefined ? { agent } : {}),
    })
    return r.results?.[0]?.result?.content?.[0]?.text
  }

  // 1. Seed the ledger through the real session/event feed (the plugin's own listener).
  //    A real (empty) Session instance is passed as the first arg: every other root-level
  //    `session/event` listener (the session-projection drive, persistence, telemetry) reads
  //    `session.header` / `session.snapshotEvents(...)`, so a bare `undefined` would crash
  //    them. An empty real session satisfies all of them; the plugin's ledger listener only
  //    reads the event payload + seq.
  const verifySession = Session.create('ctxpress-verify' as never)
  ctx.emit('session/event', verifySession, {
    seq: 42,
    time: 0,
    type: 'compaction/summary',
    data: {
      compactionId: 'c-verify',
      summary: [{ type: 'text', text: 'sum' }],
      shadowedRange: { start: 10, end: 11 },
      shadowedSeqs: [10, 11],
      shadowedTokenCount: 99,
      provider: 'p',
      model: 'm',
    },
  })
  await settle(40)

  // 2. Summary path: the seeded entry → 'recalled 2 shadowed items'.
  const summaryText = await recallText('{}')
  const summaryOk = summaryText !== undefined && summaryText.includes('recalled 2 shadowed items')
  console.log(`[load] ctxpress_recall {} → ${summaryText ?? '(no text)'}  ${summaryOk ? 'OK' : 'MISSING'}`)

  // 3. Negative expand: no sessionQuery service yet → no-session-query receipt. When a real
  //    sessionQuery happens to be mounted in this harness, skip the assert rather than flake.
  let expandNegativeOk = true
  if (ctx.get('sessionQuery', false) === undefined) {
    const negText = await recallText('{"expand":true}', { id: 'sess-verify' })
    expandNegativeOk = negText !== undefined && /unavailable \(no-session-query\)/.test(negText)
    console.log(`[load] ctxpress_recall {expand} (no sessionQuery) → ${negText ?? '(no text)'}  ${expandNegativeOk ? 'OK' : 'MISSING'}`)
  } else {
    console.log('[load] ctxpress_recall {expand} negative skipped: a real sessionQuery service is mounted in this harness')
  }

  // 4. Positive expand: mount the sessionQuery stub → expanded receipt with the seeded transcript.
  await ctx.plugin(squStub as never)
  await settle(40)
  const expandText = await recallText('{"expand":true}', { id: 'sess-verify' })
  const expandOk =
    expandText !== undefined &&
    expandText.includes('expanded 2 shadowed items') &&
    expandText.includes('original user text') &&
    expandText.includes('original assistant text')
  console.log(`[load] ctxpress_recall {expand} (stub sessionQuery) → ${expandText ?? '(no text)'}  ${expandOk ? 'OK' : 'MISSING'}`)

  const ok = present.length === 3 && command !== undefined && summaryOk && expandNegativeOk && expandOk
  console.log(`[load] ${ok ? 'PASS' : 'FAIL'}`)
  process.exit(ok ? 0 : 1)
}

main().catch((error) => {
  console.error('[load] FAILED', error)
  process.exit(2)
})
