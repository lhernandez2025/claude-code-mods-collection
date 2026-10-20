// What /after and /before print in the transcript: a card with what happened and the part of
// the queue it touched, as plain data. The mod draws it (hooks/register.tsx).
//
//   ╭─ After ───────────────────────────── ✦ Haiku ─╮
//   │ ✓ Queued #1 · right before #2                 │
//   │                                               │
//   │   ▶  run the tests                            │
//   │ + 1  run the tests again             ← new    │
//   │   2  what is this project about?              │
//   ╰───────────────────────────────────────────────╯
import { takeNext } from '../core/queue.js'
import { plural, shorten } from './format.js'

const TEXT_MAX = 56
const MAX_ROWS = 9
const MAX_DONE = 2

export const HINT = '/after <task> · rm <n> · mv <n> <m> · undo · help'

/**
 * @typedef {'new' | 'starting' | 'moved' | 'edited' | 'removed'} Change
 * @typedef {{
 *   key: string,
 *   kind: 'done' | 'stopped' | 'running' | 'item' | 'removed' | 'more',
 *   label: string,
 *   text: string,
 *   marker?: string,
 *   tag?: string,
 *   change?: Change
 * }} Row
 * @typedef {{
 *   tone: 'ok' | 'info' | 'error' | 'paused',
 *   icon: string,
 *   title: string,
 *   detail?: string,
 *   badge?: 'haiku' | 'local',
 *   rows: Row[],
 *   focus?: boolean,
 *   sections?: { heading?: string, lines: [string, string][] }[],
 *   hint?: string
 * }} Card
 */

const MARKER = { new: '+', removed: '−', moved: '↕', edited: '✎' }

const HELP = [
  {
    lines: [
      ['/after <task>', 'queue a task · it runs when Claude finishes'],
      ['/before <task>', 'queue a task at the front · it runs next'],
      ['/after #2 <task>', 'insert right after #2 (/before #2: right before)'],
      ['/after', 'edit the queue: ↑↓ pick · e edit · d delete · k j move'],
      ['/after list', 'print the queue'],
      ['/after rm 2 · rm 2-4', 'remove tasks (also: rm last, rm all)'],
      ['/after edit 2 <text>', 'rewrite a task'],
      ['/after mv 3 1', 'move #3 to #1 (also: mv 3 last, top 3)'],
      ['/after pause · resume', 'hold the queue / let it run again'],
      ['/after undo · clear', 'undo the last change / empty the queue']
    ]
  },
  {
    heading: 'Plain language works too (Haiku understands it)',
    lines: [
      ['/after tests, write a README', 'goes right after the tests task'],
      ['/before deploy bump the version', 'goes right before the deploy task'],
      ['/after remove the tests one', 'removes it'],
      ['/after -- remove the old API', '"--" queues the text as-is']
    ]
  }
]

const text = (value) => shorten(value, TEXT_MAX)

/**
 * The card for one /after or /before command.
 * @param {any} outcome what applyIntent / applyOps returned, with the saved state
 * @param {{ idle?: boolean }} [options] idle: Claude is not working, so the queue starts now
 * @returns {Card}
 */
export function buildCard (outcome, { idle = false } = {}) {
  const { state, message } = outcome
  const badge = outcome.via === 'haiku' ? 'haiku' : outcome.via === 'heuristics' ? 'local' : undefined

  if (outcome.view === 'help') {
    return { tone: 'info', icon: '?', title: 'Queue prompts for Claude Code without steering it', rows: [], sections: HELP }
  }
  if (!message) return queueCard(state)
  if (message.kind === 'error') return { tone: 'error', icon: '✗', title: message.text, rows: [], badge }
  if (message.kind === 'info') return { tone: 'info', icon: '·', title: message.text, rows: [], badge }

  const starts = idle && outcome.kick && !state.paused && !state.running && state.items.length > 0
  if (outcome.action === 'pause') {
    return { tone: 'paused', icon: '⏸', title: 'Paused', detail: 'queued tasks wait until /after resume', rows: [] }
  }
  if (outcome.action === 'resume') {
    return starts
      ? { tone: 'ok', icon: '▶', title: 'Resumed', detail: 'Claude is idle, so the queue starts now', rows: [] }
      : { tone: 'ok', icon: '▶', title: 'Resumed', rows: [] }
  }
  if (outcome.action === 'undo') {
    const detail = state.items.length ? `${plural(state.items.length, 'task')} queued` : 'queue empty'
    return { ...queueCard(state), tone: 'ok', icon: '↶', title: 'Undid the last change', detail, hint: undefined }
  }

  // An idle Claude takes the first task at once: draw the queue as it is about to be
  const shown = starts ? takeNext(state).state : state
  const startedId = starts ? shown.running.id : null
  const { title, detail } = describeChanges(outcome, shown, startedId)
  return { tone: 'ok', icon: '✓', title, detail, badge, rows: changeRows(outcome, shown, startedId), focus: true }
}

