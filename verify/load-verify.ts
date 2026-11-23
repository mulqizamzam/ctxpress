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
import commandsService from '@deepseek-ai/dsh-commands'
import * as compactionStub from './stubs.ts'
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

  const ok = present.length === 3 && command !== undefined
  console.log(`[load] ${ok ? 'PASS' : 'FAIL'}`)
  process.exit(ok ? 0 : 1)
}

main().catch((error) => {
  console.error('[load] FAILED', error)
  process.exit(2)
})
