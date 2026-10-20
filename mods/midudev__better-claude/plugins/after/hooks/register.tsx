// After as a Claude Code mod: one hooks module, no subprocesses.
//
// - /after and /before are slash commands of the mod. They run at once, even mid-turn, and
//   answer with a card drawn in the transcript. The model only reads a reference to the
//   card, and the command's record is scrubbed, so queued tasks never reach Claude before
//   their turn (no steering).
// - Bare /after opens the queue in a pane to pick, edit, reorder and remove tasks.
// - When a turn ends, the next task is handed to Claude with $.prompt.submit.
// - The queue lives in $.state (the band and the pane redraw from it) and in $.store (so a
//   resumed session finds it).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, EventOf, Register, RenderElement } from 'claude-code'

import { applyIntent, applyOps } from '../src/commands/apply.js'
import { executeCommand } from '../src/commands/execute.js'
import { parsePrompt } from '../src/commands/parse.js'
import { canStart, createState, giveBack, markIdle, normalizeState, takeNext } from '../src/core/queue.js'
import { createModelResolver } from '../src/smart/resolve.js'
import { buildCard } from '../src/ui/card.js'
import type { Card, Row } from '../src/ui/card.js'
import { plural, shorten } from '../src/ui/format.js'
import { describeStatus, renderMessage } from '../src/ui/render.js'
import type { AfterDraft, AfterNote, AfterQueue, AfterTask } from '../types'

type Engine = EngineInterface
type Command = 'after' | 'before'
type RenderOf<C extends string> = Extract<EventOf['ui.render'], { component: C }>
type Next<C extends string> = (e: RenderOf<C>) => Promise<RenderElement>
type Outcome = Omit<ReturnType<typeof applyOps>, 'state'> & { state: AfterQueue }
type Op =
  | { type: 'add'; text: string; where: object }
  | { type: 'remove'; ids: number[] }
  | { type: 'move'; id: number; where: object }
  | { type: 'edit'; id: number; text: string }
  | { type: 'clear' }

const PANE = 'after'
const STORE_PREFIX = 'queue:'
const STORE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const CARD_PREFIX = 'card:'
const CARD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const MODEL_TIMEOUT_MS = 25_000

const QUEUE_REF = { plugin: 'after', key: 'queue' } as const
const NOTE_REF = { plugin: 'after', key: 'note' } as const
const DRAFT_REF = { plugin: 'after', key: 'draft' } as const
const PANE_OPEN_REF = { plugin: 'after', key: 'paneOpen' } as const
const SELECTED_REF = { plugin: 'after', key: 'selected' } as const
const QUEUE = atom(QUEUE_REF, null)
const NOTE = atom(NOTE_REF, null)
const DRAFT = atom(DRAFT_REF, { text: '', editId: null })
const PANE_OPEN = atom(PANE_OPEN_REF, false)
const SELECTED = atom(SELECTED_REF, null)

const EMPTY_DRAFT: AfterDraft = { text: '', editId: null }
const STATUS_COLOR: Record<string, string | undefined> = { green: 'green', yellow: 'yellow', red: 'red', cyan: 'cyan', dim: undefined }
const NOTE_COLOR: Record<AfterNote['kind'], string | undefined> = { ok: 'green', info: undefined, error: 'red' }
const TONE_COLOR: Record<Card['tone'], string | undefined> = { ok: 'green', info: undefined, error: 'red', paused: 'yellow' }
const CHANGE_COLOR: Record<string, string> = { new: 'green', starting: 'green', moved: 'yellow', edited: 'cyan', removed: 'red' }
const PANE_TAG: Record<string, string> = { new: '← new', moved: '← moved', edited: '← edited' }
// The row a slash command leaves in the transcript, which the model reads on its next request
const COMMAND_RECORD = /<command-name>\/(?:after:)?(?:after|before)<\/command-name>/
const COMMAND_ARGS = /<command-args>[\s\S]*?<\/command-args>/
// What a command answers: a reference to the card it drew ("#lq2x9k-3")
const CARD_REF = /#([0-9a-z]+-[0-9a-z]+)\s*$/