/** The whole queue, for /after with nothing else. */
function queueCard (state) {
  const count = state.items.length
  const title = count ? `${plural(count, 'task')} queued` : 'Queue empty'
  const detail = state.paused
    ? 'paused · /after resume to run them'
    : state.running || state.busy ? 'they run when Claude finishes' : count ? 'Claude is idle · /after resume starts them' : undefined
  const rows = [
    ...state.done.slice(0, MAX_DONE).reverse().map(task => task.status === 'stopped'
      ? { key: `d${task.id}`, kind: 'stopped', label: '■', text: text(task.text), tag: 'interrupted' }
      : { key: `d${task.id}`, kind: 'done', label: '✓', text: text(task.text) }),
    ...(state.running ? [{ key: `r${state.running.id}`, kind: 'running', label: '▶', text: text(state.running.text) }] : []),
    ...state.items.map((item, i) => ({ key: `i${item.id}`, kind: 'item', label: String(i + 1), text: text(item.text) }))
  ]
  return {
    tone: state.paused ? 'paused' : 'info',
    icon: state.paused ? '⏸' : state.running ? '▶' : '≡',
    title,
    detail,
    rows: cap(rows),
    hint: HINT
  }
}

function describeChanges (outcome, shown, startedId) {
  const position = (id) => shown.items.findIndex(item => item.id === id) + 1
  const parts = []
  const adds = outcome.changes.filter(change => change.type === 'add')
  if (adds.length === 1) {
    const [add] = adds
    const at = position(add.id)
    if (add.id === startedId) parts.push('Starting now')
    else if (add.where === 'after' && at > 1) parts.push(`Queued #${at} · right after #${at - 1}`)
    else if (add.where === 'before' && at < shown.items.length) parts.push(`Queued #${at} · right before #${at + 1}`)
    else if (add.where === 'start' && shown.items.length > 1) parts.push(`Queued #${at} · next up`)
    else parts.push(`Queued #${at}`)
  } else if (adds.length > 1) {
    parts.push(`Queued ${plural(adds.length, 'task')}`)
  }
  let gone = 0
  for (const change of outcome.changes) {
    if (change.type === 'remove') parts.push(`Removed ${plural(change.count, 'task')}`)
    if (change.type === 'clear') parts.push(`Cleared ${plural(change.count, 'task')}`)
    if (change.type === 'move') parts.push(`Moved #${change.from} → #${position(change.id)}`)
    if (change.type === 'edit') parts.push(`Edited #${position(change.id)}`)
    if (change.type === 'remove' || change.type === 'clear') gone += change.count
  }
  const detail = gone > 0
    ? `/after undo restores ${gone === 1 ? 'it' : 'them'}`
    : startedId !== null && !adds.some(add => add.id === startedId) ? 'Claude is idle, so the queue starts now'
      : startedId !== null ? 'Claude is idle' : undefined
  return { title: parts.join(' · ') || 'Done', detail }
}

