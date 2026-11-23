/**
 * Shared projection from LLM content blocks to plain text (summary → text). One source of
 * truth for both the tools and the command so the recall text stays consistent.
 * @module ctxpress/tools-text
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Join text content blocks to a single string. */
export function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((b) => (b && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
    .filter((t) => t.length > 0)
    .join('\n')
}