// The queue as this module last wrote it. $.state publishes it to the drawings and survives a
// hot reload; $.store keeps it across restarts. Every write goes through `exclusive`.
let current: AfterQueue | null = null
let chain: Promise<unknown> = Promise.resolve()
// A /clear starts a new conversation (and session id) in the same process: the queue stays
let carryOver = false
// Plain-language commands waiting for the model. A turn that ends meanwhile waits for them,
// so "/after remove the readme one" typed mid-turn lands before the queue moves on.
let resolving = 0
let kickPending = false
let settings = { smart: true, model: 'haiku', display: 'band' }
// The cards drawn in the transcript, by reference; $.store keeps them for a resumed session
const cards = new Map<string, Card | null>()
let cardCount = 0

export const register: Register = (on, options) => {
  settings = {
    smart: options.smart !== false,
    model: String(options.model || 'haiku'),
    display: String(options.display || 'band')
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'after',
      description: 'Queue a task to run after the current one, without steering it · no task: edit the queue',
      argumentHint: '[task] | rm <n> | mv <n> <m> | edit <n> <text> | pause | resume | undo | clear | list | help',
      immediate: true
    })
    await $.command.register({
      name: 'before',
      description: 'Queue a task at the front so it runs next',
      argumentHint: '[task] | #<n> <task> to insert before #n',
      immediate: true
    })
    await exclusive(() => load($))
    await prune($)
    await warnAboutShims($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') carryOver = true
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await commit($, state => ({ state: state.busy ? state : { ...state, busy: true } }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await finishTurn($, e.reason === 'answer')
    return result
  })

  on('command.run', { command: 'after' }, ($, e) => slashCommand($, 'after', e.args))
  on('command.run', { command: 'before' }, ($, e) => slashCommand($, 'before', e.args))

  // The command's record would show Claude what was queued before its turn: keep the
  // command, drop its arguments
  on('session.append', { door: 'command' }, ($, e, next) => {
    const isAfter = e.message.content.some(block => typeof block.text === 'string' && COMMAND_RECORD.test(block.text))
    if (!isAfter) return next(e)
    const content = e.message.content.map(block => typeof block.text === 'string'
      ? { ...block, text: block.text.replace(COMMAND_ARGS, '<command-args></command-args>') }
      : block)
    return next({ ...e, message: { ...e.message, content } })
  })

  on('ui.render', { component: 'CommandOutput' }, ($, e, next) => drawCommandOutput($, e, next))
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => drawBand($, e, next))
  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => drawPane($, e))
  // The pane's selection follows its focus ring: the arrows, Tab or a click on a task
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const id = e.element?.startsWith('row-') ? Number(e.element.slice(4)) : null
    if (id !== null && Number.isInteger(id)) await $.state.set(SELECTED_REF, id)
    return next(e)
  })
  on('ui.close', { id: PANE }, async ($, e, next) => {
    await $.state.set(PANE_OPEN_REF, false)
    await $.state.set(DRAFT_REF, EMPTY_DRAFT)
    return next(e)
  })
}

// ── The queue ──────────────────────────────────────────────────────────────────

function exclusive<T> (work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work)
  chain = run.catch(() => {})
  return run
}

const storeKey = (sessionId: string | null) => `${STORE_PREFIX}${sessionId}`

/** The queue of the session running now. Call inside `exclusive`. */
async function load ($: Engine): Promise<AfterQueue> {
  const sessionId = await $.session.id()
  if (current?.sessionId === sessionId) return current
  if (current && carryOver) {
    carryOver = false
    await $.store.delete(storeKey(current.sessionId))
    return publish($, { ...current, sessionId })
  }
  const held = await read($, QUEUE)
  if (held?.sessionId === sessionId) return (current = held)

  const now = await $.clock.now()
  const stored = await $.store.get(storeKey(sessionId))
  // A queue from a previous run of this session: Claude is not working on anything now
  const state = stored
    ? markIdle(normalizeState(stored, { sessionId }), { now, status: 'stopped' })
    : createState({ sessionId, cwd: await $.session.cwd(), now })
  return publish($, state as AfterQueue)
}

async function publish ($: Engine, state: AfterQueue): Promise<AfterQueue> {
  current = state
  await $.state.set(QUEUE_REF, state)
  await $.store.set(storeKey(state.sessionId), state)
  if (settings.display === 'status') $.ui.status(statusLine(state))
  return state
}

