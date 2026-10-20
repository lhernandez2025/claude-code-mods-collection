// Applies parsed intents and resolved operations to a queue state.
// Pure: returns the next state plus everything the UI needs to explain what happened.
import * as queue from '../core/queue.js'
import { plural, shorten } from '../ui/format.js'

const quote = (text) => `“${shorten(text, 48)}”`

const ok = (text) => ({ kind: 'ok', text })
const info = (text) => ({ kind: 'info', text })
const fail = (text) => ({ kind: 'error', text })

/**
 * Outcome shape shared by every command:
 * - state: the next state (unchanged when nothing happened)
 * - message: { kind: 'ok' | 'info' | 'error', text } or null
 * - marks: { [id]: 'new' | 'moved' | 'edited' } to highlight rows
 * - removed: tasks that left the queue
 * - kick: whether the queue should start if Claude is idle
 * - view: 'queue' | 'help' | 'watch'
 * - action: the intent behind a change that is not an operation ('pause' | 'resume' | 'undo')
 * - changes: what each operation did, for the card: { type: 'add', id, where, anchor? }
 *   | { type: 'remove' | 'clear', count } | { type: 'move', id, from } | { type: 'edit', id }
 * - before: the pending tasks before the change, so removed rows show where they were
 */
const outcome = (state, message, extra = {}) => ({
  state, message, marks: {}, removed: [], kick: false, view: 'queue', via: null, note: '',
  action: null, changes: [], before: state.items, ...extra
})

function idAt (state, position) {
  const item = queue.itemAt(state, position)
  if (item) return item.id
  throw new queue.QueueError(state.items.length === 0
    ? 'The queue is empty'
    : `There is no #${position} (the queue has ${plural(state.items.length, 'task')})`)
}

/** Converts user-facing positions into id-based placements. */
function toPlacement (state, where) {
  switch (where.kind) {
    case 'afterPos': return { kind: 'after', id: idAt(state, where.position) }
    case 'beforePos': return { kind: 'before', id: idAt(state, where.position) }
    case 'index':
      if (where.position < 1) throw new queue.QueueError('Positions start at 1')
      return { kind: 'index', index: where.position - 1 }
    default: return where
  }
}

function resolveRefs (state, refs) {
  const count = state.items.length
  if (count === 0) throw new queue.QueueError('The queue is empty')
  const positions = new Set()
  for (const ref of refs) {
    if (ref.all) state.items.forEach((_, i) => positions.add(i + 1))
    else if (ref.last) positions.add(count)
    else for (let p = ref.from; p <= ref.to; p++) positions.add(p)
  }
  return [...positions].map(position => idAt(state, position))
}

function describeAdd (state, item, where, anchorSource) {
  const position = queue.positionOf(state, item.id)
  const base = `Queued #${position} · ${shorten(item.text)}`
  if (where.kind === 'after' || where.kind === 'before') {
    const anchor = queue.findItem(anchorSource, where.id) ?? queue.findItem(state, where.id)
    return `${base}\n  ${where.kind === 'after' ? 'right after' : 'right before'} ${quote(anchor?.text ?? `#${where.id}`)}`
  }
  if (where.kind === 'start' && state.items.length > 1) return `${base} (next up)`
  return base
}

/**
 * Applies concrete, id-based operations atomically: if one fails, nothing changes.
 * ops: { type: 'add', text, where } | { type: 'remove', ids } | { type: 'move', id, where }
 *    | { type: 'edit', id, text } | { type: 'clear' }
 */
