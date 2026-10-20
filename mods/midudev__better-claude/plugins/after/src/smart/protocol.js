// The contract with Haiku: what we ask, the JSON shape we accept and how we validate it.
// Haiku only ever sees queue positions; we map them back to stable ids ourselves.

export const SYSTEM_PROMPT = `You turn a user's queue command into JSON operations for "After", a FIFO task queue for a coding agent.

Commands:
- "/after <text>": by default, queue <text> as a new task at the END.
- "/before <text>": by default, queue <text> as a new task at the START (it runs next).

<text> may instead refer to tasks already in the queue (numbered in run order):
- Relative placement: "/after tests, write a README" -> add "write a README" right after the queued task about tests. "/before deploy bump the version" -> add "bump the version" right before the deploy task.
- Removal: remove / delete / drop / cancel / skip / quita / elimina / borra + a reference -> remove the matching task(s).
- Reordering: "move <reference> first / last / after <other> / before <other>".
- Editing: "change <reference> to <new text>".

People refer to queued tasks loosely: by one distinctive word ("the beta one", "lo de los tests"), by position ("the second one", "the last one") or in another language. A removal, move or edit verb followed by such a reference is a queue operation.

Examples, with the queue "1. reply with exactly ALPHA 2. reply with exactly BETA 3. add tests":
- "/after remove the beta one" -> remove 2
- "/after quita lo de los tests" -> remove 3
- "/after drop the second one" -> remove 2
- "/after alpha, then write docs" -> add "write docs" after 1
- "/before tests bump the version" -> add "bump the version" before 3
- "/before añadir los tests corre el linter" -> add "corre el linter" before 3 ("añadir los tests" only points at task 3)
- "/after decirme lo de beta, revisa los logs" -> add "revisa los logs" after 2
- "/before beta, add more tests" -> add "add more tests" before 2 (the leading words point at task 2; the new task resembling task 3 does not matter)
- "/after move tests first" -> move 3 to start
- "/after remove the unused dependencies" -> add "remove the unused dependencies" at the end (no queued task is about dependencies)

Rules:
- If the command refers to a task that already started or finished (listed separately, it can no longer be changed), return no operations and explain that in "note".
- If nothing in the queue matches, the whole text is a new task, even when it starts with a verb like "remove" or "move".
- Keep the user's wording and language for task text. Only strip the words that locate it in the queue, including connectors such as "then", "y luego" or a leading comma.
- In a relative placement, the words that point at the anchor task are never part of the new task, even when they paraphrase it ("decirme de qué va el proyecto" for "de que va el proyecto?") and even with no comma: the task text starts where the new instruction starts, usually at its verb.
- The anchor is the task the leading words point at, never a task the new task merely resembles. A relative "/before" goes right before that task, not at the start of the queue.
- Never invent tasks and never drop details from the task text.
- Use "note" for a very short, plain explanation of what you understood (same language as the user).`

const POSITION = { type: 'integer', minimum: 1 }

export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['add', 'remove', 'move', 'edit'] },
          text: { type: 'string', description: 'Task text for add and edit' },
          target: { ...POSITION, description: 'Queue number the remove, move or edit acts on' },
          position: { type: 'string', enum: ['end', 'start', 'after', 'before'], description: 'Where add or move puts the task' },
          anchor: { ...POSITION, description: 'Queue number used by position "after" or "before"' }
        },
        required: ['op'],
        additionalProperties: false
      }
    },
    note: { type: 'string' }
  },
  required: ['ops'],
  additionalProperties: false
}

/** The system prompt sent with every request: the rules plus the exact reply format. */
export const SYSTEM = `${SYSTEM_PROMPT}

Reply with one JSON object and nothing else (no prose, no code fence). It must match this JSON schema:
${JSON.stringify(RESPONSE_SCHEMA)}`

/**
 * Pulls the JSON object out of the model's reply text. Tolerates a code fence or a stray
 * sentence around it; returns null when there is no object to read.
 */
export function parseReply (text) {
  const value = String(text ?? '')
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  if (start === -1 || end < start) return null
  try {
    const parsed = JSON.parse(value.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

const oneLine = (text) => text.replace(/\s+/g, ' ')

export function buildUserMessage ({ command, text, items, started = [] }) {
  const queue = items.length ? items.map((item, i) => `${i + 1}. ${oneLine(item.text)}`).join('\n') : '(empty)'
  const history = started.length
    ? `\n\nAlready started or finished (cannot be changed):\n${started.map(task => `- ${oneLine(task.text)} (${task.status === 'running' ? 'running' : 'finished'})`).join('\n')}`
    : ''
  return `Command: /${command} ${text}\n\nQueue:\n${queue}${history}`
}

/**
 * Validates Haiku's answer against the queue snapshot it saw and converts it into
 * internal operations. Returns null when anything is off, so callers can fall back.
 */
export function parseResponse (response, items) {
  if (!response || !Array.isArray(response.ops)) return null
  // No operations is a valid answer (for example: that task already ran), as long as it says why
  if (response.ops.length === 0) return typeof response.note === 'string' && response.note.trim() ? [] : null
  const idAt = (position) => Number.isInteger(position) ? items[position - 1]?.id ?? null : null

  const placement = ({ position, anchor }, fallback) => {
    if (!position) return fallback
    if (position === 'end' || position === 'start') return { kind: position }
    const id = idAt(anchor)
    return id === null ? undefined : { kind: position, id }
  }

  const ops = []
  for (const raw of response.ops) {
    const text = typeof raw?.text === 'string' ? raw.text.trim() : ''
    switch (raw?.op) {
      case 'add': {
        const where = placement(raw, { kind: 'end' })
        if (!text || !where) return null
        ops.push({ type: 'add', text, where })
        break
      }
      case 'remove': {
        const id = idAt(raw.target)
        if (id === null) return null
        const previous = ops.find(op => op.type === 'remove')
        if (previous) previous.ids.push(id)
        else ops.push({ type: 'remove', ids: [id] })
        break
      }
      case 'move': {
        const id = idAt(raw.target)
        const where = placement(raw, undefined)
        if (id === null || !where || where.id === id) return null
        ops.push({ type: 'move', id, where })
        break
      }
      case 'edit': {
        const id = idAt(raw.target)
        if (id === null || !text) return null
        ops.push({ type: 'edit', id, text })
        break
      }
      default:
        return null
    }
  }
  return ops
}
