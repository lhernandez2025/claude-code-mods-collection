import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import * as q from '../src/core/queue.js'
import { seed, texts } from './helpers.js'

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

describe('queue', () => {
  test('adds tasks at the end with increasing ids', () => {
    const state = seed(['a', 'b', 'c'])
    assert.deepEqual(texts(state), ['a', 'b', 'c'])
    assert.deepEqual(state.items.map(item => item.id), [1, 2, 3])
    assert.equal(state.nextId, 4)
  })

  test('inserts at the start, at an index and around another task', () => {
    let state = seed(['a', 'b'])
    state = q.addItem(state, 'first', { kind: 'start' }).state
    state = q.addItem(state, 'middle', { kind: 'index', index: 2 }).state
    state = q.addItem(state, 'after-b', { kind: 'after', id: 2 }).state
    state = q.addItem(state, 'before-a', { kind: 'before', id: 1 }).state
    assert.deepEqual(texts(state), ['first', 'before-a', 'a', 'middle', 'b', 'after-b'])
  })

  test('trims text and rejects empty tasks or missing anchors', () => {
    const state = seed(['a'])
    assert.equal(q.addItem(state, '  spaced  ').item.text, 'spaced')
    assert.throws(() => q.addItem(state, '   '), q.QueueError)
    assert.throws(() => q.addItem(state, 'x', { kind: 'after', id: 99 }), /no longer in the queue/)
  })

  test('removes tasks by id', () => {
    const { state, removed } = q.removeItems(seed(['a', 'b', 'c']), [1, 3])
    assert.deepEqual(texts(state), ['b'])
    assert.deepEqual(removed.map(item => item.text), ['a', 'c'])
    assert.throws(() => q.removeItems(state, [42]), /Nothing to remove/)
  })

  test('moves tasks to positions or around other tasks', () => {
    const state = seed(['a', 'b', 'c', 'd'])
    assert.deepEqual(texts(q.moveItem(state, 4, { kind: 'start' }).state), ['d', 'a', 'b', 'c'])
    assert.deepEqual(texts(q.moveItem(state, 1, { kind: 'end' }).state), ['b', 'c', 'd', 'a'])
    assert.deepEqual(texts(q.moveItem(state, 1, { kind: 'index', index: 2 }).state), ['b', 'c', 'a', 'd'])
    assert.deepEqual(texts(q.moveItem(state, 1, { kind: 'after', id: 3 }).state), ['b', 'c', 'a', 'd'])
    assert.deepEqual(texts(q.moveItem(state, 4, { kind: 'before', id: 2 }).state), ['a', 'd', 'b', 'c'])
    assert.throws(() => q.moveItem(state, 1, { kind: 'after', id: 1 }), /itself/)
  })

  test('edits keep the id and position', () => {
    const { state, previous, item } = q.editItem(seed(['a', 'b']), 2, 'B!')
    assert.deepEqual(texts(state), ['a', 'B!'])
    assert.equal(previous.text, 'b')
    assert.equal(item.id, 2)
  })

  test('takeNext hands out the head and markIdle archives it', () => {
    const started = q.takeNext(seed(['a', 'b']), 10)
    assert.equal(started.item.text, 'a')
    assert.equal(started.state.running.text, 'a')
    assert.equal(started.state.busy, true)

    const idle = q.markIdle(started.state, { now: 20 })
    assert.equal(idle.busy, false)
    assert.equal(idle.running, null)
    assert.equal(idle.done[0].text, 'a')
    assert.equal(idle.done[0].status, 'done')
    assert.equal(idle.done[0].finishedAt, 20)
  })

  test('takeNext on an empty queue and markIdle on an idle queue change nothing', () => {
    const state = seed([])
    assert.equal(q.takeNext(state).item, null)
    assert.equal(q.markIdle(state), state)
  })

  test('keeps a bounded history of finished tasks', () => {
    let state = seed(Array.from({ length: 15 }, (_, i) => `t${i}`))
    for (let i = 0; i < 15; i++) state = q.markIdle(q.takeNext(state).state)
    assert.equal(state.done.length, 10)
    assert.equal(state.done[0].text, 't14')
  })

  test('undo restores items and paused, but never a task that already started', () => {
    const base = seed(['a', 'b'])
    const cleared = q.withUndo(base, q.setPaused(q.clearItems(base).state, true))
    const restored = q.undo(cleared)
    assert.equal(restored.ok, true)
    assert.deepEqual(texts(restored.state), ['a', 'b'])
    assert.equal(restored.state.paused, false)
    assert.equal(q.undo(restored.state).ok, false)

    const running = q.takeNext(q.withUndo(base, q.addItem(base, 'c').state)).state
    assert.deepEqual(texts(q.undo(running).state), ['b'])
  })

  test('normalizeState repairs missing or broken fields', () => {
    const state = q.normalizeState({ items: [{ id: 5, text: 'x' }, { nope: true }], nextId: 1, running: 'bad' })
    assert.deepEqual(texts(state), ['x'])
    assert.equal(state.nextId, 6)
    assert.equal(state.running, null)
    assert.deepEqual(state.done, [])
    assert.equal(q.normalizeState(null).version, q.STATE_VERSION)
  })

  test('operations never mutate their input', () => {
    const state = deepFreeze(seed(['a', 'b', 'c']))
    q.addItem(state, 'd')
    q.removeItems(state, [1])
    q.moveItem(state, 1, { kind: 'end' })
    q.editItem(state, 2, 'x')
    q.clearItems(state)
    q.markIdle(q.takeNext(state).state)
    q.undo(q.withUndo(state, state))
    assert.deepEqual(texts(state), ['a', 'b', 'c'])
  })

  test('canStart only when idle, not paused and something is queued', () => {
    assert.equal(q.canStart(seed(['a'])), true)
    assert.equal(q.canStart(seed([])), false)
    assert.equal(q.canStart({ ...seed(['a']), busy: true }), false)
    assert.equal(q.canStart({ ...seed(['a']), paused: true }), false)
    assert.equal(q.canStart(q.takeNext(seed(['a', 'b'])).state), false)
  })

  test('giveBack returns a task that could not start to the front and pauses', () => {
    const { state, item } = q.takeNext(seed(['a', 'b']), 5)
    const back = q.giveBack(state, item.id)
    assert.deepEqual(texts(back), ['a', 'b'])
    assert.equal(back.running, null)
    assert.equal(back.busy, false)
    assert.equal(back.paused, true)
    assert.equal('startedAt' in back.items[0], false)
    assert.equal(q.giveBack(state, 99), state)
  })
})
