import { defaultOps, needsSmart, resolveHeuristically, taskAfterReference, trimConnector } from './heuristics.js'
import { SYSTEM, buildUserMessage, parseReply, parseResponse } from './protocol.js'
import { normalize } from './text.js'

/**
 * Builds the model-backed resolver from `complete({ system, prompt })`, any function that
 * resolves to the model's reply text (or null). The mod passes one over `$.model.complete`
 * (the session's own client: no API key, no subprocess); the eval script one over `claude -p`.
 */
export function createModelResolver (complete) {
  return async ({ command, text, items, started = [] }) => {
    const reply = await complete({ system: SYSTEM, prompt: buildUserMessage({ command, text, items, started }) })
    const response = parseReply(reply)
    const ops = parseResponse(response, items)
    return ops ? { ops, note: typeof response.note === 'string' ? response.note.trim() : '' } : null
  }
}

/** Whether resolving this text may need the model (so callers can mark the work as slow). */
export const isSmartCandidate = (text, items, started = []) => needsSmart(text, items, started)

/** The running task and a few recently finished ones, newest first. */
export const startedTasks = (state) => [
  ...(state.running ? [{ ...state.running, status: 'running' }] : []),
  ...state.done.slice(0, 5)
]

const isDefaultAdd = (ops, command, text) =>
  ops.length === 1 && ops[0].type === 'add' && ops[0].text === text.trim() &&
  ops[0].where.kind === (command === 'before' ? 'start' : 'end')

/**
 * A relative add's text should hold neither the words that point at its anchor nor the
 * connector after them. When Haiku placed the task but kept the whole command as its text
 * ("/before decirme de que va el proyecto ejecuta los tests"), the reference is still there.
 */
function tidy (ops, text, items) {
  return ops.map(op => {
    if (op.type !== 'add' || (op.where.kind !== 'after' && op.where.kind !== 'before')) return op
    const anchor = items.find(item => item.id === op.where.id)
    const isWhole = normalize(op.text) === normalize(text)
    const task = (isWhole && anchor && taskAfterReference(op.text, anchor)) || op.text
    return { ...op, text: trimConnector(task) }
  })
}

/**
 * Haiku may anchor a task to the queued one it resembles ("ejecuta otra vez los tests" next to
 * the tests task) rather than the one the leading words point at. When the local split reads
 * the same task the same way, its anchor is the literal one.
 */
function literalAnchor (ops, local) {
  const [mine] = local.via === 'heuristics' ? local.ops : []
  const [theirs] = ops
  const agrees = ops.length === 1 && mine?.type === 'add' && theirs.type === 'add' &&
    mine.text === theirs.text && mine.where.kind === theirs.where.kind
  return agrees ? [{ ...theirs, where: mine.where }] : ops
}

/**
 * Turns natural language into queue operations.
 * Plain tasks are added instantly; only text that may refer to queued (or already started)
 * tasks reaches Haiku, and local heuristics take over when Haiku is disabled or fails.
 * Resolves to { ops, via: 'haiku' | 'heuristics' | null, note? }; `via` is null when the
 * result is simply "add the text", so the UI has nothing to explain.
 */
export async function resolveSmart ({ command, text, items, started = [], resolver }) {
  if (!needsSmart(text, items, started)) return { ops: defaultOps(command, text), via: null }
  const local = resolveHeuristically({ command, text, items, started })
  const answer = resolver ? await resolver({ command, text, items, started }).catch(() => null) : null
  if (!answer) return local

  if (isDefaultAdd(answer.ops, command, text)) {
    // Haiku read it as a plain task, but a clear local match says it is about the queue:
    // trust the match ("remove the beta one" must never become a task)
    return local.via ? local : { ops: answer.ops, via: null }
  }
  return { ...answer, ops: literalAnchor(tidy(answer.ops, text, items), local), via: 'haiku' }
}
