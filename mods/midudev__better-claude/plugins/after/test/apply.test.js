import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { applyIntent, applyOps } from '../src/commands/apply.js'
import { parseArgs } from '../src/commands/parse.js'
import { takeNext } from '../src/core/queue.js'
import { seed, texts } from './helpers.js'

const run = (state, args, command = 'after') => applyIntent(state, parseArgs(command, args))

describe('applyIntent', () => {
  test('adds tasks and asks the queue to start', () => {
    const outcome = run(seed(['a']), '-- b')
    assert.deepEqual(texts(outcome.state), ['a', 'b'])
    assert.equal(outcome.message.kind, 'ok')
    assert.match(outcome.message.text, /^Queued #2 · b$/)
    assert.equal(outcome.kick, true)
    assert.equal(outcome.marks[2], 'new')
  })

  test('inserts relative to a position', () => {
    const after = run(seed(['a', 'b']), '#1 x')
    assert.deepEqual(texts(after.state), ['a', 'x', 'b'])
    assert.match(after.message.text, /right after “a”/)

    const before = run(seed(['a', 'b']), '2: y', 'before')
    assert.deepEqual(texts(before.state), ['a', 'y', 'b'])
    assert.match(before.message.text, /right before “b”/)
  })

  test('removes by position, range and keyword', () => {
    assert.deepEqual(texts(run(seed(['a', 'b', 'c', 'd']), 'rm 2-3').state), ['a', 'd'])
    assert.deepEqual(texts(run(seed(['a', 'b', 'c']), 'rm last').state), ['a', 'b'])
    const outcome = run(seed(['a', 'b']), 'rm 1')
    assert.match(outcome.message.text, /Removed “a”\n\/after undo to bring it back/)
    assert.deepEqual(outcome.removed.map(item => item.text), ['a'])
  })

  test('explains invalid positions without changing anything', () => {
    const state = seed(['a'])
    const outcome = run(state, 'rm 3')
    assert.equal(outcome.state, state)
    assert.deepEqual(outcome.message, { kind: 'error', text: 'There is no #3 (the queue has 1 task)' })
    assert.equal(run(seed([]), 'rm 1').message.text, 'The queue is empty')
  })

  test('edits and moves', () => {
    assert.deepEqual(texts(run(seed(['a', 'b']), 'edit 2 B').state), ['a', 'B'])
    const moved = run(seed(['a', 'b', 'c']), 'mv 3 1')
    assert.deepEqual(texts(moved.state), ['c', 'a', 'b'])
    assert.equal(moved.message.text, 'Moved “c” to #1')
    assert.deepEqual(texts(run(seed(['a', 'b', 'c']), 'mv 1 99').state), ['b', 'c', 'a'])
  })

  test('pauses, resumes and undoes', () => {
    const paused = run(seed(['a']), 'pause')
    assert.equal(paused.state.paused, true)
    assert.equal(paused.kick, false)
    assert.equal(run(paused.state, 'pause').message.kind, 'info')

    const resumed = run(paused.state, 'resume')
    assert.equal(resumed.state.paused, false)
    assert.equal(resumed.kick, true)

    const undone = run(resumed.state, 'undo')
    assert.equal(undone.state.paused, true)
    assert.equal(run(seed([]), 'undo').message.text, 'Nothing to undo')
  })

  test('resume on a running queue still nudges it when tasks are waiting', () => {
    assert.equal(run(seed(['a']), 'go').kick, true)
    assert.equal(run(seed([]), 'go').kick, false)
  })

  test('clears with undo', () => {
    const cleared = run(seed(['a', 'b']), 'clear')
    assert.deepEqual(texts(cleared.state), [])
    assert.match(cleared.message.text, /Cleared 2 tasks/)
    assert.deepEqual(texts(run(cleared.state, 'undo').state), ['a', 'b'])
    assert.equal(run(seed([]), 'clear').message.kind, 'info')
  })

  test('views do not change the state', () => {
    const state = seed(['a'])
    for (const [args, view] of [['list', 'queue'], ['help', 'help'], ['', 'watch'], ['watch', 'watch']]) {
      const outcome = run(state, args)
      assert.equal(outcome.state, state)
      assert.equal(outcome.view, view)
    }
  })

  test('undo never brings back a task that already started', () => {
    const state = takeNext(run(seed(['a']), '-- b').state).state
    assert.deepEqual(texts(run(state, 'undo').state), [])
  })
})

describe('applyOps', () => {
  test('no operations means nothing changes, with the reason', () => {
    const state = seed(['a'])
    const outcome = applyOps(state, [], { via: 'haiku', note: '“b” already ran' })
    assert.equal(outcome.state, state)
    assert.deepEqual(outcome.message, { kind: 'info', text: '“b” already ran' })
    assert.equal(outcome.kick, false)
  })

  test('applies several operations atomically', () => {
    const state = seed(['a', 'b'])
    const failed = applyOps(state, [{ type: 'remove', ids: [1] }, { type: 'remove', ids: [99] }])
    assert.equal(failed.state, state)
    assert.equal(failed.message.kind, 'error')

    const ok = applyOps(state, [{ type: 'remove', ids: [1] }, { type: 'add', text: 'c', where: { kind: 'after', id: 2 } }], { via: 'haiku', note: 'n' })
    assert.deepEqual(texts(ok.state), ['b', 'c'])
    assert.equal(ok.via, 'haiku')
    assert.equal(ok.note, 'n')
    assert.equal(ok.state.undo.length, 1)
  })
})
