/**
 * Shared fakes for the unit tests: a minimal `ctx` that captures `commands.register`,
 * pumps `ctx.effect` generators to completion, and exposes a stub `compaction` + `logger`.
 * No Cordis runtime is involved — these exercise the ctxpress logic in isolation.
 */
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'

export interface FakeCtx {
  readonly registered: CommandDefinition[]
  readonly registeredTools: Array<{ name: string; execute(args: unknown, exec?: unknown): Promise<unknown> | unknown }>
  readonly listeners: Map<string, Array<(...args: never[]) => unknown>>
  commands: { register(def: CommandDefinition): () => void }
  tools: { register(tool: unknown): void; get(name: string, scope?: unknown): unknown }
  systemPrompt: { section(opts: unknown): void }
  on(name: string, listener: (...args: never[]) => unknown): () => void
  effect(fn: () => Generator<unknown, void, unknown>, label?: string): void
  compaction: { compactNow: (agent: unknown, signal: AbortSignal, commandId: unknown) => Promise<unknown> }
  logger(_name: string): { info?: (...a: unknown[]) => void; debug?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void }
}

export function makeCtx(opts: {
  compactNow?: FakeCtx['compaction']['compactNow']
} = {}): FakeCtx {
  const registered: CommandDefinition[] = []
  const registeredTools: FakeCtx['registeredTools'] = []
  const listeners = new Map<string, Array<(...args: never[]) => unknown>>()
  const ctx: FakeCtx = {
    registered,
    registeredTools,
    listeners,
    commands: {
      register(def) {
        registered.push(def)
        return () => {}
      },
    },
    tools: {
      register(tool: unknown) {
        registeredTools.push(tool as FakeCtx['registeredTools'][number])
      },
      get(name: string) {
        return registeredTools.find((t) => t.name === name)
      },
    },
    systemPrompt: {
      section() {},
    },
    on(name, listener) {
      let arr = listeners.get(name)
      if (arr === undefined) {
        arr = []
        listeners.set(name, arr)
      }
      arr.push(listener as (...args: never[]) => unknown)
      return () => {}
    },
    effect(fn) {
      const gen = fn()
      let step = gen.next()
      while (!step.done) {
        // Drain any yielded async disposer, then advance.
        const value = step.value
        if (value instanceof Promise) void value
        step = gen.next()
      }
    },
    compaction: {
      compactNow: opts.compactNow ?? (async () => null),
    },
    logger() {
      return { info() {}, debug() {}, error() {} }
    },
  }
  return ctx
}

/** A `ToolRunContext`-shaped fake: `agent`/`signal` are what ctxpress reads. */
export function makeExec(agent?: unknown, signal?: AbortSignal): { agent: unknown; signal: AbortSignal } {
  return { agent, signal: signal ?? new AbortController().signal }
}
