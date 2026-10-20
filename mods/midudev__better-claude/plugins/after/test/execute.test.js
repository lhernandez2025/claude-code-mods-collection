import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { executeCommand } from '../src/commands/execute.js'
import { memoryQueue, seed, texts } from './helpers.js'

const run = (queue, args, extra = {}) => executeCommand({ queue, command: 'after', args, ...extra })

describe('executeCommand', () => {
  test('applies explicit commands without the model', async () => {
    const queue = memoryQueue(seed(['a', 'b', 'c']))
    let asked = 0
    const resolver = async () => { asked++ }
    await run(queue, 'rm 2', { resolver })
    await run(queue, 'mv 2 1', { resolver })
    assert.deepEqual(texts(queue.state), ['c', 'a'])
    assert.equal(asked, 0)
  })

  test('adds plain tasks right away and flags the queue to start', async () => {
    const queue = memoryQueue()
    const outcome = await executeCommand({ queue, command: 'before', args: 'write docs' })
    assert.deepEqual(texts(queue.state), ['write docs'])
    assert.equal(outcome.kick, true)
    assert.equal(outcome.message.kind, 'ok')
  })

  test('tracks only the slow path, through the save', async () => {
    const queue = memoryQueue(seed(['add tests', 'update the README']))
    const tracked = []
    const track = async (work) => {
      tracked.push('start')
      const outcome = await work()
      tracked.push(texts(queue.state).join('|'))
      return outcome
    }
    const resolver = async () => ({ ops: [{ type: 'remove', ids: [1] }], note: 'tests' })
    await run(queue, 'deploy', { resolver, track })
    assert.deepEqual(tracked, [])
    await run(queue, 'remove the tests one', { resolver, track })
    assert.deepEqual(tracked, ['start', 'update the README|deploy'])
  })

  test('operations resolved on a snapshot still apply after the queue moved', async () => {
    const queue = memoryQueue(seed(['add tests', 'update the README']))
    const resolver = async () => {
      await queue.commit((state) => ({ state: { ...state, items: [...state.items].reverse() } }))
      return { ops: [{ type: 'remove', ids: [1] }], note: '' }
    }
    await run(queue, 'remove the tests one', { resolver })
    assert.deepEqual(texts(queue.state), ['update the README'])
  })
})
