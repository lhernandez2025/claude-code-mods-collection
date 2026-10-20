import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseArgs, parsePrompt, parseRefs } from '../src/commands/parse.js'

describe('parsePrompt', () => {
  test('detects /after and /before with their arguments', () => {
    assert.deepEqual(parsePrompt('/after add tests'), { command: 'after', args: 'add tests' })
    assert.deepEqual(parsePrompt('/before'), { command: 'before', args: '' })
    assert.deepEqual(parsePrompt('  /AFTER   spaced out  '), { command: 'after', args: 'spaced out' })
    assert.deepEqual(parsePrompt('/after first line\nsecond line'), { command: 'after', args: 'first line\nsecond line' })
  })

  test('accepts plugin-namespaced commands', () => {
    assert.deepEqual(parsePrompt('/after:before bump'), { command: 'before', args: 'bump' })
    assert.deepEqual(parsePrompt('/after:after x'), { command: 'after', args: 'x' })
  })

  test('ignores everything else', () => {
    for (const prompt of ['/afterwards', 'after add tests', 'please /after x', '/help', '', undefined]) {
      assert.equal(parsePrompt(prompt), null, String(prompt))
    }
  })
})

describe('parseRefs', () => {
  test('parses numbers, ranges and keywords', () => {
    assert.deepEqual(parseRefs('2'), [{ from: 2, to: 2 }])
    assert.deepEqual(parseRefs('#2, 4-3 last'), [{ from: 2, to: 2 }, { from: 3, to: 4 }, { last: true }])
    assert.deepEqual(parseRefs('1..2 all'), [{ from: 1, to: 2 }, { all: true }])
  })

  test('returns null when anything is not a reference', () => {
    assert.equal(parseRefs('2 unused imports'), null)
    assert.equal(parseRefs(''), null)
  })
})

describe('parseArgs', () => {
  const cases = [
    ['', { type: 'watch' }],
    ['list', { type: 'show' }],
    ['view', { type: 'watch' }],
    ['edit', { type: 'watch' }],
    ['help', { type: 'help' }],
    ['clear', { type: 'clear' }],
    ['pause', { type: 'pause' }],
    ['go', { type: 'resume' }],
    ['resume', { type: 'resume' }],
    ['undo', { type: 'undo' }],
    ['watch', { type: 'watch' }],
    ['rm 2', { type: 'remove', refs: [{ from: 2, to: 2 }] }],
    ['remove 2-3', { type: 'remove', refs: [{ from: 2, to: 3 }] }],
    ['edit 2 write better docs', { type: 'edit', position: 2, text: 'write better docs' }],
    ['mv 3 1', { type: 'move', position: 3, to: { kind: 'index', position: 1 } }],
    ['move 3 to first', { type: 'move', position: 3, to: { kind: 'start' } }],
    ['mv 1 last', { type: 'move', position: 1, to: { kind: 'end' } }],
    ['mv 1 after 3', { type: 'move', position: 1, to: { kind: 'afterPos', position: 3 } }],
    ['top 3', { type: 'move', position: 3, to: { kind: 'start' } }],
    ['#2 run lint', { type: 'add', text: 'run lint', where: { kind: 'afterPos', position: 2 } }],
    ['-- remove the old API', { type: 'add', text: 'remove the old API', where: { kind: 'end' } }]
  ]
  for (const [args, expected] of cases) {
    test(`/after ${args || '(empty)'}`, () => assert.deepEqual(parseArgs('after', args), expected))
  }

  test('/before uses the front of the queue and "before" anchors', () => {
    assert.deepEqual(parseArgs('before', '3: bump the version'), { type: 'add', text: 'bump the version', where: { kind: 'beforePos', position: 3 } })
    assert.deepEqual(parseArgs('before', '-- literal'), { type: 'add', text: 'literal', where: { kind: 'start' } })
  })

  test('keywords followed by more words are tasks, not commands', () => {
    for (const args of ['pause the video on scroll', 'clear the cache', 'remove adding tests', 'rm 2 unused imports', 'continue']) {
      assert.deepEqual(parseArgs('after', args), { type: 'smart', command: 'after', text: args })
    }
  })
})
