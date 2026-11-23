/**
 * Verification-only stub: provides a minimal `sessionQuery` read seam so the recall
 * EXPAND path can be exercised end-to-end in a keyless composition, without pulling in
 * the full session-query backend (which needs a live session + persistence). Mirrors the
 * shape of `stubs.ts` (the compaction stub). This is NOT shipped — it exists only to let
 * `verify/load-verify.ts` boot ctxpress and drive `ctxpress_recall { expand: true }`
 * through the real tool pipeline.
 *
 * The seeded events carry `seq` 10 and 11, matching the `shadowedSeqs: [10, 11]` that
 * `load-verify.ts` seeds into the ledger via a synthetic `compaction/summary` session
 * event, so the driver's order-preserving filter matches both and renders the transcript.
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'ctxpress-verify-stub-session-query'

export function apply(ctx: Context): void {
  ctx.provide('sessionQuery', {
    readSession: async () => ({
      events: [
        { seq: 10, time: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'original user text' }] } },
        { seq: 11, time: 0, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'original assistant text' }] } } },
      ] as never,
    }),
  })
}