/** Applies `apply(state, now)` and saves the state it returns. */
function commit<T extends { state: AfterQueue }> ($: Engine, apply: (state: AfterQueue, now: number) => T): Promise<T> {
  return exclusive(async () => {
    const state = await load($)
    const now = await $.clock.now()
    const outcome = apply(state, now)
    if (outcome.state === state) return outcome
    return { ...outcome, state: await publish($, { ...outcome.state, updatedAt: now }) }
  })
}

async function prune ($: Engine) {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (key.startsWith(CARD_PREFIX)) {
      // A card's reference starts with the time it was drawn
      const drawnAt = Number.parseInt(key.slice(CARD_PREFIX.length).split('-')[0] ?? '', 36)
      if (!(now - drawnAt <= CARD_MAX_AGE_MS)) await $.store.delete(key)
      continue
    }
    if (!key.startsWith(STORE_PREFIX)) continue
    const state = (await $.store.get(key)) as Partial<AfterQueue> | undefined
    const isEmpty = !state?.items?.length && !state?.running
    if (isEmpty && now - (state?.updatedAt ?? 0) > STORE_MAX_AGE_MS) await $.store.delete(key)
  }
}

/** After 0.1 put /after and /before in ~/.claude/commands; a file there would shadow the mod. */
async function warnAboutShims ($: Engine) {
  const shadowing = (await $.command.list())
    .filter(command => command.source === 'user' && (command.name === 'after' || command.name === 'before'))
  if (shadowing.length === 0) return
  const files = shadowing.map(command => `${command.name}.md`).join(' and ')
  $.ui.log(`After: delete ${files} from ~/.claude/commands (left by After 0.1) so /after reaches the mod`)
}

// ── Running tasks ──────────────────────────────────────────────────────────────

async function finishTurn ($: Engine, isAnswered: boolean) {
  // Esc, a refusal or an API error stop the queue until the next turn ends normally
  const { state, finished } = await commit($, (state, now) => ({
    state: markIdle(state, { now, status: isAnswered ? 'done' : 'stopped' }) as AfterQueue,
    finished: state.running
  }))
  if (!isAnswered) return
  if (finished && state.items.length === 0 && settings.display !== 'none') $.ui.toast('After · all queued tasks done')
  startNext($)
}

/** Hands the next task to Claude if it is idle and the queue may run. */
function startNext ($: Engine) {
  if (resolving > 0) {
    kickPending = true
    return
  }
  kickPending = false
  void commit($, (state, now) => canStart(state) ? takeNext(state, now) : { state, item: null })
    .then(({ item }: { item: AfterTask | null }) => item && submit($, item))
    .catch(error => debug($, error))
}

