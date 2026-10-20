#!/usr/bin/env node
// Checks the real model against a set of cases, with the same prompt and reply parsing the
// mod uses (the mod asks through $.model.complete; this script through `claude -p`).
// Costs a few cents of your Claude usage and needs the `claude` CLI logged in: `npm run eval`.
import { spawn } from 'node:child_process'
import { createModelResolver, resolveSmart } from '../src/smart/resolve.js'

const MODEL = process.env.AFTER_MODEL || 'haiku'

/** One completion through the user's own CLI, with no tools, settings, hooks or session. */
function complete ({ system, prompt }) {
  const args = [
    '-p',
    '--model', MODEL,
    '--output-format', 'json',
    '--system-prompt', system,
    '--tools', '',
    '--no-session-persistence',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--settings', JSON.stringify({ disableAllHooks: true, alwaysThinkingEnabled: false })
  ]
  return new Promise((resolve) => {
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      try {
        const envelope = JSON.parse(stdout)
        resolve(code === 0 && !envelope.is_error ? envelope.result : null)
      } catch {
        resolve(null)
      }
    })
    child.stdin.end(prompt)
  })
}

const queue = (...texts) => texts.map((text, i) => ({ id: i + 1, text }))
const Q = queue('add tests for the parser', 'update the README', 'deploy to staging')
const ES = queue('ejecuta los tests y dime si todo funciona ok', 'de que va el proyecto?')
const isTask = (ops, text, kind, id) => ops.length === 1 && ops[0].type === 'add' && ops[0].text === text &&
  ops[0].where.kind === kind && ops[0].where.id === id

// [command, text, items, started, expected (a function of the resolved ops)]
const CASES = [
  ['after', 'tests, write a README explaining them', Q, [], ops => ops[0]?.type === 'add' && ops[0].where.kind === 'after' && ops[0].where.id === 1 && !/^tests/i.test(ops[0].text)],
  ['after', 'tests do a new README explaining it', Q, [], ops => ops[0]?.where?.kind === 'after' && ops[0].where.id === 1],
  ['before', 'deploy bump the version', Q, [], ops => ops[0]?.type === 'add' && ops[0].where.kind === 'before' && ops[0].where.id === 3],
  ['after', 'remove adding tests', Q, [], ops => ops[0]?.type === 'remove' && ops[0].ids.join() === '1'],
  ['after', 'remove the readme one', Q, [], ops => ops[0]?.type === 'remove' && ops[0].ids.join() === '2'],
  ['after', 'quita lo del deploy', Q, [], ops => ops[0]?.type === 'remove' && ops[0].ids.join() === '3'],
  ['after', 'drop the second one', Q, [], ops => ops[0]?.type === 'remove' && ops[0].ids.join() === '2'],
  ['after', 'move the deploy first', Q, [], ops => ops[0]?.type === 'move' && ops[0].id === 3 && ops[0].where.kind === 'start'],
  ['after', 'change the readme one to update the README and the CHANGELOG', Q, [], ops => ops[0]?.type === 'edit' && ops[0].id === 2 && /CHANGELOG/.test(ops[0].text)],
  ['after', 'remove the unused dependencies', Q, [], ops => ops[0]?.type === 'add' && ops[0].text === 'remove the unused dependencies'],
  ['after', 'write more tests for the lexer', Q, [], ops => ops[0]?.type === 'add' && ops[0].where.kind === 'end'],
  // The words pointing at the anchor never end up in the task, comma or not
  ['before', 'decirme de que va el proyecto ejecuta otra vez los tests', ES, [], ops => isTask(ops, 'ejecuta otra vez los tests', 'before', 2)],
  ['before', 'decirme de que va el proyecto, ejecuta otra vez los tests', ES, [], ops => isTask(ops, 'ejecuta otra vez los tests', 'before', 2)],
  ['after', 'antes de decirme de que va el proyecto ejecuta otra vez los tests', ES, [], ops => isTask(ops, 'ejecuta otra vez los tests', 'before', 2)],
  ['after', 'cuando acabes los tests revisa el README', ES, [], ops => isTask(ops, 'revisa el README', 'after', 1)],
  ['after', 'remove the tests', queue('update the README'), [{ id: 9, text: 'add tests for the parser', status: 'running' }], ops => ops.length === 0]
]

const resolver = createModelResolver(complete)
let passed = 0
for (const [command, text, items, started, check] of CASES) {
  const startedAt = Date.now()
  const result = await resolveSmart({ command, text, items, started, resolver })
  const ok = check(result.ops)
  if (ok) passed++
  console.log(`${ok ? '✓' : '✗'} /${command} ${text}  (${Date.now() - startedAt}ms, ${result.via ?? 'plain'})${ok ? '' : `\n    ${JSON.stringify(result)}`}`)
}
console.log(`\n${passed}/${CASES.length} passed`)
process.exitCode = passed === CASES.length ? 0 : 1
