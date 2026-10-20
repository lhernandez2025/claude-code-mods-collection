import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { looksLikeManagement, needsSmart, removalOfStartedTask, resolveHeuristically } from '../src/smart/heuristics.js'

const items = (...texts) => texts.map((text, i) => ({ id: i + 10, text }))
const resolve = (command, text, queue) => resolveHeuristically({ command, text, items: queue })

describe('needsSmart', () => {
  const queue = items('add tests', 'update the README')

  test('never with an empty queue', () => {
    assert.equal(needsSmart('remove adding tests', []), false)
  })

  test('for management verbs in English and Spanish', () => {
    for (const text of ['remove adding tests', 'quita lo de los tests', 'move tests first', 'cambia tests por e2e', "don't do the readme"]) {
      assert.equal(looksLikeManagement(text), true, text)
    }
    assert.equal(looksLikeManagement('removed nothing'), false)
  })

  test('when the text mentions a queued task', () => {
    assert.equal(needsSmart('tests do a new README explaining it', queue), true)
    assert.equal(needsSmart('deploy to production', queue), false)
  })
})

describe('resolveHeuristically', () => {
  test('/after tests <task> goes right after the tests task', () => {
    const { ops, via } = resolve('after', 'tests do a new README explaining it', items('add tests', 'update deps'))
    assert.equal(via, 'heuristics')
    assert.deepEqual(ops, [{ type: 'add', text: 'do a new README explaining it', where: { kind: 'after', id: 10 } }])
  })

  test('/before <task reference>, <task> goes right before it', () => {
    const { ops } = resolve('before', 'deploy, bump the version', items('add tests', 'deploy to production'))
    assert.deepEqual(ops, [{ type: 'add', text: 'bump the version', where: { kind: 'before', id: 11 } }])
  })

  test('understands connectors such as "then" and "y luego"', () => {
    assert.deepEqual(resolve('after', 'the refactor then run the benchmarks', items('refactor the parser')).ops[0].where, { kind: 'after', id: 10 })
    assert.deepEqual(resolve('after', 'los tests y luego documenta la API', items('añadir tests')).ops[0], {
      type: 'add', text: 'documenta la API', where: { kind: 'after', id: 10 }
    })
  })

  test('does not mistake a task for a reference', () => {
    assert.deepEqual(resolve('after', 'deploy to production', items('deploy')).ops, [
      { type: 'add', text: 'deploy to production', where: { kind: 'end' } }
    ])
    assert.equal(resolve('after', 'deploy to production', items('deploy')).via, null)
  })

  test('removes the task a description refers to', () => {
    const queue = items('add tests', 'update the README')
    assert.deepEqual(resolve('after', 'remove adding tests', queue).ops, [{ type: 'remove', ids: [10] }])
    assert.deepEqual(resolve('after', 'quita lo del readme', queue).ops, [{ type: 'remove', ids: [11] }])
    assert.deepEqual(resolve('after', 'remove everything', queue).ops, [{ type: 'clear' }])
  })

  test('understands positions in words', () => {
    const queue = items('a', 'b', 'c')
    assert.deepEqual(resolve('after', 'drop the second one', queue).ops, [{ type: 'remove', ids: [11] }])
    assert.deepEqual(resolve('after', 'quita la última', queue).ops, [{ type: 'remove', ids: [12] }])
    assert.deepEqual(resolve('after', 'remove the first task', queue).ops, [{ type: 'remove', ids: [10] }])
  })

  test('a removal that matches nothing is just a new task', () => {
    assert.deepEqual(resolve('after', 'remove the unused dependencies', items('add tests')).ops, [
      { type: 'add', text: 'remove the unused dependencies', where: { kind: 'end' } }
    ])
  })

  test('moves and edits tasks by description', () => {
    const queue = items('add tests', 'update the README', 'commit')
    assert.deepEqual(resolve('after', 'move the readme to the top', queue).ops, [{ type: 'move', id: 11, where: { kind: 'start' } }])
    assert.deepEqual(resolve('after', 'mueve tests al final', queue).ops, [{ type: 'move', id: 10, where: { kind: 'end' } }])
    assert.deepEqual(resolve('after', 'change add tests to add e2e tests', queue).ops, [{ type: 'edit', id: 10, text: 'add e2e tests' }])
  })

  test('/before without a reference goes to the front', () => {
    assert.deepEqual(resolve('before', 'fix the flaky test', items('add tests')).ops, [
      { type: 'add', text: 'fix the flaky test', where: { kind: 'start' } }
    ])
  })
})

describe('removals of tasks that already left the queue', () => {
  const started = [{ id: 1, text: 'add tests', status: 'running' }, { id: 2, text: 'reply with exactly BETA', status: 'done' }]

  test('are detected even with an empty queue', () => {
    assert.equal(removalOfStartedTask('remove the beta one', started).id, 2)
    assert.equal(removalOfStartedTask('remove the unused deps', started), null)
    assert.equal(needsSmart('remove the beta one', [], started), true)
  })

  test('are never queued as a task', () => {
    const running = resolveHeuristically({ command: 'after', text: 'remove adding tests', items: [], started })
    assert.deepEqual(running.ops, [])
    assert.match(running.note, /“add tests” already started/)
    assert.match(resolveHeuristically({ command: 'after', text: 'quita lo de beta', items: [], started }).note, /already ran/)
  })

  test('a queued match still wins over a started one', () => {
    const queue = items('add tests')
    assert.deepEqual(resolveHeuristically({ command: 'after', text: 'remove the tests', items: queue, started }).ops, [{ type: 'remove', ids: [10] }])
  })
})
