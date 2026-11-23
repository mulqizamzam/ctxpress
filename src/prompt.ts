/**
 * System-prompt contribution: the "compression philosophy" — short, stable guidance that
 * tells the model the ctxpress tools exist and when to use them. This is MODEL-FACING TEXT:
 * a change here moves what the model reads as instruction, so it is reviewed as such.
 * @module ctxpress/prompt
 */

/** The section's logical name (nearest-scope + latest-registration wins on collision). */
export const SECTION_NAME = 'ctxpress'

/**
 * The section's numeric order. The central `SECTION_ORDERS` table is a closed set owned by
 * DSH, so a third-party plugin cannot add a key to it; a literal order is the sanctioned
 * form. 3050 places the guidance just after the tool section (TOOL_COMPUTER_USE = 3000)
 * and before the MCP block (3100) — with the tool instructions it teaches.
 */
export const SECTION_ORDER = 3050

/** The compression-philosophy text, scoped to whether the tools are actually registered. */
export function compressionPhilosophy(available: boolean): string {
  if (!available) return ''
  return [
    'ctxpress gives you context-management tools. Use them only when the working context is filling up, not preemptively.',
    '',
    '- ctxpress:context — read current context pressure: how much history has been compacted and the last compaction facts. Cheap and read-only.',
    '- ctxpress:compact — ask the harness to compact older conversation history into a summary. Prefer this over manually rewriting or dropping earlier context. The result reports how many history items and roughly how many tokens were saved.',
    '- ctxpress:recall — re-surface a compacted range: the harness summary by default, or the original shadowed transcript with expand=true. Use expand when you need the actual detail that was compressed away.',
    '',
    'A healthy session keeps most of its context; compact at pressure, and rely on recall when a compacted detail is needed again. Do not compact in a loop.',
  ].join('\n')
}
