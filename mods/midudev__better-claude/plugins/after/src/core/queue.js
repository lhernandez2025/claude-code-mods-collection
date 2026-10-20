// Pure queue operations. Every function returns a new state and never mutates its input,
// which keeps them trivial to test and safe to run inside a store transaction.

export const STATE_VERSION = 1
const DONE_LIMIT = 10
const UNDO_LIMIT = 20

export class QueueError extends Error {
  constructor (message) {
    super(message)
    this.name = 'QueueError'
  }
}

/** @param {{ sessionId?: string | null, cwd?: string | null, now?: number }} [options] */
export function createState ({ sessionId = null, cwd = null, now = Date.now() } = {}) {
  return {
    version: STATE_VERSION,
    sessionId,
    cwd,
    items: [], // pending tasks, in run order: { id, text, createdAt }
    running: null, // task handed to Claude and not finished yet
    done: [], // most recent finished tasks, newest first
    paused: false,
    nextId: 1,
    undo: [], // stack of { items, paused } snapshots
    busy: false, // Claude is in the middle of a turn
    createdAt: now,
    updatedAt: now
  }
}

/**
 * Fills in fields missing from older or hand-edited state files.
 * @param {any} raw
 * @param {{ sessionId?: string | null, cwd?: string | null, now?: number }} [defaults]
 */
export function normalizeState (raw, defaults = {}) {
  const base = createState(defaults)
  if (!raw || typeof raw !== 'object') return base
  const state = { ...base, ...raw }
  state.items = Array.isArray(raw.items) ? raw.items.filter(isItem) : []
  state.done = Array.isArray(raw.done) ? raw.done.filter(isItem) : []
  state.undo = Array.isArray(raw.undo) ? raw.undo : []
  state.running = isItem(raw.running) ? raw.running : null
  const maxId = [...state.items, ...state.done, state.running].filter(Boolean)
    .reduce((max, item) => Math.max(max, item.id), 0)
  state.nextId = Math.max(Number(raw.nextId) || 1, maxId + 1)
  return state
}

const isItem = (item) => Boolean(item) && Number.isInteger(item.id) && typeof item.text === 'string'

const cleanText = (text) => String(text ?? '').trim()

export const findItem = (state, id) => state.items.find(item => item.id === id) ?? null

/** 1-based position of an item in the pending list, or -1. */
export const positionOf = (state, id) => state.items.findIndex(item => item.id === id) + 1

/** Item at a 1-based position, or null. */
export const itemAt = (state, position) => state.items[position - 1] ?? null

/**
 * Turns a placement into an insertion index for `items`.
 * where: { kind: 'end' | 'start' } | { kind: 'index', index } | { kind: 'after' | 'before', id }
 */
export function insertionIndex (items, where = { kind: 'end' }) {
  switch (where.kind) {
    case 'start': return 0
    case 'end': return items.length
    case 'index': return Math.min(Math.max(0, where.index), items.length)
    case 'after':
    case 'before': {
      const index = items.findIndex(item => item.id === where.id)
      if (index === -1) throw new QueueError(`Task #${where.id} is no longer in the queue`)
      return where.kind === 'after' ? index + 1 : index
    }
    default: throw new QueueError(`Unknown placement "${where.kind}"`)
  }
}

export function addItem (state, text, where = { kind: 'end' }, now = Date.now()) {
  const value = cleanText(text)
  if (!value) throw new QueueError('A task needs some text')
  const item = { id: state.nextId, text: value, createdAt: now }
  const items = [...state.items]
  items.splice(insertionIndex(items, where), 0, item)
  return { state: { ...state, items, nextId: state.nextId + 1 }, item }
}

export function removeItems (state, ids) {
  const wanted = new Set(ids)
  const removed = state.items.filter(item => wanted.has(item.id))
  if (removed.length === 0) throw new QueueError('Nothing to remove')
  return { state: { ...state, items: state.items.filter(item => !wanted.has(item.id)) }, removed }
}

export function moveItem (state, id, where) {
  const item = findItem(state, id)
  if (!item) throw new QueueError(`Task #${id} is no longer in the queue`)
  if ((where.kind === 'after' || where.kind === 'before') && where.id === id) {
    throw new QueueError('A task cannot be moved relative to itself')
  }
  const rest = state.items.filter(other => other.id !== id)
  rest.splice(insertionIndex(rest, where), 0, item)
  return { state: { ...state, items: rest }, item }
}

export function editItem (state, id, text) {
  const value = cleanText(text)
  if (!value) throw new QueueError('A task needs some text')
  const previous = findItem(state, id)
  if (!previous) throw new QueueError(`Task #${id} is no longer in the queue`)
  const item = { ...previous, text: value }
  return {
    state: { ...state, items: state.items.map(other => other.id === id ? item : other) },
    item,
    previous
  }
}

export function clearItems (state) {
  return { state: { ...state, items: [] }, removed: state.items }
}

export const setPaused = (state, paused) => ({ ...state, paused: Boolean(paused) })

/** Pops the next task and marks it as running. */
export function takeNext (state, now = Date.now()) {
  const [item, ...items] = state.items
  if (!item) return { state, item: null }
  return { state: { ...state, items, running: { ...item, startedAt: now }, busy: true }, item }
}

/** Claude finished (or abandoned) its turn: archive the running task, if any. */
export function markIdle (state, { now = Date.now(), status = 'done' } = {}) {
  if (!state.running) return state.busy ? { ...state, busy: false } : state
  const finished = { ...state.running, finishedAt: now, status }
  return {
    ...state,
    busy: false,
    running: null,
    done: [finished, ...state.done].slice(0, DONE_LIMIT)
  }
}

/** Stores `previous` so the change that produced `next` can be undone. */
export function withUndo (previous, next) {
  const snapshot = { items: previous.items, paused: previous.paused }
  return { ...next, undo: [snapshot, ...previous.undo].slice(0, UNDO_LIMIT) }
}

export function undo (state) {
  const [snapshot, ...rest] = state.undo
  if (!snapshot) return { state, ok: false }
  // Tasks that already started running cannot come back from the past
  const runningId = state.running?.id
  const items = snapshot.items.filter(item => item.id !== runningId)
  return { state: { ...state, items, paused: snapshot.paused, undo: rest }, ok: true }
}

/** Whether the next task may be handed to Claude now. */
export const canStart = (state) => !state.busy && !state.running && !state.paused && state.items.length > 0

/** A task Claude Code could not start goes back to the front, and the queue holds. */
export function giveBack (state, id) {
  if (state.running?.id !== id) return state
  const { startedAt: _, ...item } = state.running
  return { ...state, items: [item, ...state.items], running: null, busy: false, paused: true }
}
