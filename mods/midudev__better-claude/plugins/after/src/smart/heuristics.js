// Local, instant understanding of natural-language queue commands.
// Used to decide when Haiku is worth calling and as the fallback when it is not available.
import { shorten } from '../ui/format.js'
import { bestMatch, keywords, normalize, wordSimilarity } from './text.js'

const REMOVE_RE = /^\s*(?:remove|delete|drop|cancel|discard|forget(?:\s+about)?|skip|scrap|rm|del|don'?t\s+do|no\s+hagas|quita(?:r|me)?|elimina(?:r)?|borra(?:r)?|cancela(?:r)?|olv[ií]da(?:te)?(?:\s+de)?|descarta(?:r)?|saca(?:r|me)?)\s+(.+)$/iu
const MOVE_RE = /^\s*(?:move|mueve|put|pon|prioriti[sz]e|prioriza|bump|send|manda)\s+(.+?)\s+(?:to\s+(?:the\s+)?|al\s+|a\s+la\s+|a\s+|hasta\s+(?:el\s+|la\s+|arriba|abajo)?)?(first|top|front|start|beginning|next|primer[oa]|principio|inicio|arriba|last|end|bottom|final|[uú]ltim[oa]|abajo|fondo)\s*$/iu
const EDIT_RE = /^\s*(?:change|rename|rewrite|replace|edit|cambia|renombra|reescribe|reemplaza|edita)\s+(.+?)\s+(?:to|with|por|con|->|=>)\s+(.+)$/iu
const EVERYTHING_RE = /^(?:all|everything|todo|todas|todos)(?:\s+(?:the|las|los))?(?:\s+(?:tasks|tareas))?$/i
const TO_END = new Set(['last', 'end', 'bottom', 'final', 'ultimo', 'ultima', 'abajo', 'fondo'])
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, primero: 1, primera: 1, primer: 1, segundo: 2, segunda: 2, tercero: 3, tercera: 3, tercer: 3, cuarto: 4, cuarta: 4, quinto: 5, quinta: 5 }
const ORDINAL_RE = /^(?:the\s+|el\s+|la\s+)?(\w+)(?:\s+(?:one|task|item|tarea))?$/

/** "the second one", "la última" → the task at that position. */
function byOrdinal (target, items) {
  const word = ORDINAL_RE.exec(normalize(target))?.[1]
  if (!word) return null
  if (TO_END.has(word)) return items.at(-1) ?? null
  return ORDINALS[word] ? items[ORDINALS[word] - 1] ?? null : null
}

const CONNECTORS = ['and then', 'y luego', 'y despues', 'then', 'luego', 'despues', 'entonces', '->', '=>', '-', '—', ',', ':', ';']
  .map(connector => connector.split(' '))
const ACTION_VERBS = new Set([
  'do', 'make', 'write', 'add', 'create', 'update', 'run', 'fix', 'refactor', 'remove', 'delete',
  'test', 'document', 'generate', 'implement', 'check', 'review', 'commit', 'push', 'deploy', 'build',
  'rename', 'move', 'clean', 'bump', 'publish', 'release', 'prepare', 'set', 'install', 'upgrade',
  'migrate', 'translate', 'explain', 'verify', 'lint', 'format', 'open', 'ask', 'summarize', 'improve',
  'haz', 'hacer', 'crea', 'crear', 'anade', 'anadir', 'escribe', 'actualiza', 'ejecuta', 'corre',
  'arregla', 'revisa', 'genera', 'implementa', 'elimina', 'borra', 'documenta', 'prueba', 'refactoriza',
  'sube', 'despliega', 'publica', 'prepara', 'instala', 'migra', 'traduce', 'explica', 'comprueba',
  'verifica', 'limpia', 'mueve', 'renombra', 'pasa', 'lanza', 'mejora', 'resume', 'abre', 'pon'
])

