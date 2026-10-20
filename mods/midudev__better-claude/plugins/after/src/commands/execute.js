// Runs one /after or /before command against a queue. Storage-agnostic: the mod passes
// the session's queue, the tests an in-memory one, so both behave exactly the same.
import { isSmartCandidate, resolveSmart, startedTasks } from '../smart/resolve.js'
import { applyIntent, applyOps } from './apply.js'
import { parseArgs } from './parse.js'

const untracked = (work) => work()

/**
 * Resolves to the outcome of applyIntent/applyOps, with the saved state.
 * - queue: { read() → state, commit(apply(state, now) → outcome) → outcome }
 * - resolver: optional model resolver for plain-language commands
 * - track(work): wraps the slow path (asking the model, then saving), so the caller can
 *   hold the queue until a command typed before the turn ended has landed
 *
 * @template T
 * @param {{
 *   queue: { read: () => Promise<any>, commit: (apply: (state: any, now: number) => any) => Promise<T> },
 *   command: string,
 *   args: string,
 *   resolver?: ((request: any) => Promise<any>) | null,
 *   track?: (work: () => Promise<T>) => Promise<T>
 * }} options
 * @returns {Promise<T>}
 */
export async function executeCommand ({ queue, command, args, resolver = null, track = untracked }) {
  const intent = parseArgs(command, args)
  if (intent.type !== 'smart') return queue.commit((state, now) => applyIntent(state, intent, { now }))

  const snapshot = await queue.read()
  const started = startedTasks(snapshot)
  const run = async () => {
    // Operations are id-based, so they still apply if the queue moved while the model thought
    const resolution = await resolveSmart({ command: intent.command, text: intent.text, items: snapshot.items, started, resolver })
    return queue.commit((state, now) => applyOps(state, resolution.ops, { now, via: resolution.via, note: resolution.note }))
  }
  return resolver && isSmartCandidate(intent.text, snapshot.items, started) ? track(run) : run()
}