/** Work nobody awaits reports its failures to the debug log (claude --debug). */
function debug ($: Engine, error: unknown) {
  try {
    $.ui.log(`After: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  } catch {}
}

async function submit ($: Engine, item: AfterTask) {
  // The user typed it with /after, so Claude reads it as their message, bare
  let reason: string | undefined
  try {
    reason = (await $.prompt.submit({ text: item.text, asUser: true })).drop
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error)
  }
  if (reason === undefined) return
  await commit($, state => ({ state: giveBack(state, item.id) as AfterQueue }))
  $.ui.log(`✗ After could not start “${shorten(item.text, 48)}”: ${reason}\n  The queue is paused · /after resume to try again`)
}

// ── Commands ───────────────────────────────────────────────────────────────────

async function track<T> (work: () => Promise<T>): Promise<T> {
  resolving++
  try {
    return await work()
  } finally {
    resolving--
  }
}

function resolverFor ($: Engine) {
  if (!settings.smart) return null
  return createModelResolver(async ({ system, prompt }: { system: string; prompt: string }) => {
    const reply = await $.model.complete({ model: settings.model, system, prompt, maxTokens: 1024, effort: 'low', timeoutMs: MODEL_TIMEOUT_MS })
    return reply.isAnswered ? reply.text : null
  })
}

async function slashCommand ($: Engine, command: Command, args: string) {
  let card: Card
  try {
    const outcome = await runCommand($, command, args)
    if (outcome.view === 'watch') {
      if (outcome.kick || kickPending) startNext($)
      // The pane is the answer: nothing to print
      return {}
    }
    card = buildCard(outcome, { idle: !outcome.state.busy })
    if (outcome.kick || kickPending) startNext($)
  } catch (error) {
    card = { tone: 'error', icon: '✗', title: `After could not handle that: ${error instanceof Error ? error.message : String(error)}`, rows: [] }
  }
  // The row the transcript keeps, and the model reads on its next request: only a
  // reference to the card, never the queue
  return { text: `#${await keepCard($, card)}` }
}

async function keepCard ($: Engine, card: Card): Promise<string> {
  const ref = `${(await $.clock.now()).toString(36)}-${(++cardCount).toString(36)}`
  cards.set(ref, card)
  await $.store.set(`${CARD_PREFIX}${ref}`, card).catch(error => debug($, error))
  return ref
}

async function findCard ($: Engine, text: string): Promise<Card | null | undefined> {
  const ref = CARD_REF.exec(text)?.[1]
  if (!ref) return undefined
  if (!cards.has(ref)) cards.set(ref, ((await $.store.get(`${CARD_PREFIX}${ref}`)) as Card | undefined) ?? null)
  return cards.get(ref)
}

/** One /after or /before command, from the prompt or from the pane's input. */
async function runCommand ($: Engine, command: Command, args: string): Promise<Outcome> {
  const queue = {
    read: () => exclusive(() => load($)),
    commit: (apply: (state: AfterQueue, now: number) => Outcome) => commit($, apply)
  }
  const outcome: Outcome = await executeCommand({ queue, command, args, resolver: resolverFor($), track })
  await remember($, outcome)
  if (outcome.view === 'watch') await openPane($)
  return outcome
}

/** Concrete, id-based operations from the pane's buttons. */
async function runOps ($: Engine, ops: Op[]) {
  const outcome: Outcome = await commit($, (state, now) => applyOps(state, ops, { now }))
  await remember($, outcome)
  if (outcome.kick) startNext($)
}

async function runIntent ($: Engine, type: 'pause' | 'resume' | 'undo') {
  const outcome: Outcome = await commit($, (state, now) => applyIntent(state, { type }, { now }))
  await remember($, outcome)
  if (outcome.kick) startNext($)
}

async function remember ($: Engine, outcome: Outcome) {
  const note: AfterNote | null = outcome.message
    ? { ...outcome.message, via: outcome.via, note: outcome.note, marks: outcome.marks }
    : null
  await $.state.set(NOTE_REF, note)
}

// ── The card ───────────────────────────────────────────────────────────────────

/**
 * What /after and /before answered, drawn as a card in place of the reference the
 * transcript keeps:
 *
 *   ╭─ After ──────────────────────────── ✦ Haiku ─╮
 *   │ ✓ Queued #1 · right before #2                │
 *   │                                              │
 *   │   ▶  run the tests                           │
 *   │ + 1  run the tests again            ← new    │
 *   │   2  what is this project about?             │
 *   ╰──────────────────────────────────────────────╯
 */
async function drawCommandOutput ($: Engine, e: RenderOf<'CommandOutput'>, next: Next<'CommandOutput'>) {
  if (!/^(?:after:)?(?:after|before)$/.test(e.props.command)) return next(e)
  const card = await findCard($, e.props.text)
  if (card === undefined) return next(e)
  const { Box, Text } = $.ui.resolve(e)
  if (card === null) return <Text dimColor>After · this card is no longer available</Text>

  const width = Math.max(1, ...card.rows.map(row => row.label.length))
  const badge = card.badge === 'haiku'
    ? <Text color="magenta">{' ✦ Haiku '}</Text>
    : card.badge === 'local' ? <Text dimColor>{' ✦ matched locally '}</Text> : null

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor={card.tone === 'error' ? 'red' : undefined}
        borderDimColor={card.tone !== 'error'} paddingX={1} minWidth={44}>
        <Text wrap="truncate-end">
          <Text color={TONE_COLOR[card.tone]} dimColor={card.tone === 'info'} bold>{card.icon}</Text>
          <Text bold={card.tone !== 'info'}>{` ${card.title}`}</Text>
          {card.detail ? <Text dimColor>{` · ${card.detail}`}</Text> : null}
        </Text>
        {card.rows.length > 0 && <Text> </Text>}
        {card.rows.map(row => drawRow(Box, Text, row, width, Boolean(card.focus)))}
        {(card.sections ?? []).map((section, i) => {
          const column = Math.max(...section.lines.map(([command]) => command.length))
          return (
            <Box key={`s${i}`} flexDirection="column" marginTop={1}>
              {section.heading && <Text bold>{section.heading}</Text>}
              {section.lines.map(([command, description]) => (
                <Text key={command} wrap="truncate-end">
                  <Text color="cyan">{`  ${command.padEnd(column)}`}</Text>
                  <Text dimColor>{`  ${description}`}</Text>
                </Text>
              ))}
            </Box>
          )
        })}
        {card.hint && <Box marginTop={1}><Text dimColor wrap="truncate-end">{card.hint}</Text></Box>}
      </Box>
      <Box position="absolute" top={0} left={2}><Text bold>{' After '}</Text></Box>
      {badge && <Box position="absolute" top={0} right={2}>{badge}</Box>}
    </Box>
  )
}

type Elements = ReturnType<Engine['ui']['resolve']>

function drawRow (Box: Elements['Box'], Text: Elements['Text'], row: Row, width: number, focus: boolean) {
  const color = row.change ? CHANGE_COLOR[row.change] : undefined
  const labelColor = color ?? (row.kind === 'running' ? 'green' : row.kind === 'item' && !focus ? 'cyan' : undefined)
  const isDim = row.kind === 'done' || row.kind === 'stopped' || row.kind === 'more' || row.kind === 'removed' ||
    (focus && !row.change && row.kind === 'item')
  return (
    <Box key={row.key} flexDirection="row" justifyContent="space-between" gap={2}>
      <Text wrap="truncate-end">
        <Text color={color}>{`${row.marker ?? ' '} `}</Text>
        <Text color={labelColor} dimColor={isDim && !color} bold={Boolean(row.change)}>{row.label.padStart(width)}</Text>
        <Text dimColor={isDim} bold={Boolean(row.change) && row.change !== 'removed'} strikethrough={row.kind === 'removed'}>
          {`  ${row.text}`}
        </Text>
      </Text>
      {row.tag ? <Text color={color} dimColor={!color}>{row.tag}</Text> : null}
    </Box>
  )
}

// ── The band and the pane ──────────────────────────────────────────────────────

async function openPane ($: Engine) {
  await $.state.set(PANE_OPEN_REF, true)
  await $.ui.open({ id: PANE, title: 'After', focus: true, closeOnEscape: true })
}

function statusLine (state: AfterQueue): string | undefined {
  if (state.items.length === 0 && !state.running) return undefined
  const count = state.items.length ? `${plural(state.items.length, 'task')} queued` : 'last queued task running'
  return `After · ${count}${state.paused ? ' · paused' : ''}`
}

/**
 * The band above the prompt, one line: a tag in the queue's colour, what the spinner above
 * does not already say, and what comes next.
 *
 *    after  1 review the README  2 update the changelog  +1 more              ✎ edit
 *    after  ▶ review the README  then  1 update the changelog                 ✎ edit
 */
async function drawBand ($: Engine, e: RenderOf<'AbovePrompt'>, next: Next<'AbovePrompt'>) {
  if (settings.display !== 'band' || e.props.hasSurvey) return next(e)
  const state = await read($, QUEUE)
  if (!state || (state.items.length === 0 && !state.running) || (await read($, PANE_OPEN))) return next(e)

  const { Box, Button, Text } = $.ui.resolve(e)
  const width = Math.max(32, e.props.bodyColumns)
  const tagColor = state.paused ? 'yellow' : state.running ? 'green' : state.busy ? 'cyan' : undefined
  const lead = state.paused
    ? { color: 'yellow', text: 'paused' }
    : state.running
      ? { color: 'green', text: `▶ ${shorten(state.running.text, Math.max(12, Math.floor(width * 0.3)))}` }
      : state.busy ? null : { color: undefined, text: 'idle · /after resume' }
  const count = Math.min(3, state.items.length, Math.max(1, Math.floor((width - 40) / 18)))
  const more = state.items.length > count ? `+${state.items.length - count} more` : ''
  // The tag, the edit button, the gaps, then what the lead and "+n more" take
  const room = width - 18 - (lead ? lead.text.length + 8 : 0) - (more ? more.length + 2 : 0)
  const each = Math.max(8, Math.floor(room / Math.max(1, count)) - 4)

  return (
    <Box flexDirection="row" justifyContent="space-between" width={width}>
      <Box flexDirection="row" columnGap={2} flexShrink={1}>
        <Text key="tag" color={tagColor} inverse bold>{' after '}</Text>
        {lead && <Text key="lead" color={lead.color} dimColor={!lead.color} wrap="truncate-end">{lead.text}</Text>}
        {state.items.length === 0 && <Text dimColor>nothing else queued</Text>}
        {state.running && !state.paused && state.items.length > 0 && <Text dimColor>then</Text>}
        {state.items.slice(0, count).map((item, i) => (
          <Text key={`next-${item.id}`} wrap="truncate-end">
            <Text color="cyan" bold>{`${i + 1} `}</Text>
            <Text>{shorten(item.text, each)}</Text>
          </Text>
        ))}
        {more && <Text dimColor>{more}</Text>}
      </Box>
      <Button key="view" label="✎ edit" plain dimColor onPress={() => openPane($)} />
    </Box>
  )
}

/**
 * The queue to work on, what bare /after opens: the arrows pick a task, Enter or e edits it,
 * d removes it, k and j move it; the input queues a task or runs any /after command.
 */
async function drawPane ($: Engine, e: RenderOf<'Pane'>) {
  const elements = $.ui.resolve(e)
  const { Box, Button, Text } = elements
  const Input = 'Input' in elements ? elements.Input : undefined
  const state = (await read($, QUEUE)) ?? (createState({}) as AfterQueue)
  const note = await read($, NOTE)
  const draft = await read($, DRAFT)
  const selectedId = await read($, SELECTED)
  const status = describeStatus(state)
  const editing = draft.editId === null ? -1 : state.items.findIndex(item => item.id === draft.editId)
  const selected = state.items.find(item => item.id === selectedId) ?? state.items[0] ?? null
  const digits = String(state.items.length).length
  // "❯ 12 " before a task, its tag after it
  const room = (tag?: string) => Math.max(12, e.props.bodyColumns - digits - 3 - (tag ? tag.length + 2 : 0))
  const edit = (id?: number) => Input && editTask($, id)

  return (
    <Box flexDirection="column">
      <Text color={STATUS_COLOR[status.tone]} dimColor={status.tone === 'dim'} wrap="truncate-end">{status.text}</Text>
      <Text> </Text>
      {state.done.slice(0, 2).reverse().map(task => (
        <Text key={`done-${task.id}`} dimColor wrap="truncate-end">
          {`  ${task.status === 'stopped' ? '■' : '✓'} ${' '.repeat(digits - 1)}${shorten(task.text, room())}`}
        </Text>
      ))}
      {state.running && (
        <Text wrap="truncate-end">
          <Text color="green">{`  ▶ ${' '.repeat(digits - 1)}`}</Text>
          <Text>{shorten(state.running.text, room('running'))}</Text>
          <Text color="green" dimColor>{'  running'}</Text>
        </Text>
      )}
      {state.items.length === 0 && <Text dimColor>  Nothing queued · type a task below</Text>}
      {state.items.map((item, i) => {
        const isSelected = item.id === selected?.id
        const isEditing = i === editing
        const mark = note?.marks[String(item.id)]
        const tag = isEditing ? '✎ editing' : mark ? PANE_TAG[mark] : undefined
        const color = isEditing ? 'cyan' : mark ? CHANGE_COLOR[mark] : undefined
        return (
          <Box key={`line-${item.id}`} flexDirection="row">
            <Text color="cyan" bold>{isSelected ? '❯ ' : '  '}</Text>
            <Text color={isSelected ? 'cyan' : undefined} dimColor={!isSelected} bold={isSelected}>
              {`${String(i + 1).padStart(digits)} `}
            </Text>
            <Button key={`row-${item.id}`} label={shorten(item.text, room(tag))} plain
              autoFocus={isSelected && editing < 0 ? true : undefined} onPress={() => edit(item.id)} />
            {tag && <Text color={color}>{`  ${tag}`}</Text>}
          </Box>
        )
      })}
      {Input && (
        <Box marginTop={1}>
          <Input
            key="task"
            label={editing >= 0 ? `✎ #${editing + 1}` : '+'}
            placeholder="a task, or rm 2 · mv 3 1 · remove the tests one"
            value={draft.text}
            submitLabel={editing >= 0 ? 'save' : 'queue'}
            autoFocus={state.items.length === 0 ? true : undefined}
            onSubmit={(value: string) => void submitDraft($, value, draft.editId).catch(error => debug($, error))}
          />
        </Box>
      )}
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
        {selected && Input && <Button key="edit" label="edit" hotkey="e" plain onPress={() => edit()} />}
        {selected && <Button key="delete" label="delete" hotkey="d" plain onPress={() => removeSelected($)} />}
        {selected && <Button key="up" label="up" hotkey="k" plain onPress={() => moveSelected($, -1)} />}
        {selected && <Button key="down" label="down" hotkey="j" plain onPress={() => moveSelected($, 1)} />}
        {Input && <Button key="add" label="add" hotkey="a" plain onPress={() => focusPane($, 'task')} />}
        <Button key="pause" label={state.paused ? 'resume' : 'pause'} hotkey="p" plain
          onPress={() => runIntent($, state.paused ? 'resume' : 'pause')} />
        <Button key="undo" label="undo" hotkey="u" plain onPress={() => runIntent($, 'undo')} />
        {state.items.length > 1 && <Button key="clear" label="clear all" plain dimColor onPress={() => runOps($, [{ type: 'clear' }])} />}
        {editing >= 0 && <Button key="cancel" label="cancel edit" plain dimColor onPress={() => update($, DRAFT, () => EMPTY_DRAFT)} />}
      </Box>
      {note && (
        <Text color={NOTE_COLOR[note.kind]} dimColor={note.kind === 'info'} wrap="truncate-end">
          {renderMessage(note, { via: note.via, note: note.note }).split('\n').slice(0, 2).join(' ')}
        </Text>
      )}
    </Box>
  )
}

/** The task the pane has picked, read when a key acts on it (the drawing may lag). */
async function picked ($: Engine) {
  const state = (await read($, QUEUE)) ?? (createState({}) as AfterQueue)
  const id = await read($, SELECTED)
  const index = Math.max(0, state.items.findIndex(item => item.id === id))
  return { items: state.items, index, item: state.items[index] ?? null }
}

/** Loads a task (the picked one by default) into the input to rewrite it. */
async function editTask ($: Engine, id?: number) {
  const { items, item: current } = await picked($)
  const item = id === undefined ? current : items.find(other => other.id === id)
  if (!item) return
  await $.state.set(SELECTED_REF, item.id)
  await update($, DRAFT, () => ({ text: item.text, editId: item.id }))
  await focusPane($, 'task')
}

async function removeSelected ($: Engine) {
  const { items, index, item } = await picked($)
  if (!item) return
  const neighbour = items[index + 1] ?? items[index - 1] ?? null
  await runOps($, [{ type: 'remove', ids: [item.id] }])
  await $.state.set(SELECTED_REF, neighbour?.id ?? null)
  await focusPane($, neighbour ? `row-${neighbour.id}` : 'task')
}

async function moveSelected ($: Engine, by: -1 | 1) {
  const { items, index, item } = await picked($)
  const to = index + by
  if (!item || to < 0 || to >= items.length) return
  await $.state.set(SELECTED_REF, item.id)
  await runOps($, [{ type: 'move', id: item.id, where: { kind: 'index', index: to } }])
}

/** Moves the pane's focus ring, when the pane holds the keys; otherwise nothing to do. */
async function focusPane ($: Engine, key: string) {
  await $.ui.focus({ requestId: PANE, key }).catch(() => {})
}

/** Enter in the pane's input: save an edit, or run the text as an /after command. */
async function submitDraft ($: Engine, value: string, editId: number | null) {
  const text = value.trim()
  await update($, DRAFT, () => EMPTY_DRAFT)
  if (!text) return
  if (editId !== null) {
    await runOps($, [{ type: 'edit', id: editId, text }])
    return focusPane($, `row-${editId}`)
  }
  const typed = parsePrompt(text)
  const outcome = await runCommand($, (typed?.command ?? 'after') as Command, typed ? typed.args : text)
  if (outcome.kick || kickPending) startNext($)
}
