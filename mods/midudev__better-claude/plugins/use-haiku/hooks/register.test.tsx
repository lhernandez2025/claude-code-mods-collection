// Mod tests, run against the engine itself: `claude plugin test .`
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnUsage } from 'claude-code'

const HAIKU = 'claude-haiku-5-5'
const SESSION = 'claude-sonnet-5-5'
const ME = { kind: 'composer' } as const

/** What sits beneath the mod: the prompts that reach Claude, the model of each request, the toasts and the engine's own drawing. */
function world (on: On) {
  const prompts: string[] = []
  const contexts: (readonly string[] | undefined)[] = []
  const models: Record<string, string[]> = {}
  const toasts: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    contexts.push(e.context)
    return { text: e.text, context: e.context }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    (models[e.agentId ?? 'main'] ??= []).push(e.model)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [] } as never
  })
  on('agent.spawn', ($, e) => ({ model: e.model ?? e.parentModel, agentId: e.description }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    if ('hint' in e.props) return <Text>{e.props.hint}</Text>
    if ('mode' in e.props) return <Text>{e.props.word}</Text>
    return <Box key="engine" />
  })
  return { prompts, contexts, models, toasts }
}

const usage = (model: string): TurnUsage =>
  ({ model, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })

const submit = ($: Engine, text: string, turnId?: string) =>
  $.prompt.submit({ text, turnId, wait: false, origin: ME })

const step = async ($: Engine, turnId: string, index = 0, agentId?: string) => {
  for await (const _ of $.turn.step({ turnId, index, model: SESSION, messageCount: 1, agentId })) void _
}

const complete = ($: Engine, turnId: string, model = HAIKU, agentId?: string) =>
  $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId, reason: 'answer', usage: usage(model), agentId })

const spawn = ($: Engine, agentId: string, parentAgentId?: string) =>
  $.agent.spawn({
    tool_use_id: `call-${agentId}`,
    prompt: 'look around',
    description: agentId,
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: SESSION,
    parentAgentId,
    background: false,
    fork: false
  })

const hint = ($: Engine) =>
  $.ui.mount({ plugin: 'use-haiku', surface: 'terminal', component: 'PromptHint', props: { isDraft: true, isWorking: false, hint: '? for shortcuts' } })

const spinner = ($: Engine, word = 'Sauteing') =>
  $.ui.mount({ plugin: 'use-haiku', surface: 'terminal', component: 'Spinner', props: { word, message: null, suffix: '…', mode: 'responding' } })

const startSession = ($: Engine) => $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })

test('a prompt that starts with _ is sent without the mark and its turn runs on Haiku', async ($, on) => {
  const w = world(on)
  await submit($, '_summarize the diff')
  await $.turn.start({ turnId: 't1', text: 'summarize the diff' })
  await step($, 't1', 0)
  await step($, 't1', 1)
  expect(w.prompts).toEqual(['summarize the diff'])
  expect(w.contexts[0]?.[0]).toContain(`you are ${HAIKU}`)
  expect(w.models.main).toEqual([HAIKU, HAIKU])
})

test('a prompt without the mark keeps the session model', async ($, on) => {
  const w = world(on)
  await submit($, 'summarize the diff')
  await $.turn.start({ turnId: 't1', text: 'summarize the diff' })
  await step($, 't1')
  expect(w.prompts).toEqual(['summarize the diff'])
  expect(w.contexts).toEqual([undefined])
  expect(w.models.main).toEqual([SESSION])
})

test('a dunder or a lone _ is no mark', async ($, on) => {
  const w = world(on)
  await submit($, '__init__.py fails to import')
  await $.turn.start({ turnId: 't1', text: '__init__.py fails to import' })
  await step($, 't1')
  await complete($, 't1', SESSION)
  await submit($, '_')
  await $.turn.start({ turnId: 't2', text: '_' })
  await step($, 't2')
  expect(w.prompts).toEqual(['__init__.py fails to import', '_'])
  expect(w.models.main).toEqual([SESSION, SESSION])
})

