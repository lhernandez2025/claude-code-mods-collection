// Mod tests, run against the engine itself: `claude plugin test .`
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

/** What sits beneath the mod: the prompts that reach Claude and the effort each request asks for. */
function world (on: On) {
  const prompts: string[] = []
  const efforts: unknown[] = []
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    efforts.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [] } as never
  })
  return { prompts, efforts }
}

const step = async ($: Engine, effort?: 'low' | 'high') => {
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort, messageCount: 1 })) void _
}

test('a prompt that starts with + is sent without the mark and thinks at max effort', async ($, on) => {
  const w = world(on)
  await $.prompt.submit({ text: '+plan the refactor' })
  await step($, 'low')
  expect(w.prompts).toEqual(['plan the refactor'])
  expect(w.efforts).toEqual(['max'])
})

test('a prompt without the mark keeps the session effort', async ($, on) => {
  const w = world(on)
  await $.prompt.submit({ text: 'plan the refactor' })
  await step($, 'low')
  expect(w.efforts).toEqual(['low'])
})

test('a model without an effort setting is left alone', async ($, on) => {
  const w = world(on)
  await $.prompt.submit({ text: '+plan the refactor' })
  await step($)
  expect(w.efforts).toEqual([undefined])
})
