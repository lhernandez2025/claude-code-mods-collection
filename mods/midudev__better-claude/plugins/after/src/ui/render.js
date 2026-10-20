// Plain-text lines the pane shares: the last change and what the queue will do next.
// What /after prints in the transcript is a card (card.js).

const ICON = { ok: '✓', info: '·', error: '✗' }

/**
 * @param {{ kind: 'ok' | 'info' | 'error', text: string } | null} message
 * @param {{ via?: string | null, note?: string }} [options]
 */
export function renderMessage (message, { via = null, note = '' } = {}) {
  if (!message?.text) return ''
  const [first, ...rest] = message.text.split('\n')
  const lines = [`${ICON[message.kind]} ${first}`, ...rest.map(line => `  ${line.trimStart()}`)]
  if (via === 'haiku' && message.kind !== 'info') lines.push(`  ✦ Haiku${note ? `: ${note}` : ''}`)
  if (via === 'heuristics' && message.kind !== 'info') lines.push('  ✦ matched locally')
  return lines.join('\n')
}

/** One line on what the queue will do next. */
export function describeStatus (state) {
  if (state.paused) return { tone: 'yellow', text: '⏸ paused · queued tasks wait until you resume' }
  if (state.running) return { tone: 'green', text: '▶ Claude is working on a queued task' }
  if (state.busy) return { tone: 'green', text: '● Claude is working · queued tasks run when it finishes' }
  if (state.items.length === 0) return { tone: 'dim', text: 'Claude is idle · nothing queued' }
  return { tone: 'yellow', text: 'Claude is idle · /after resume starts the queue' }
}
