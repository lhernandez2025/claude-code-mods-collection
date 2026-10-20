// The values After keeps in `$.state` for the session (the band and the pane draw from
// them) and in `$.store` across sessions (one queue per session id).

export type AfterTask = {
  id: number
  text: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  status?: 'done' | 'stopped'
}

export type AfterQueue = {
  version: number
  sessionId: string | null
  cwd: string | null
  /** Pending tasks, in run order. */
  items: AfterTask[]
  /** The task handed to Claude and not finished yet. */
  running: AfterTask | null
  /** Most recent finished tasks, newest first. */
  done: AfterTask[]
  paused: boolean
  nextId: number
  undo: { items: AfterTask[]; paused: boolean }[]
  /** Claude is in the middle of a turn. */
  busy: boolean
  createdAt: number
  updatedAt: number
}

/** What the last change did, for the pane: the message and the rows it touched. */
export type AfterNote = {
  kind: 'ok' | 'info' | 'error'
  text: string
  via: 'haiku' | 'heuristics' | null
  note: string
  marks: Record<string, 'new' | 'moved' | 'edited'>
}

/** The pane's input: a new task or command, or a rewrite of one queued task. */
export type AfterDraft = { text: string; editId: number | null }

declare module 'claude-code' {
  interface PluginState {
    after: {
      queue: AfterQueue | null
      note: AfterNote | null
      draft: AfterDraft
      paneOpen: boolean
      /** The task the pane's focus ring last rested on, by id. */
      selected: number | null
    }
  }
}