test('the next turn goes back to the session model once a Haiku turn ends', async ($, on) => {
  const w = world(on)
  await submit($, '_quick question')
  await $.turn.start({ turnId: 't1', text: 'quick question' })
  await complete($, 't1')
  await submit($, 'longer question')
  await $.turn.start({ turnId: 't2', text: 'longer question' })
  await step($, 't2')
  expect(w.models.main).toEqual([SESSION])
})

test('a subagent the Haiku turn starts runs on Haiku, and its end does not end the turn', async ($, on) => {
  const w = world(on)
  await submit($, '_find the bug')
  await $.turn.start({ turnId: 't1', text: 'find the bug' })
  await step($, 't1', 0)
  const spawned = await spawn($, 'a1')
  await step($, 'a1-run', 0, 'a1')
  await complete($, 'a1-run', HAIKU, 'a1')
  await step($, 't1', 1)
  expect(spawned.model).toBe(HAIKU)
  expect(w.models.a1).toEqual([HAIKU])
  expect(w.models.main).toEqual([HAIKU, HAIKU])
})

test('a subagent of a turn on the session model keeps its own model', async ($, on) => {
  const w = world(on)
  await submit($, 'find the bug')
  await $.turn.start({ turnId: 't1', text: 'find the bug' })
  const spawned = await spawn($, 'a1')
  await step($, 'a1-run', 0, 'a1')
  expect(spawned.model).toBe(SESSION)
  expect(w.models.a1).toEqual([SESSION])
})

test('a _ prompt typed mid-turn leaves the running turn alone and says it is not on Haiku', async ($, on) => {
  const w = world(on)
  await submit($, 'refactor the parser')
  await $.turn.start({ turnId: 't1', text: 'refactor the parser' })
  await step($, 't1', 0)
  await submit($, '_and add a test', 't1')
  await step($, 't1', 1)
  await complete($, 't1', SESSION)
  await $.turn.start({ turnId: 't2', text: 'and add a test' })
  await step($, 't2')
  expect(w.prompts).toEqual(['refactor the parser', 'and add a test'])
  expect(w.models.main).toEqual([SESSION, SESSION, SESSION])
  expect(w.toasts.length).toBe(1)
})

test('the end of a Haiku turn says which model answered', async ($, on) => {
  world(on)
  await startSession($)
  await submit($, '_quick question')
  await $.turn.start({ turnId: 't1', text: 'quick question' })
  expect((await complete($, 't1', HAIKU)).text).toContain(`Answered by ${HAIKU}`)

  await submit($, '_another one')
  await $.turn.start({ turnId: 't2', text: 'another one' })
  expect((await complete($, 't2', SESSION)).text).toContain(`but ${SESSION} answered`)

  await submit($, 'plain question')
  await $.turn.start({ turnId: 't3', text: 'plain question' })
  expect((await complete($, 't3', SESSION)).text).toBe('done')
})

test('the spinner says Haiku while a Haiku turn runs, and only then', async ($, on) => {
  world(on)
  await submit($, '_quick question')
  await $.turn.start({ turnId: 't1', text: 'quick question' })
  expect(await (await spinner($)).find({ type: 'Text', text: 'Sauteing on Haiku' })).toBeDefined()
  expect(await (await spinner($, '')).find({ type: 'Text', text: 'Haiku' })).toBeDefined()

  await complete($, 't1')
  expect(await (await spinner($)).find({ type: 'Text', text: 'on Haiku' })).toBeUndefined()
})

// prompt.edit, which marks the draft, is raised by the composer alone: a test cannot type.
test('a draft nobody marked leaves the hint line alone', async ($, on) => {
  world(on)
  const ui = await hint($)
  expect(await ui.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Haiku' })).toBeUndefined()
})
