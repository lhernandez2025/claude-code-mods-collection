import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { takeNext } from '../src/core/queue.js'
import { describeStatus, renderMessage } from '../src/ui/render.js'
import { seed } from './helpers.js'

describe('renderMessage', () => {
  test('credits Haiku with its note', () => {
    assert.equal(renderMessage({ kind: 'ok', text: 'Removed “a”' }, { via: 'haiku', note: 'it was the tests task' }),
      '✓ Removed “a”\n  ✦ Haiku: it was the tests task')
    assert.equal(renderMessage(null), '')
  })
})

describe('describeStatus', () => {
  test('says what the queue will do next', () => {
    assert.match(describeStatus({ ...seed(['a']), paused: true }).text, /paused/)
    assert.match(describeStatus(takeNext(seed(['a'])).state).text, /working on a queued task/)
    assert.match(describeStatus({ ...seed(['a']), busy: true }).text, /run when it finishes/)
    assert.match(describeStatus(seed([])).text, /nothing queued/)
    assert.match(describeStatus(seed(['a'])).text, /\/after resume/)
  })
})
