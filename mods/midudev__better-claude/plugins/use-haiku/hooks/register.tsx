import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import type { AgentIds } from '../types'

const MARK = '_'
const HAIKU = 'claude-haiku-5-5'
const COLOR = 'suggestion'

const MARKED = { plugin: 'use-haiku', key: 'marked' } as const
const TURN = { plugin: 'use-haiku', key: 'turn' } as const
const AGENTS = { plugin: 'use-haiku', key: 'agents' } as const

const marked = atom(MARKED, false)
const haikuTurn = atom(TURN, null as string | null)
const haikuAgents = atom(AGENTS, [] as AgentIds)

// `_summarize the diff` is marked; `__init__.py fails` is not.
const isMarked = (text: string) => text.startsWith(MARK) && !text.startsWith(MARK + MARK)

// Prompts in the person's own words: typed, from a phone or through -p, scheduled, or sent by a plugin for them (After's queue).
const OWN = new Set<PromptOrigin['kind']>(['composer', 'bridge', 'sdk', 'scheduled-trigger', 'plugin'])

const NOTE = `The person sent this prompt to Haiku: you are ${HAIKU} while you answer it, whatever model earlier context names.`

// What `marked` holds, so a keystroke writes it only when it flips.
let lastMarked: boolean | undefined

async function setMarked ($: EngineInterface, value: boolean) {
  if (value === lastMarked) return
  lastMarked = value
  await $.state.set(MARKED, value)
}

export const register: Register = on => {
  // A marked prompt sent while Claude was idle: the next turn of the main loop is its own.
  let pending = false
  // The line under a Haiku answer is for a person at the prompt, not for -p output.
  let isInteractive = false

  on('session.start', ($, e, next) => {
    isInteractive = e.isInteractive
    return next(e)
  })

  // The mark lights up in the box as soon as it is typed.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    const isNow = isMarked(box.text)
    await setMarked($, isNow)
    if (!isNow) return box
    return { ...box, decorations: [...(box.decorations ?? []), { start: 0, end: MARK.length, color: COLOR, bold: true }] }
  })

  on('prompt.submit', async ($, e, next) => {
    await setMarked($, false)
    const text = e.text.slice(MARK.length).trimStart()
    if (!isMarked(e.text) || text === '' || !OWN.has(e.origin.kind)) {
      if (e.turnId === undefined) pending = false
      return next(e)
    }

    // Typed while a turn runs, it is folded into that turn or queued behind it, and which is not
    // known here: rather than guess, it keeps the current model, and says so.
    if (e.turnId !== undefined) {
      $.ui.toast('⚡ Sent mid-turn, so not on Haiku: it keeps the current model')
      return next({ ...e, text })
    }

    // The model learns which model it is once per conversation, from the session's: asked "which
    // model are you?" it would name that one. The prompt itself tells it, unseen by the person.
    pending = true
    const result = await next({ ...e, text, context: [...(e.context ?? []), NOTE] })
    if (result.drop !== undefined) pending = false
    return result
  })

  // Only the main loop raises turn.start; a subagent's run does not.
  on('turn.start', async ($, e, next) => {
    await $.state.set(TURN, pending ? e.turnId : null)
    pending = false
    return next(e)
  })

  // Every request of a Haiku turn goes to Haiku: the main loop's and those of the subagents it started.
  on('turn.step', async function* ($, e, next) {
    const isHaiku = e.agentId === undefined
      ? e.turnId === (await read($, haikuTurn))
      : (await read($, haikuAgents)).includes(e.agentId)
    return yield* next(isHaiku ? { ...e, model: HAIKU } : e)
  })

  on('agent.spawn', async ($, e, next) => {
    const isHaiku = !e.isTeammate && (e.parentAgentId === undefined
      ? (await read($, haikuTurn)) !== null
      : (await read($, haikuAgents)).includes(e.parentAgentId))
    if (!isHaiku) return next(e)

    // A fork inherits its parent's model and a workflow's agent keeps its own: turn.step catches theirs.
    const result = await next(e.fork || e.workflow ? e : { ...e, model: HAIKU })
    const id = result.deny === undefined ? result.agentId : undefined
    if (id !== undefined) await update($, haikuAgents, ids => [...ids, id])
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    // Cleared before next(e): a plugin beneath may start the next turn from here (After does).
    const turn = await read($, haikuTurn)
    if (turn !== null) await $.state.set(TURN, null)
    const result = await next(e)
    if (turn !== e.turnId || e.reason !== 'answer' || e.usage === undefined || !isInteractive) return result

    // What the API says answered, so a Haiku turn is seen to be one.
    const model = e.usage.model
    const line = model.includes('haiku') ? `⚡ Answered by ${model}` : `⚠ Asked for Haiku, but ${model} answered`
    return { ...result, text: result.text === e.answer ? line : `${result.text}\n${line}` }
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if ((await read($, haikuTurn)) === null) return next(e)
    // The first frame of a turn comes before the word is sampled.
    const word = e.props.word === '' ? 'Haiku' : `${e.props.word} on Haiku`
    return next({ ...e, props: { ...e.props, word } })
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const isMarkedDraft = await read($, marked)
    if (!e.props.isDraft || !isMarkedDraft) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row">
        {e.props.isWorking
          ? <Text color="warning">⚡ not on Haiku mid-turn: wait for Claude to finish</Text>
          : <Text color={COLOR}>⚡ this prompt runs on Haiku</Text>}
        <Text>  </Text>
        {await next(e)}
      </Box>
    )
  })
}
