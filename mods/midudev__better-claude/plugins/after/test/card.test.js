import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { applyIntent, applyOps } from '../src/commands/apply.js'
import { parseArgs } from '../src/commands/parse.js'
import { markIdle, takeNext } from '../src/core/queue.js'
import { buildCard, cardText } from '../src/ui/card.js'
import { seed } from './helpers.js'

const run = (state, args, command = 'after') => applyIntent(state, parseArgs(command, args))
/** Each row as "<marker> <label> <text> <tag>", trimmed. */
const rows = (card) => card.rows.map(row => [row.marker ?? ' ', row.label, row.text, row.tag ?? ''].join(' ').trim())
const working = (texts) => ({ ...takeNext(seed(texts)).state, busy: true })

describe('buildCard', () => {
  test('a relative add shows where the task landed, between its neighbours', () => {
    const state = working(['run the tests', 'explain the project'])
    const outcome = applyOps(state, [{ type: 'add', text: 'run the tests again', where: { kind: 'before', id: 2 } }],
      { via: 'haiku', note: 'before the explanation' })
    const card = buildCard(outcome)
    assert.equal(card.title, 'Queued #1 · right before #2')
    assert.equal(card.badge, 'haiku')
    assert.deepEqual(rows(card), ['▶ run the tests', '+ 1 run the tests again ← new', '2 explain the project'])
  })

  test('a removed task stays visible, struck out, where it was', () => {
    const outcome = run(seed(['a', 'b', 'c', 'd', 'e']), 'rm 4')
    const card = buildCard(outcome)
    assert.equal(card.title, 'Removed 1 task')
    assert.equal(card.detail, '/after undo restores it')
    assert.deepEqual(rows(card), ['… 2 more', '3 c', '− ✕ d', '4 e'])
    assert.equal(card.rows.find(row => row.kind === 'removed')?.change, 'removed')
  })

  test('a single row is shown instead of folded', () => {
    const card = buildCard(run(seed(['a', 'b', 'c']), 'rm 3'))
    assert.deepEqual(rows(card), ['1 a', '2 b', '− ✕ c'])
  })

  test('a move says where the task came from', () => {
    const card = buildCard(run(seed(['a', 'b', 'c', 'd', 'e', 'f']), 'mv 5 1'))
    assert.equal(card.title, 'Moved #5 → #1')
    assert.deepEqual(rows(card), ['↕ 1 e ← was #5', '2 a', '… 4 more'])
  })

  test('an idle Claude starts the task at once', () => {
    const card = buildCard(run(seed([]), '-- add tests'), { idle: true })
    assert.equal(card.title, 'Starting now')
    assert.equal(card.detail, 'Claude is idle')
    assert.deepEqual(rows(card), ['+ ▶ add tests ← starting now'])
  })

  test('a long change folds into "n more"', () => {
    const card = buildCard(run(seed('abcdefghijkl'.split('')), 'clear'))
    assert.equal(card.title, 'Cleared 12 tasks')
    assert.equal(card.rows.length, 9)
    assert.deepEqual(rows(card).at(-1), '… 4 more')
  })

  test('/after list shows the whole queue', () => {
    let state = seed(['done task', 'running task', 'next task'])
    state = takeNext(markIdle(takeNext(state).state)).state
    const card = buildCard(run({ ...state, paused: true }, 'list'))
    assert.equal(card.tone, 'paused')
    assert.equal(card.title, '1 task queued')
    assert.deepEqual(rows(card), ['✓ done task', '▶ running task', '1 next task'])
    assert.match(card.hint, /\/after <task>/)
  })

  test('errors, notes and plain changes', () => {
    assert.deepEqual(buildCard(run(seed(['a']), 'rm 3')), { tone: 'error', icon: '✗', title: 'There is no #3 (the queue has 1 task)', rows: [], badge: undefined })
    assert.equal(buildCard(run(seed(['a']), 'pause')).icon, '⏸')
    assert.equal(buildCard(run(seed([]), 'undo')).tone, 'info')
  })

  test('help documents every command', () => {
    const help = JSON.stringify(buildCard(run(seed([]), 'help')).sections)
    for (const word of ['rm', 'edit', 'mv', 'pause', 'resume', 'undo', 'clear', 'list', '--']) assert.ok(help.includes(word), word)
  })
})

describe('cardText', () => {
  test('draws the card in a box, title and badge on the border', () => {
    const state = working(['run the tests', 'explain the project'])
    const outcome = applyOps(state, [{ type: 'add', text: 'run the tests again', where: { kind: 'before', id: 2 } }], { via: 'haiku' })
    const lines = cardText(buildCard(outcome)).split('\n')
    assert.match(lines[0], /^╭─ After ─+ ✦ Haiku ─╮$/)
    assert.match(lines[1], /^│ ✓ Queued #1 · right before #2 +│$/)
    assert.match(lines[4], /^│ \+ 1 {2}run the tests again {2}← new +│$/)
    assert.ok(lines.every(line => line.length === lines[0].length))
  })
})