const MANAGEMENT_RE = /^\s*(?:remove|delete|drop|cancel|discard|forget|skip|scrap|rm|del|don'?t|no\s+hagas|quita\w*|elimina\w*|borra\w*|cancela\w*|olv[ií]da\w*|descarta\w*|saca\w*|move|mueve|put|pon|prioriti[sz]e|prioriza|bump|send|manda|change|rename|rewrite|replace|edit|cambia|renombra|reescribe|reemplaza|edita)(?=\s)/iu

/** Adds the task where the command puts new tasks by default. */
export const defaultOps = (command, text) => [{
  type: 'add',
  text: text.trim(),
  where: { kind: command === 'before' ? 'start' : 'end' }
}]

/** Starts like a queue-management instruction ("remove …", "move …", "cambia …"). */
export const looksLikeManagement = (text) => MANAGEMENT_RE.test(text)

/** Shares at least one meaningful word with a queued task. */
export function mentionsQueuedTask (text, items) {
  const words = keywords(text)
  return items.some(item => keywords(item.text).some(other => words.some(word => wordSimilarity(word, other) >= 0.8)))
}

/**
 * A removal aimed at a task that already left the queue ("remove the tests" once the tests
 * task started). Queuing that text as a new task could be destructive, so it is refused.
 * `started` lists the running task and recently finished ones, newest first.
 */
export function removalOfStartedTask (text, started = []) {
  const match = text.match(REMOVE_RE)
  if (!match || started.length === 0) return null
  return bestMatch(match[1], started, { min: 0.6, margin: 0 })?.item ?? null
}

export const describeStarted = (task) => task.status === 'running'
  ? `“${shorten(task.text, 48)}” already started, so it is not in the queue anymore (press Esc in Claude Code to stop it)`
  : `“${shorten(task.text, 48)}” already ran, so there is nothing to remove`

/** Whether the command could be about tasks already in the queue (and so deserves Haiku). */
export const needsSmart = (text, items, started = []) =>
  (items.length > 0 && (looksLikeManagement(text) || mentionsQueuedTask(text, items))) ||
  removalOfStartedTask(text, started) !== null

function detectRemoval (text, items) {
  const match = text.match(REMOVE_RE)
  if (!match) return null
  const target = match[1].trim()
  if (EVERYTHING_RE.test(normalize(target))) return [{ type: 'clear' }]
  const item = byOrdinal(target, items) ?? bestMatch(target, items, { min: 0.6 })?.item
  return item ? [{ type: 'remove', ids: [item.id] }] : null
}

function detectMove (text, items) {
  const match = text.match(MOVE_RE)
  if (!match) return null
  const found = bestMatch(match[1], items, { min: 0.6 })
  if (!found) return null
  const where = { kind: TO_END.has(normalize(match[2])) ? 'end' : 'start' }
  return [{ type: 'move', id: found.item.id, where }]
}

function detectEdit (text, items) {
  const match = text.match(EDIT_RE)
  if (!match) return null
  const found = bestMatch(match[1], items, { min: 0.75 })
  return found ? [{ type: 'edit', id: found.item.id, text: match[2].trim() }] : null
}

/** Removes a leading connector left over from a reference: "then write docs" → "write docs". */
export function trimConnector (text) {
  const rest = stripConnector(text.trim().split(/\s+/))
  return rest?.length ? rest.join(' ') : text.trim()
}

/** Drops a leading connector ("then", "y luego", "->", ",") and returns the remaining words, or null. */
function stripConnector (words) {
  const head = words.map(word => normalize(word) || word)
  const connector = CONNECTORS.find(parts => parts.every((part, i) => head[i] === part))
  return connector ? words.slice(connector.length) : null
}

/** "/after tests, write the README" → add "write the README" right after the tests task. */
function detectRelative (command, text, items) {
  const words = text.trim().split(/\s+/)
  let best = null

  for (let size = 1; size <= Math.min(6, words.length - 1); size++) {
    let left = words.slice(0, size).join(' ')
    let rest = words.slice(size)
    let linked = false

    if (/[,:;]$/.test(left)) {
      left = left.replace(/[,:;]+$/, '')
      linked = true
    }
    const afterConnector = stripConnector(rest)
    if (afterConnector) {
      rest = afterConnector
      linked = true
    }
    if (rest.length === 0) continue
    if (!linked && !ACTION_VERBS.has(normalize(rest[0]))) continue

    const found = bestMatch(left, items, { min: 0.75 })
    if (found && (!best || found.score > best.found.score)) best = { found, rest: rest.join(' ') }
  }

  if (!best) return null
  return [{
    type: 'add',
    text: best.rest,
    where: { kind: command === 'before' ? 'before' : 'after', id: best.found.item.id }
  }]
}

/**
 * The task in "<words pointing at anchor> <task>" ("decirme de que va el proyecto ejecuta los
 * tests" with "de que va el proyecto?" as the anchor), or null when the text does not start
 * with a reference to it.
 */
export const taskAfterReference = (text, anchor) => detectRelative('after', text, [anchor])?.[0].text ?? null

/** Best-effort resolution without any model. Falls back to a plain add. */
export function resolveHeuristically ({ command, text, items, started = [] }) {
  if (items.length > 0) {
    const ops = detectRemoval(text, items) ??
      detectMove(text, items) ??
      detectEdit(text, items) ??
      detectRelative(command, text, items)
    if (ops) return { ops, via: 'heuristics' }
  }
  const late = removalOfStartedTask(text, started)
  if (late) return { ops: [], via: 'heuristics', note: describeStarted(late) }
  return { ops: defaultOps(command, text), via: null }
}