export function applyOps (state, ops, { now = Date.now(), via = null, note = '' } = {}) {
  // Understood, but nothing to do (e.g. "remove the tests" after the tests task already ran)
  if (ops.length === 0) return outcome(state, info(note || 'Nothing to change'))

  let next = state
  const lines = []
  const marks = {}
  const removed = []
  const changes = []
  let kick = false

  try {
    for (const op of ops) {
      switch (op.type) {
        case 'add': {
          const result = queue.addItem(next, op.text, op.where, now)
          next = result.state
          marks[result.item.id] = 'new'
          kick = true
          changes.push({ type: 'add', id: result.item.id, where: op.where.kind, anchor: op.where.id })
          lines.push(describeAdd(next, result.item, op.where, state))
          break
        }
        case 'remove': {
          const result = queue.removeItems(next, op.ids)
          next = result.state
          removed.push(...result.removed)
          changes.push({ type: 'remove', count: result.removed.length })
          lines.push(result.removed.length === 1
            ? `Removed ${quote(result.removed[0].text)}`
            : `Removed ${plural(result.removed.length, 'task')}`)
          break
        }
        case 'move': {
          const from = queue.positionOf(next, op.id)
          const result = queue.moveItem(next, op.id, op.where)
          next = result.state
          marks[op.id] = 'moved'
          changes.push({ type: 'move', id: op.id, from })
          lines.push(`Moved ${quote(result.item.text)} to #${queue.positionOf(next, op.id)}`)
          break
        }
        case 'edit': {
          const result = queue.editItem(next, op.id, op.text)
          next = result.state
          marks[op.id] = 'edited'
          changes.push({ type: 'edit', id: op.id })
          lines.push(`Edited #${queue.positionOf(next, op.id)} · ${shorten(result.item.text)}`)
          break
        }
        case 'clear': {
          const result = queue.clearItems(next)
          next = result.state
          removed.push(...result.removed)
          changes.push({ type: 'clear', count: result.removed.length })
          lines.push(`Cleared ${plural(result.removed.length, 'task')}`)
          break
        }
        default:
          throw new queue.QueueError(`Unknown operation "${op.type}"`)
      }
    }
  } catch (error) {
    if (error instanceof queue.QueueError) return outcome(state, fail(error.message))
    throw error
  }

  if (removed.length > 0) lines.push(`/after undo to bring ${removed.length === 1 ? 'it' : 'them'} back`)
  return outcome(queue.withUndo(state, next), ok(lines.join('\n')), { marks, removed, kick, via, note, changes, before: state.items })
}

/** Applies a deterministic intent from parseArgs (everything except `smart`). */
export function applyIntent (state, intent, { now = Date.now() } = {}) {
  try {
    switch (intent.type) {
      case 'show': return outcome(state, null)
      case 'help': return outcome(state, null, { view: 'help' })
      case 'watch': return outcome(state, null, { view: 'watch' })

      case 'add':
        return applyOps(state, [{ type: 'add', text: intent.text, where: toPlacement(state, intent.where) }], { now })
      case 'remove':
        return applyOps(state, [{ type: 'remove', ids: resolveRefs(state, intent.refs) }], { now })
      case 'edit':
        return applyOps(state, [{ type: 'edit', id: idAt(state, intent.position), text: intent.text }], { now })
      case 'move': {
        const id = idAt(state, intent.position)
        return applyOps(state, [{ type: 'move', id, where: toPlacement(state, intent.to) }], { now })
      }
      case 'clear':
        if (state.items.length === 0) return outcome(state, info('The queue is already empty'))
        return applyOps(state, [{ type: 'clear' }], { now })

      case 'pause':
        if (state.paused) return outcome(state, info('Already paused · /after resume to continue'))
        return outcome(queue.withUndo(state, queue.setPaused(state, true)),
          ok('Paused · queued tasks will wait until /after resume'), { action: 'pause' })
      case 'resume':
        if (!state.paused) {
          return outcome(state, info(state.items.length ? 'Running' : 'Nothing queued'), { kick: state.items.length > 0 })
        }
        return outcome(queue.withUndo(state, queue.setPaused(state, false)), ok('Resumed'), { kick: true, action: 'resume' })

      case 'undo': {
        const result = queue.undo(state)
        return result.ok
          ? outcome(result.state, ok('Undid the last change'), { action: 'undo' })
          : outcome(state, info('Nothing to undo'))
      }
      default:
        return outcome(state, fail(`Unknown command "${intent.type}"`))
    }
  } catch (error) {
    if (error instanceof queue.QueueError) return outcome(state, fail(error.message))
    throw error
  }
}