/** The rows a change touched, with one row of context around each, the rest folded. */
function changeRows (outcome, shown, startedId) {
  const { marks, removed, before } = outcome
  const was = new Map(before.map((item, i) => [item.id, i + 1]))

  /** @type {(Row & { id?: number })[]} */
  const rows = []
  if (shown.running) {
    const isStarting = shown.running.id === startedId
    rows.push({
      key: `r${shown.running.id}`,
      kind: 'running',
      label: '▶',
      text: text(shown.running.text),
      ...(isStarting && {
        change: 'starting',
        marker: marks[startedId] === 'new' ? MARKER.new : undefined,
        tag: '← starting now'
      })
    })
  }
  shown.items.forEach((item, i) => {
    const change = marks[item.id]
    const row = { key: `i${item.id}`, id: item.id, kind: 'item', label: String(i + 1), text: text(item.text) }
    if (change === 'new') Object.assign(row, { change, marker: MARKER.new, tag: '← new' })
    if (change === 'edited') Object.assign(row, { change, marker: MARKER.edited, tag: '← edited' })
    if (change === 'moved') Object.assign(row, { change, marker: MARKER.moved, tag: `← was #${was.get(item.id)}` })
    rows.push(row)
  })

  // A removed task shows, struck out, where it used to be
  const present = new Set(shown.items.map(item => item.id))
  const order = [...removed].sort((a, b) => (was.get(a.id) ?? 0) - (was.get(b.id) ?? 0))
  for (const task of order) {
    const index = was.has(task.id) ? was.get(task.id) - 1 : before.length
    const successor = before.slice(index + 1).find(item => present.has(item.id))
    const at = successor ? rows.findIndex(row => row.id === successor.id) : rows.length
    rows.splice(at === -1 ? rows.length : at, 0,
      { key: `x${task.id}`, kind: 'removed', label: '✕', text: text(task.text), change: 'removed', marker: MARKER.removed })
  }

  const visible = new Set()
  rows.forEach((row, i) => {
    if (row.change) for (let j = i - 1; j <= i + 1; j++) if (j >= 0 && j < rows.length) visible.add(j)
  })
  // Folding a single row saves nothing: show it
  rows.forEach((_, i) => {
    const alone = (i === 0 || visible.has(i - 1)) && (i === rows.length - 1 || visible.has(i + 1))
    if (!visible.has(i) && alone && visible.size > 0) visible.add(i)
  })
  const folded = []
  let hidden = 0
  rows.forEach((row, i) => {
    if (!visible.has(i)) return void hidden++
    if (hidden) folded.push(more(hidden, i))
    hidden = 0
    const { id: _, ...plain } = row
    folded.push(plain)
  })
  if (hidden) folded.push(more(hidden, rows.length))
  return cap(folded)
}

const more = (count, at) => ({ key: `m${at}`, kind: 'more', label: '…', text: `${count} more` })

/** Keeps a card short: past MAX_ROWS, the rest folds into one "… n more" row. */
function cap (rows) {
  if (rows.length <= MAX_ROWS) return rows
  const kept = rows.slice(0, MAX_ROWS - 1)
  const rest = rows.slice(MAX_ROWS - 1)
  const count = rest.reduce((sum, row) => sum + (row.kind === 'more' ? Number.parseInt(row.text, 10) || 0 : 1), 0)
  return [...kept, more(count, 'end')]
}

/**
 * The card as plain text, the way the terminal draws it: for tests, the README and any
 * surface that cannot draw it.
 * @param {Card} card
 */
export function cardText (card) {
  const width = Math.max(1, ...card.rows.map(row => row.label.length))
  const body = [`${card.icon} ${card.title}${card.detail ? ` · ${card.detail}` : ''}`]
  if (card.rows.length) body.push('')
  for (const row of card.rows) {
    body.push(`${row.marker ?? ' '} ${row.label.padStart(width)}  ${row.text}${row.tag ? `  ${row.tag}` : ''}`)
  }
  for (const section of card.sections ?? []) {
    const column = Math.max(...section.lines.map(([command]) => command.length))
    body.push('')
    if (section.heading) body.push(section.heading)
    for (const [command, description] of section.lines) body.push(`  ${command.padEnd(column)}  ${description}`)
  }
  if (card.hint) body.push('', card.hint)

  const badge = card.badge === 'haiku' ? ' ✦ Haiku ' : card.badge === 'local' ? ' ✦ matched locally ' : ''
  const inner = Math.max(...body.map(line => line.length), ' After '.length + badge.length + 4)
  const top = `╭─ After ${'─'.repeat(inner - ' After '.length - badge.length)}${badge}─╮`
  return [top, ...body.map(line => `│ ${line.padEnd(inner)} │`), `╰${'─'.repeat(inner + 2)}╯`].join('\n')
}
