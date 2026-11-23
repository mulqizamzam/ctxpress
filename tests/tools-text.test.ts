import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textOf } from '../src/tools-text'

test('textOf joins text content blocks, skipping non-text', () => {
  const blocks = [
    { type: 'text', text: 'a' },
    { type: 'image', data: 'x' },
    { type: 'text', text: 'b' },
  ] as never[]
  assert.equal(textOf(blocks), 'a\nb')
})

test('textOf returns empty for no text blocks', () => {
  assert.equal(textOf([{ type: 'image', data: 'x' }] as never[]), '')
})
