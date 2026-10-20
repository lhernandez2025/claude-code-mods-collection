import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { RESPONSE_SCHEMA, SYSTEM, SYSTEM_PROMPT, buildUserMessage, parseReply, parseResponse } from '../src/smart/protocol.js'

const items = [{ id: 7, text: 'add tests' }, { id: 9, text: 'update\nthe README' }]

describe('protocol', () => {
  test('describes the queue by position', () => {
    assert.equal(buildUserMessage({ command: 'after', text: 'x', items }), 'Command: /after x\n\nQueue:\n1. add tests\n2. update the README')
    assert.match(buildUserMessage({ command: 'before', text: 'y', items: [] }), /Queue:\n\(empty\)$/)
  })

  test('lists tasks that already started so they are not mistaken for queued ones', () => {
    const message = buildUserMessage({ command: 'after', text: 'remove beta', items: [], started: [{ text: 'beta', status: 'done' }, { text: 'alpha', status: 'running' }] })
    assert.match(message, /Already started or finished \(cannot be changed\):\n- beta \(finished\)\n- alpha \(running\)$/)
  })

  test('accepts "nothing to do" only with an explanation', () => {
    assert.deepEqual(parseResponse({ ops: [], note: 'That task already ran' }, items), [])
    assert.equal(parseResponse({ ops: [], note: ' ' }, items), null)
  })

  test('ships a strict JSON schema inside the system prompt', () => {
    assert.deepEqual(RESPONSE_SCHEMA.required, ['ops'])
    assert.match(SYSTEM_PROMPT, /\/before/)
    assert.ok(SYSTEM.startsWith(SYSTEM_PROMPT))
    assert.ok(SYSTEM.includes(JSON.stringify(RESPONSE_SCHEMA)))
  })

  test('parseReply pulls the JSON object out of the reply text', () => {
    assert.deepEqual(parseReply('{"ops":[]}'), { ops: [] })
    assert.deepEqual(parseReply('Sure:\n```json\n{"ops":[],"note":"x"}\n```'), { ops: [], note: 'x' })
    for (const text of [null, '', 'no json here', '{broken', '[1, 2]']) assert.equal(parseReply(text), null, String(text))
  })

  test('maps positions back to stable ids', () => {
    assert.deepEqual(parseResponse({ ops: [{ op: 'add', text: ' docs ', position: 'after', anchor: 1 }] }, items), [
      { type: 'add', text: 'docs', where: { kind: 'after', id: 7 } }
    ])
    assert.deepEqual(parseResponse({ ops: [{ op: 'add', text: 'x' }] }, items), [
      { type: 'add', text: 'x', where: { kind: 'end' } }
    ])
    assert.deepEqual(parseResponse({ ops: [{ op: 'move', target: 2, position: 'start' }] }, items), [
      { type: 'move', id: 9, where: { kind: 'start' } }
    ])
    assert.deepEqual(parseResponse({ ops: [{ op: 'edit', target: 1, text: 'add e2e tests' }] }, items), [
      { type: 'edit', id: 7, text: 'add e2e tests' }
    ])
  })

  test('merges several removals into one operation', () => {
    assert.deepEqual(parseResponse({ ops: [{ op: 'remove', target: 1 }, { op: 'remove', target: 2 }] }, items), [
      { type: 'remove', ids: [7, 9] }
    ])
  })

  test('rejects anything inconsistent with the queue it saw', () => {
    const invalid = [
      null,
      {},
      { ops: [] },
      { ops: [{ op: 'remove', target: 3 }] },
      { ops: [{ op: 'add', text: '  ' }] },
      { ops: [{ op: 'add', text: 'x', position: 'after', anchor: 0 }] },
      { ops: [{ op: 'move', target: 1 }] },
      { ops: [{ op: 'move', target: 1, position: 'after', anchor: 1 }] },
      { ops: [{ op: 'edit', target: 1 }] },
      { ops: [{ op: 'explode' }] }
    ]
    for (const response of invalid) assert.equal(parseResponse(response, items), null, JSON.stringify(response))
  })
})
