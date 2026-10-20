import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createModelResolver, resolveSmart } from '../src/smart/resolve.js'

const items = [{ id: 1, text: 'add tests' }, { id: 2, text: 'update the README' }]

describe('resolveSmart', () => {
  test('adds plain tasks without asking the model', async () => {
    let calls = 0
    const resolver = async () => { calls++ }
    assert.deepEqual(await resolveSmart({ command: 'after', text: 'deploy', items, resolver }), {
      ops: [{ type: 'add', text: 'deploy', where: { kind: 'end' } }], via: null
    })
    assert.deepEqual((await resolveSmart({ command: 'before', text: 'remove tests', items: [], resolver })).ops, [
      { type: 'add', text: 'remove tests', where: { kind: 'start' } }
    ])
    assert.equal(calls, 0)
  })

  test('uses the model when the text may refer to queued tasks', async () => {
    const answer = { ops: [{ type: 'remove', ids: [1] }], note: 'removed tests' }
    const result = await resolveSmart({ command: 'after', text: 'drop the tests', items, resolver: async () => answer })
    assert.deepEqual(result, { ...answer, via: 'haiku' })
  })

  test('shares already started tasks with the model', async () => {
    let request
    const started = [{ id: 5, text: 'reply BETA', status: 'done' }]
    await resolveSmart({ command: 'after', text: 'remove the beta one', items: [], started, resolver: async (r) => { request = r; return null } })
    assert.deepEqual(request.started, started)
  })

  test('does not annotate answers that are just the default add', async () => {
    const resolver = async () => ({ ops: [{ type: 'add', text: 'tests again', where: { kind: 'end' } }], note: 'added' })
    assert.equal((await resolveSmart({ command: 'after', text: 'tests again', items, resolver })).via, null)
  })

  test('a clear local match wins when Haiku reads a reference as a plain task', async () => {
    const queue = [{ id: 1, text: 'reply with exactly ALPHA' }, { id: 2, text: 'reply with exactly BETA' }]
    const literal = async () => ({ ops: [{ type: 'add', text: 'remove the beta one', where: { kind: 'end' } }], note: '' })
    assert.deepEqual(await resolveSmart({ command: 'after', text: 'remove the beta one', items: queue, resolver: literal }), {
      ops: [{ type: 'remove', ids: [2] }], via: 'heuristics'
    })
  })

  test('strips connectors Haiku leaves in relative adds', async () => {
    const resolver = async () => ({ ops: [{ type: 'add', text: 'then write docs', where: { kind: 'after', id: 1 } }], note: '' })
    assert.equal((await resolveSmart({ command: 'after', text: 'tests, then write docs', items, resolver })).ops[0].text, 'write docs')
  })

  test('drops the reference Haiku leaves in the text of a relative add', async () => {
    const queue = [{ id: 1, text: 'ejecuta los tests y dime si todo funciona ok' }, { id: 2, text: 'de que va el proyecto?' }]
    const text = 'decirme de que va el proyecto ejecuta otra vez los tests'
    const whole = async () => ({ ops: [{ type: 'add', text, where: { kind: 'before', id: 2 } }], note: '' })
    const result = await resolveSmart({ command: 'before', text, items: queue, resolver: whole })
    assert.deepEqual(result.ops, [{ type: 'add', text: 'ejecuta otra vez los tests', where: { kind: 'before', id: 2 } }])
  })

  test('anchors to the task the leading words point at, not the one the new task resembles', async () => {
    const queue = [{ id: 1, text: 'ejecuta los tests y dime si todo funciona ok' }, { id: 2, text: 'de que va el proyecto?' }]
    const text = 'decirme de que va el proyecto ejecuta otra vez los tests'
    const resembling = async () => ({ ops: [{ type: 'add', text: 'ejecuta otra vez los tests', where: { kind: 'before', id: 1 } }], note: '' })
    const result = await resolveSmart({ command: 'before', text, items: queue, resolver: resembling })
    assert.deepEqual(result.ops, [{ type: 'add', text: 'ejecuta otra vez los tests', where: { kind: 'before', id: 2 } }])
  })

  test('keeps a relative add Haiku already trimmed, even if it looks like its anchor', async () => {
    const queue = [{ id: 1, text: 'run the tests' }]
    const trimmed = async () => ({ ops: [{ type: 'add', text: 'run the tests again and fix what fails', where: { kind: 'after', id: 1 } }], note: '' })
    const result = await resolveSmart({ command: 'after', text: 'tests, run the tests again and fix what fails', items: queue, resolver: trimmed })
    assert.equal(result.ops[0].text, 'run the tests again and fix what fails')
  })

  test('falls back to heuristics when the model is unavailable or fails', async () => {
    for (const resolver of [null, async () => null, async () => { throw new Error('boom') }]) {
      const result = await resolveSmart({ command: 'after', text: 'remove adding tests', items, resolver })
      assert.deepEqual(result, { ops: [{ type: 'remove', ids: [1] }], via: 'heuristics' })
    }
  })
})

describe('createModelResolver', () => {
  test('asks with the rules and the queue, and validates the reply', async () => {
    let request
    const complete = async (r) => {
      request = r
      return '{"ops":[{"op":"add","text":"write docs","position":"after","anchor":1}],"note":" after tests "}'
    }
    const answer = await createModelResolver(complete)({ command: 'after', text: 'tests, write docs', items })
    assert.deepEqual(answer, { ops: [{ type: 'add', text: 'write docs', where: { kind: 'after', id: 1 } }], note: 'after tests' })
    assert.match(request.prompt, /1\. add tests/)
    assert.match(request.system, /Reply with one JSON object/)
  })

  test('reads a reply wrapped in a code fence', async () => {
    const complete = async () => '```json\n{"ops":[{"op":"remove","target":2}]}\n```'
    assert.deepEqual(await createModelResolver(complete)({ command: 'after', text: 'x', items }), {
      ops: [{ type: 'remove', ids: [2] }], note: ''
    })
  })

  test('returns null for no reply, prose or invalid operations', async () => {
    for (const reply of [null, 'I would remove the second task.', '{"ops":[{"op":"remove","target":9}]}']) {
      assert.equal(await createModelResolver(async () => reply)({ command: 'after', text: 'x', items }), null)
    }
  })
})
