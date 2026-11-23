/**
 * `renderTranscript` — the pure projection from a session's shadowed events to
 * the `User:` / `Assistant:` / `Tool call:` / `Tool result:` transcript lines
 * the expand path returns. No Cordis dependency: events come in pre-filtered
 * and pre-ordered by the caller.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderTranscript } from '../src/recall-render'

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
