import { addItem, createState } from '../src/core/queue.js'

/** A state with the given pending tasks. */
export const seed = (texts, base = createState({ sessionId: 's1', now: 0 })) =>
  texts.reduce((state, text) => addItem(state, text, { kind: 'end' }, 0).state, base)

export const texts = (state) => state.items.map(item => item.text)

/** The queue adapter the mod gives executeCommand, over plain memory. */
export function memoryQueue (state = seed([])) {
  let clock = 1_000
  const queue = {
    get state () { return state },
    read: async () => state,
    commit: async (apply) => {
      const outcome = apply(state, ++clock)
      state = outcome.state
      return outcome
    }
  }
  return queue
}
