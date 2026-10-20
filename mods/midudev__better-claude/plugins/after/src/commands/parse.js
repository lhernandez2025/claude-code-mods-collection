// Deterministic parsing of /after and /before. Anything that is not an explicit
// command becomes a `smart` intent, resolved later (heuristics or Haiku).

// Matches "/after …", "/before …" and namespaced forms like "/after:before …"
const PROMPT_RE = /^\s*\/(?:[\w.-]+:)?(after|before)(?:\s+([\s\S]*))?$/i

const words = (...list) => new Set(list)
const SHOW = words('list', 'ls', 'show', 'status', 'queue')
const HELP = words('help', '-h', '--help', '?')
const CLEAR = words('clear', 'reset', 'flush', 'empty')
const PAUSE = words('pause', 'hold', 'stop')
const RESUME = words('resume', 'go', 'start', 'unpause', 'play')
const UNDO = words('undo')
const WATCH = words('watch', 'view', 'tui', 'ui', 'live', 'edit')
const REMOVE = words('rm', 'remove', 'del', 'delete', 'drop')
const EDIT = words('edit', 'set')
const MOVE = words('mv', 'move')
const TOP = words('top', 'first', 'prioritize')

const START_WORDS = /^(?:first|top|start|front|next|primero|arriba)$/i
const END_WORDS = /^(?:last|end|bottom|final|[uú]ltimo|abajo)$/i

/** Detects a /after or /before command in a raw prompt. */
export function parsePrompt (prompt) {
  const match = PROMPT_RE.exec(String(prompt ?? ''))
  if (!match) return null
  return { command: match[1].toLowerCase(), args: (match[2] ?? '').trim() }
}

/**
 * Queue references: "2", "2,4", "2-4", "2..4", "last", "all".
 * Returns [{ from, to } | { last: true } | { all: true }] or null if something is not a reference.
 */
export function parseRefs (text) {
  const parts = String(text).toLowerCase().split(/[\s,]+/).filter(Boolean)
  if (parts.length === 0) return null
  const refs = []
  for (const part of parts) {
    let match
    if ((match = /^#?(\d+)$/.exec(part))) {
      refs.push({ from: Number(match[1]), to: Number(match[1]) })
    } else if ((match = /^#?(\d+)(?:-|\.\.)#?(\d+)$/.exec(part))) {
      const [a, b] = [Number(match[1]), Number(match[2])]
      refs.push({ from: Math.min(a, b), to: Math.max(a, b) })
    } else if (END_WORDS.test(part)) {
      refs.push({ last: true })
    } else if (/^(?:first|primero)$/.test(part)) {
      refs.push({ from: 1, to: 1 })
    } else if (/^(?:all|everything|todo|todas|todos)$/.test(part)) {
      refs.push({ all: true })
    } else {
      return null
    }
  }
  return refs
}

/** "3", "#3", "first", "last", "after 2", "before 2" → a position-based placement. */
function parseTarget (text) {
  const value = text.trim().replace(/^(?:to|a|al)\s+/i, '')
  let match
  if ((match = /^#?(\d+)$/.exec(value))) return { kind: 'index', position: Number(match[1]) }
  if ((match = /^(after|before|despu[eé]s de|antes de)\s+#?(\d+)$/i.exec(value))) {
    const kind = /^(after|despu)/i.test(match[1]) ? 'afterPos' : 'beforePos'
    return { kind, position: Number(match[2]) }
  }
  if (START_WORDS.test(value)) return { kind: 'start' }
  if (END_WORDS.test(value)) return { kind: 'end' }
  return null
}

/** Turns the text after /after or /before into an intent. */
export function parseArgs (command, rawArgs = '') {
  const args = String(rawArgs).trim()
  // Bare /after opens the queue to edit it
  if (!args) return { type: 'watch' }

  // "--" forces the rest to be queued literally, no interpretation at all
  if (args === '--' || args.startsWith('-- ')) {
    const text = args.slice(2).trim()
    if (!text) return { type: 'show' }
    return { type: 'add', text, where: { kind: command === 'before' ? 'start' : 'end' } }
  }

  const head = args.split(/\s+/, 1)[0]
  const word = head.toLowerCase()
  const rest = args.slice(head.length).trim()

  if (!rest) {
    if (SHOW.has(word)) return { type: 'show' }
    if (HELP.has(word)) return { type: 'help' }
    if (CLEAR.has(word)) return { type: 'clear' }
    if (PAUSE.has(word)) return { type: 'pause' }
    if (RESUME.has(word)) return { type: 'resume' }
    if (UNDO.has(word)) return { type: 'undo' }
    if (WATCH.has(word)) return { type: 'watch' }
  }

  if (REMOVE.has(word)) {
    const refs = parseRefs(rest)
    if (refs) return { type: 'remove', refs }
  }

  if (EDIT.has(word)) {
    const match = /^#?(\d+)[:.)]?\s+([\s\S]+)$/.exec(rest)
    if (match) return { type: 'edit', position: Number(match[1]), text: match[2].trim() }
  }

  if (MOVE.has(word)) {
    const match = /^#?(\d+)\s+([\s\S]+)$/.exec(rest)
    const to = match && parseTarget(match[2])
    if (to) return { type: 'move', position: Number(match[1]), to }
  }

  if (TOP.has(word)) {
    const match = /^#?(\d+)$/.exec(rest)
    if (match) return { type: 'move', position: Number(match[1]), to: { kind: 'start' } }
  }

  // Explicit anchor: "/after #2 run lint" or "/before 3: bump the version"
  const anchor = /^#(\d+)\s+([\s\S]+)$/.exec(args) ?? /^(\d+)[:)]\s+([\s\S]+)$/.exec(args)
  if (anchor) {
    const kind = command === 'before' ? 'beforePos' : 'afterPos'
    return { type: 'add', text: anchor[2].trim(), where: { kind, position: Number(anchor[1]) } }
  }

  return { type: 'smart', command, text: args }
}
