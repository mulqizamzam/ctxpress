/**
 * Verification-only stubs: provide a minimal `compaction` service so ctxpress's
 * `inject = ['compaction']` resolves in a keyless composition, without pulling in the
 * full compaction backend (session/llm). This is NOT shipped — it exists only to let
 * `vendor/cordis/bin.js` boot ctxpress against the real tools/commands/system-prompt services.
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'ctxpress-verify-stub-compaction'

export function apply(ctx: Context): void {
  // The manual compaction seam ctxpress drives. Returns null here ("nothing compactable").
  ctx.provide('compaction', {
    compactNow: async () => null,
  })
}
